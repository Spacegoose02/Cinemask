import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { excludeFromAutoMonitor, refreshEpisodes } from '../arr/monitor.js';
import { audit } from '../audit/log.js';
import { monitored, monitoredEpisodes } from '../db/schema.js';
import { refreshMediaServers } from '../arr/tracker.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { applyRename, deleteFiles, deleteFolder, listFiles, moveToRoot, renamePreview, scanFolder, titleOnDisk, type DeleteScope } from './service.js';
import { assertRoot } from '../arr/roots.js';
import { MEDIA_KINDS } from '../db/schema.js';
import { autoTrailer } from '../trailers/service.js';
import { deleteDuplicate, findDuplicates } from './duplicates.js';
import { browse, importCandidates, setFolder, titlesWithoutFolder } from './folders.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const num = z.number().int().min(0).max(5000);
const folderPath = z
  .string()
  .min(1)
  .max(4000)
  .refine((p) => !p.includes('\0'), 'Bad path');

/** File management for monitored titles. Manager and above: these change files on disk. */
export async function fileRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const getRow = (id: number) => {
    const r = ctx.db.select().from(monitored).where(eq(monitored.id, id)).get();
    if (!r) throw notFound('Not monitored');
    return r;
  };
  const safely = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  };

  // Two or more copies of one movie or episode on disk, and titles the media servers list twice.
  app.get('/api/duplicates', { config: { access: 'manager' } }, async () => findDuplicates(ctx));

  app.post('/api/duplicates/delete', { config: { access: 'manager' } }, async (req) => {
    const body = parse(z.object({ monitoredId: z.number().int().positive(), path: z.string().min(1).max(4000) }), req.body);
    const row = getRow(body.monitoredId);
    const result = safely(() => deleteDuplicate(ctx, row.id, body.path));
    audit(ctx.db, req, 'files.duplicate_deleted', { target: row.title, details: { path: body.path, freed: result.freed } });
    void refreshMediaServers(ctx);
    return result;
  });

  // Moves a title's folder to another root folder (Movies ↔ Kids Movies), whether or not Cinemask manages it.
  app.post('/api/files/:kind/:tmdbId/move', { config: { access: 'manager' } }, async (req) => {
    const p = parse(z.object({ kind: z.enum(MEDIA_KINDS), tmdbId: z.coerce.number().int().positive() }), req.params);
    const { rootId } = parse(z.object({ rootId: z.string().regex(/^[a-z0-9-]{1,40}$/) }), req.body);
    const row = ctx.db.select().from(monitored).where(and(eq(monitored.kind, p.kind), eq(monitored.tmdbId, p.tmdbId))).get() ?? titleOnDisk(ctx, p.kind, p.tmdbId);
    if (!row) throw notFound('No folder for this title in the media folders');
    const from = row.path;
    const after = safely(() => {
      assertRoot(ctx, p.kind, rootId);
      return moveToRoot(ctx, row, rootId);
    });
    audit(ctx.db, req, 'files.moved', { target: row.title, details: { from, to: after.path, rootId } });
    void refreshMediaServers(ctx);
    return { path: after.path, rootId: after.rootId ?? 'default' };
  });

  // A folder browser for picking a title's folder. Only lists folders inside the root folders.
  app.get('/api/files/browse', { config: { access: 'manager' } }, async (req) => {
    const q = parse(z.object({ kind: z.enum(MEDIA_KINDS), path: folderPath.optional() }), req.query);
    return safely(() => browse(ctx, q.kind, q.path));
  });

  // Points a title at a folder picked by hand, then adopts the files in it.
  app.post('/api/monitored/:id/folder', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ path: folderPath }), req.body);
    let row = getRow(id);
    if (row.kind === 'show') {
      await refreshEpisodes(ctx, row).catch(() => undefined);
      row = getRow(id);
    }
    const from = row.path;
    const result = safely(() => setFolder(ctx, row, body.path));
    audit(ctx.db, req, 'files.folder_set', { target: row.title, details: { from, to: result.folder, found: result.found } });
    if (result.found) void autoTrailer(ctx, getRow(id)).catch(() => undefined);
    return result;
  });

  // Library Import: folders in the root folders that no title uses yet, with a suggested title each.
  app.get('/api/files/library-import', { config: { access: 'manager' } }, async (req) => {
    const { kind } = parse(z.object({ kind: z.enum(MEDIA_KINDS) }), req.query);
    return { folders: importCandidates(ctx, kind), titles: titlesWithoutFolder(ctx, kind) };
  });

  app.post('/api/files/library-import', { config: { access: 'manager' } }, async (req) => {
    const body = parse(z.object({ items: z.array(z.object({ folder: folderPath, monitoredId: z.number().int().positive() })).min(1).max(1000) }), req.body);
    const results: { monitoredId: number; folder: string; found: number; error?: string }[] = [];
    for (const item of body.items) {
      let row = ctx.db.select().from(monitored).where(eq(monitored.id, item.monitoredId)).get();
      if (!row) {
        results.push({ ...item, found: 0, error: 'Not monitored' });
        continue;
      }
      if (row.kind === 'show') {
        await refreshEpisodes(ctx, row).catch(() => undefined);
        row = getRow(row.id);
      }
      try {
        results.push({ ...item, found: setFolder(ctx, row, item.folder).found });
      } catch (err) {
        results.push({ ...item, found: 0, error: (err as Error).message });
      }
    }
    const ok = results.filter((r) => !r.error);
    const files = ok.reduce((n, r) => n + r.found, 0);
    audit(ctx.db, req, 'files.library_import', { details: { mapped: ok.length, failed: results.length - ok.length, files } });
    return { mapped: ok.length, files, results };
  });

  app.get('/api/monitored/:id/files', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    return listFiles(ctx, getRow(id));
  });

  app.post('/api/monitored/:id/scan', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    let row = getRow(id);
    // Pick up episodes TMDB added since the last sync first, so their files are matched too.
    if (row.kind === 'show') {
      await refreshEpisodes(ctx, row).catch(() => undefined);
      row = getRow(id);
    }
    const result = safely(() => scanFolder(ctx, row));
    audit(ctx.db, req, 'files.scanned', { target: row.title, details: result });
    // Files just found: fetch a trailer for them when automatic trailers are on.
    if (result.found) void autoTrailer(ctx, getRow(id)).catch(() => undefined);
    return result;
  });

  app.get('/api/monitored/:id/rename', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    return renamePreview(ctx, getRow(id));
  });

  app.post('/api/monitored/:id/rename', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ files: z.array(z.string().max(4000)).max(5000).optional() }), req.body ?? {});
    const row = getRow(id);
    const result = applyRename(ctx, row, body.files);
    audit(ctx.db, req, 'files.renamed', { target: row.title, details: { renamed: result.renamed, errors: result.errors.length } });
    if (result.renamed) void refreshMediaServers(ctx);
    return result;
  });

  app.post('/api/monitored/:id/delete-files', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        scope: z.enum(['movie', 'show', 'season', 'episode']),
        season: num.optional(),
        episode: num.optional(),
        unmonitor: z.boolean().default(false),
      }),
      req.body,
    );
    const row = getRow(id);
    let what: DeleteScope;
    if (body.scope === 'season') {
      if (body.season === undefined) throw badRequest('Pick a season');
      what = { scope: 'season', season: body.season };
    } else if (body.scope === 'episode') {
      if (body.season === undefined || body.episode === undefined) throw badRequest('Pick an episode');
      what = { scope: 'episode', season: body.season, episode: body.episode };
    } else what = { scope: body.scope };
    const result = safely(() => deleteFiles(ctx, row, what, body.unmonitor));
    audit(ctx.db, req, 'files.deleted', { target: row.title, details: { ...body, ...result } });
    if (result.deleted) void refreshMediaServers(ctx);
    return result;
  });

  /** Removes a title from the app, optionally deleting its folder from disk. */
  app.post('/api/monitored/:id/remove', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { deleteFiles: withFiles } = parse(z.object({ deleteFiles: z.boolean().default(false) }), req.body ?? {});
    const row = getRow(id);
    const freed = withFiles ? safely(() => deleteFolder(ctx, row)) : 0;
    ctx.db.delete(monitored).where(eq(monitored.id, id)).run();
    excludeFromAutoMonitor(ctx, row.kind, row.tmdbId);
    audit(ctx.db, req, 'monitored.removed', { target: row.title, details: { deleteFiles: withFiles, freed } });
    if (withFiles) void refreshMediaServers(ctx);
    return { ok: true, freed };
  });

  /** Turns monitoring on or off for one episode or a whole season. */
  app.patch('/api/monitored/:id/episodes', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ season: num, episode: num.optional(), monitored: z.boolean() }), req.body);
    const row = getRow(id);
    if (row.kind !== 'show') throw badRequest('Only shows have episodes');
    const res = ctx.db
      .update(monitoredEpisodes)
      .set({ monitored: body.monitored })
      .where(and(eq(monitoredEpisodes.monitoredId, id), eq(monitoredEpisodes.season, body.season), body.episode !== undefined ? eq(monitoredEpisodes.episode, body.episode) : undefined))
      .run();
    audit(ctx.db, req, 'monitored.episodes', { target: row.title, details: body });
    return { updated: res.changes };
  });
}
