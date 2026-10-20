import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { excludeFromAutoMonitor } from '../arr/monitor.js';
import { audit } from '../audit/log.js';
import { monitored, monitoredEpisodes } from '../db/schema.js';
import { refreshMediaServers } from '../arr/tracker.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { applyRename, deleteFiles, deleteFolder, listFiles, renamePreview, scanFolder, type DeleteScope } from './service.js';
import { autoTrailer } from '../trailers/service.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const num = z.number().int().min(0).max(5000);

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

  app.get('/api/monitored/:id/files', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    return listFiles(ctx, getRow(id));
  });

  app.post('/api/monitored/:id/scan', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const row = getRow(id);
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
