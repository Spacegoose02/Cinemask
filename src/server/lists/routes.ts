import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { listItems, lists, MEDIA_KINDS } from '../db/schema.js';
import { discoverFilter } from '../discover/service.js';
import { availabilityFor } from '../library/service.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { itemsFromCsv, parseListUrl, replaceItems, syncList, type ListItem } from './service.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const settingsShape = {
  name: z.string().trim().min(1).max(200),
  kind: z.enum(MEDIA_KINDS).nullable().default(null),
  autoAdd: z.boolean().default(false),
  profileId: z.number().int().positive().nullable().default(null),
  searchOnAdd: z.boolean().default(true),
  syncHours: z.number().int().min(1).max(24 * 7).default(12),
};
const MAX_CSV = 2 * 1024 * 1024;

/** Annotates list or collection items with whether they're on the server, like every other poster grid. */
export function withAvailability(ctx: FastifyInstance['ctx'], items: ListItem[]) {
  const byKind = { movie: availabilityFor(ctx, 'movie', items.filter((i) => i.kind === 'movie')), show: availabilityFor(ctx, 'show', items.filter((i) => i.kind === 'show')) };
  return items.map((i) => ({ ...i, availability: byKind[i.kind].get(i.tmdbId)! }));
}

export async function listRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const getList = (id: number) => {
    const l = ctx.db.select().from(lists).where(eq(lists.id, id)).get();
    if (!l) throw notFound('List not found');
    return l;
  };
  const view = (l: typeof lists.$inferSelect) => ({ ...l, config: JSON.parse(l.config) as unknown });
  const trySync = async (id: number) => {
    try {
      return { ok: true, ...(await syncList(ctx, id)) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  };

  app.get('/api/lists', { config: { access: 'user' } }, async () => ctx.db.select().from(lists).orderBy(asc(lists.name)).all().map(view));

  app.get('/api/lists/:id/items', { config: { access: 'user' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(1000).default(1000) }), req.query);
    const list = getList(id);
    const items = ctx.db.select().from(listItems).where(eq(listItems.listId, id)).orderBy(asc(listItems.position)).limit(limit).all();
    return { list: view(list), items: withAvailability(ctx, items) };
  });

  /** Adds a list from a pasted mdblist or TMDB URL, or a saved Discover search. */
  app.post('/api/lists', { config: { access: 'manager' } }, async (req) => {
    const body = parse(
      z.object({
        ...settingsShape,
        url: z.string().max(2000).optional(),
        discover: z.object({ filter: discoverFilter, pages: z.number().int().min(1).max(5).default(1) }).optional(),
      }),
      req.body,
    );
    let source: 'mdblist' | 'tmdb_list' | 'tmdb_discover';
    let config: Record<string, unknown>;
    if (body.discover) {
      source = 'tmdb_discover';
      config = body.discover;
    } else {
      const parsed = body.url ? parseListUrl(body.url) : null;
      if (!parsed || parsed.source === 'csv') throw badRequest('Paste an mdblist.com or themoviedb.org list link');
      source = parsed.source;
      config = parsed.config;
    }
    const settings = { name: body.name, kind: body.kind, autoAdd: body.autoAdd, profileId: body.profileId, searchOnAdd: body.searchOnAdd, syncHours: body.syncHours };
    const row = ctx.db.insert(lists).values({ ...settings, source, config: JSON.stringify(config), createdBy: req.user!.id, createdAt: Date.now() }).returning().get();
    audit(ctx.db, req, 'list.created', { target: row.name, details: { source } });
    const sync = await trySync(row.id);
    return { ...view(getList(row.id)), sync };
  });

  /** Imports a CSV export (Yamtrack, IMDb, Letterboxd, or any sheet with TMDB ids) as a new list, or into an existing CSV list. */
  app.post('/api/lists/import-csv', { config: { access: 'manager' }, bodyLimit: MAX_CSV }, async (req) => {
    const q = parse(z.object({ name: z.string().trim().min(1).max(200).optional(), listId: z.coerce.number().int().positive().optional(), kind: z.enum(MEDIA_KINDS).optional() }), req.query);
    if (typeof req.body !== 'string' || !req.body.trim()) throw badRequest('Upload a CSV file');
    let result: Awaited<ReturnType<typeof itemsFromCsv>>;
    try {
      result = await itemsFromCsv(ctx, req.body, q.kind ?? null);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    if (!result.items.length) throw badRequest(`None of the ${result.skipped} rows could be matched to a movie or show`);
    let id = q.listId;
    if (id) {
      if (getList(id).source !== 'csv') throw badRequest('Only CSV lists can be re-imported');
    } else {
      if (!q.name) throw badRequest('Give the list a name');
      id = ctx.db.insert(lists).values({ name: q.name, source: 'csv', config: '{}', kind: q.kind ?? null, createdBy: req.user!.id, createdAt: Date.now() }).returning().get().id;
    }
    replaceItems(ctx, id, result.items);
    ctx.db.update(lists).set({ lastSyncAt: Date.now(), lastError: null }).where(eq(lists.id, id)).run();
    audit(ctx.db, req, 'list.imported', { target: getList(id).name, details: { items: result.items.length, skipped: result.skipped } });
    return { ...view(getList(id)), imported: result.items.length, skipped: result.skipped };
  });

  app.put('/api/lists/:id', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object(settingsShape).partial(), req.body);
    const before = getList(id);
    ctx.db.update(lists).set(body).where(eq(lists.id, id)).run();
    audit(ctx.db, req, 'list.updated', { target: before.name, details: body });
    return view(getList(id));
  });

  app.delete('/api/lists/:id', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const l = getList(id);
    ctx.db.delete(lists).where(eq(lists.id, id)).run();
    audit(ctx.db, req, 'list.deleted', { target: l.name });
    return { ok: true };
  });

  app.post('/api/lists/:id/sync', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const l = getList(id);
    const result = await trySync(id);
    audit(ctx.db, req, 'list.synced', { target: l.name, details: result });
    return result;
  });
}
