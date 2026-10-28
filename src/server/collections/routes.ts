import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { absClient } from '../books/service.js';
import { audit } from '../audit/log.js';
import { assertSafeUrl } from '../arr/direct.js';
import { collectionItems, collections, lists, MEDIA_KINDS, SERVERS } from '../db/schema.js';
import { refreshMetadata, tmdbClient } from '../library/service.js';
import { upstream } from '../library/routes.js';
import { badRequest, HttpError, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { withAvailability } from '../lists/routes.js';
import { postersDir } from '../posters/service.js';
import { bingeBanditClient, clearPlexLabel, downloadMissing, importServerCollections, itemsOf, libraryLabels, jellyfinClient, plexClient, pushCollection, refreshCollectionItems, serverLibraries, setItems } from './service.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const itemRef = z.object({ kind: z.enum(MEDIA_KINDS), tmdbId: z.coerce.number().int().positive() });

/** A poster is a TMDB image path or a public https URL (servers download it, so private addresses are refused). */
export const posterValue = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => /^\/[\w-]+\.(jpe?g|png|webp)$/i.test(v) || v.startsWith('https://'), 'Use a TMDB image or an https link');

const labelValue = z.string().trim().min(1).max(100);
/** The Plex library a collection lives in; null keeps it in every library that has its titles. */
const libraryValue = z.string().trim().min(1).max(200).nullable();

export async function checkPosterUrl(value: string | null | undefined) {
  if (value?.startsWith('https://')) {
    try {
      await assertSafeUrl(value, false);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  }
}

export async function collectionRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const getCol = (id: number) => {
    const c = ctx.db.select().from(collections).where(eq(collections.id, id)).get();
    if (!c) throw notFound('Collection not found');
    return c;
  };
  const failure = (err: unknown) => new HttpError(502, (err as Error).message, 'upstream');

  // Plex collections imported before libraries were recorded get theirs from one quiet re-import.
  let sorting = false;
  const sortUnsorted = () => {
    if (sorting || !ctx.db.select({ id: collections.id }).from(collections).where(and(eq(collections.source, 'plex'), isNull(collections.library))).get()) return;
    sorting = true;
    void importServerCollections(ctx, 'plex', null).catch((err) => app.log.warn({ err }, 'Sorting Plex collections into libraries failed'));
  };

  app.get('/api/collections', { config: { access: 'user' } }, async () => {
    sortUnsorted();
    const counts = new Map(
      ctx.db
        .select({ id: collectionItems.collectionId, n: sql<number>`count(*)` })
        .from(collectionItems)
        .groupBy(collectionItems.collectionId)
        .all()
        .map((r) => [r.id, r.n]),
    );
    return ctx.db
      .select()
      .from(collections)
      .orderBy(asc(collections.name))
      .all()
      .map((c) => ({ ...c, itemCount: counts.get(c.id) ?? 0, previewPosters: itemsOf(ctx, c.id).slice(0, 4).map((i) => i.posterPath) }));
  });

  app.get('/api/library/labels', { config: { access: 'manager' } }, async () => ({ labels: libraryLabels(ctx) }));
  app.get('/api/library/plex-libraries', { config: { access: 'manager' } }, async () => ({ libraries: serverLibraries(ctx) }));

  const checkLibrary = (library: string | null | undefined) => {
    if (library && !serverLibraries(ctx).includes(library)) throw badRequest(`There is no Plex or BingeBandit library called "${library}"`);
  };

  app.get('/api/collections/:id', { config: { access: 'user' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    return { ...getCol(id), items: withAvailability(ctx, itemsOf(ctx, id)) };
  });

  app.post('/api/collections', { config: { access: 'manager' } }, async (req) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(200),
        description: z.string().trim().max(2000).nullable().default(null),
        poster: posterValue.nullable().default(null),
        source: z.enum(['manual', 'tmdb', 'list']).default('manual'),
        sourceId: z.coerce.number().int().positive().optional(),
        syncPlex: z.boolean().default(false),
        syncJellyfin: z.boolean().default(false),
        syncBingebandit: z.boolean().default(false),
        /** A Plex label to put on every item, for smart filters and sharing restrictions. */
        plexLabel: labelValue.nullable().default(null),
        /** Fill the collection from everything carrying this Plex label or Jellyfin tag. */
        fromLabel: labelValue.nullable().default(null),
        library: libraryValue.default(null),
        /** Sync to whichever of Plex, Jellyfin and BingeBandit are connected, and push straight away. */
        toServers: z.boolean().default(false),
        items: z.array(itemRef).max(500).default([]),
      }),
      req.body,
    );
    if (body.toServers) {
      body.syncPlex = ctx.settings.get('plex').enabled;
      body.syncJellyfin = ctx.settings.get('jellyfin').enabled;
      body.syncBingebandit = ctx.settings.get('bingebandit').enabled;
      if (!body.syncPlex && !body.syncJellyfin && !body.syncBingebandit) throw badRequest('Connect a media server first (Settings → Media servers)');
      // The same TMDB series again: push the collection that already exists instead of making a copy.
      const same =
        body.source === 'tmdb' && body.sourceId
          ? ctx.db.select().from(collections).where(and(eq(collections.source, 'tmdb'), eq(collections.sourceId, String(body.sourceId)))).get()
          : undefined;
      if (same) {
        ctx.db
          .update(collections)
          .set({ syncPlex: same.syncPlex || body.syncPlex, syncJellyfin: same.syncJellyfin || body.syncJellyfin, syncBingebandit: same.syncBingebandit || body.syncBingebandit })
          .where(eq(collections.id, same.id))
          .run();
        await pushCollection(ctx, same.id).catch(() => undefined);
        audit(ctx.db, req, 'collection.pushed', { target: same.name });
        return { ...getCol(same.id), items: withAvailability(ctx, itemsOf(ctx, same.id)) };
      }
    }
    await checkPosterUrl(body.poster);
    checkLibrary(body.library);
    if (body.source !== 'manual' && !body.sourceId) throw badRequest('Pick a TMDB collection or list');
    if (body.source === 'list' && !ctx.db.select().from(lists).where(eq(lists.id, body.sourceId!)).get()) throw badRequest('Unknown list');
    const { items, sourceId, toServers, ...values } = body;
    const row = ctx.db
      .insert(collections)
      .values({ ...values, sourceId: sourceId ? String(sourceId) : null, createdBy: req.user!.id, createdAt: Date.now() })
      .returning()
      .get();
    if (body.source === 'manual' && !body.fromLabel) {
      const resolved = [];
      for (const i of items) {
        const m = await upstream(() => refreshMetadata(ctx, i.kind, i.tmdbId));
        if (m) resolved.push({ kind: i.kind, tmdbId: i.tmdbId, title: m.title, year: m.year, posterPath: m.posterPath });
      }
      setItems(ctx, row.id, resolved);
    } else {
      try {
        await refreshCollectionItems(ctx, row.id);
      } catch (err) {
        ctx.db.delete(collections).where(eq(collections.id, row.id)).run();
        throw failure(err);
      }
    }
    audit(ctx.db, req, 'collection.created', { target: row.name, details: { source: body.source } });
    // Errors land in the collection's lastError, which its page shows.
    if (toServers) await pushCollection(ctx, row.id).catch(() => undefined);
    return { ...getCol(row.id), items: withAvailability(ctx, itemsOf(ctx, row.id)) };
  });

  app.put('/api/collections/:id', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(200),
        description: z.string().trim().max(2000).nullable(),
        poster: posterValue.nullable(),
        syncPlex: z.boolean(),
        syncJellyfin: z.boolean(),
        syncBingebandit: z.boolean(),
        plexLabel: labelValue.nullable(),
        fromLabel: labelValue.nullable(),
        library: libraryValue,
      }).partial(),
      req.body,
    );
    await checkPosterUrl(body.poster);
    checkLibrary(body.library);
    const before = getCol(id);
    if (body.fromLabel && before.source !== 'manual') throw badRequest('Only a hand-made collection can follow a label');
    // Moved to another library: the next push finds or makes the collection there.
    const moved = body.library !== undefined && body.library !== before.library;
    ctx.db.update(collections).set({ ...body, ...(moved ? { plexKey: null, bingebanditIds: null } : {}) }).where(eq(collections.id, id)).run();
    if ((body.fromLabel && body.fromLabel !== before.fromLabel) || (moved && before.fromLabel)) await refreshCollectionItems(ctx, id);
    if (before.plexLabel && body.plexLabel !== undefined && body.plexLabel !== before.plexLabel) await clearPlexLabel(ctx, before.plexLabel).catch(() => undefined);
    audit(ctx.db, req, 'collection.updated', { target: before.name, details: body });
    return getCol(id);
  });

  app.delete('/api/collections/:id', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const c = getCol(id);
    ctx.db.delete(collections).where(eq(collections.id, id)).run();
    audit(ctx.db, req, 'collection.deleted', { target: c.name });
    return { ok: true };
  });

  app.post('/api/collections/:id/items', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const item = parse(itemRef, req.body);
    const c = getCol(id);
    if (c.source === 'tmdb' || c.source === 'list' || c.fromLabel) throw badRequest('This collection follows its source; edit the source instead');
    const m = await upstream(() => refreshMetadata(ctx, item.kind, item.tmdbId));
    if (!m) throw badRequest('Could not look up this title');
    const items = itemsOf(ctx, id).filter((i) => !(i.kind === item.kind && i.tmdbId === item.tmdbId));
    setItems(ctx, id, [...items, { kind: item.kind, tmdbId: item.tmdbId, title: m.title, year: m.year, posterPath: m.posterPath }]);
    audit(ctx.db, req, 'collection.item_added', { target: c.name, details: { title: m.title } });
    return { ok: true, count: items.length + 1 };
  });

  app.delete('/api/collections/:id/items/:kind/:tmdbId', { config: { access: 'manager' } }, async (req) => {
    const p = parse(idParam.extend(itemRef.shape), req.params);
    const c = getCol(p.id);
    ctx.db.delete(collectionItems).where(and(eq(collectionItems.collectionId, p.id), eq(collectionItems.kind, p.kind), eq(collectionItems.tmdbId, p.tmdbId))).run();
    audit(ctx.db, req, 'collection.item_removed', { target: c.name, details: { kind: p.kind, tmdbId: p.tmdbId } });
    return { ok: true };
  });

  app.put('/api/collections/:id/order', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { items } = parse(z.object({ items: z.array(itemRef).max(1000) }), req.body);
    getCol(id);
    const current = itemsOf(ctx, id);
    const key = (i: { kind: string; tmdbId: number }) => `${i.kind}:${i.tmdbId}`;
    const byKey = new Map(current.map((i) => [key(i), i]));
    const ordered = items.map((i) => byKey.get(key(i))).filter((i): i is NonNullable<typeof i> => Boolean(i));
    const rest = current.filter((i) => !items.some((x) => key(x) === key(i)));
    setItems(ctx, id, [...ordered, ...rest]);
    return { ok: true };
  });

  app.post('/api/collections/:id/push', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const c = getCol(id);
    if (!c.syncPlex && !c.syncJellyfin && !c.syncBingebandit) throw badRequest('Turn on Plex, Jellyfin or BingeBandit sync for this collection first');
    try {
      const result = await pushCollection(ctx, id);
      audit(ctx.db, req, 'collection.pushed', { target: c.name, details: result });
      return { ...result, lastError: getCol(id).lastError };
    } catch (err) {
      throw failure(err);
    }
  });

  app.post('/api/collections/:id/refresh', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    getCol(id);
    try {
      return { items: await refreshCollectionItems(ctx, id) };
    } catch (err) {
      throw failure(err);
    }
  });

  app.post('/api/collections/:id/download-missing', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const c = getCol(id);
    const added = await upstream(() => downloadMissing(ctx, id, req.user!.id));
    audit(ctx.db, req, 'collection.download_missing', { target: c.name, details: { added } });
    return { added };
  });

  app.post('/api/collections/import', { config: { access: 'manager' } }, async (req) => {
    const { server } = parse(z.object({ server: z.enum(SERVERS) }), req.body);
    try {
      const r = await importServerCollections(ctx, server, req.user!.id);
      audit(ctx.db, req, 'collection.imported', { target: server, details: r });
      return r;
    } catch (err) {
      throw failure(err);
    }
  });

  app.get('/api/collections/search-tmdb', { config: { access: 'manager' } }, async (req) => {
    const { q } = parse(z.object({ q: z.string().trim().min(1).max(200) }), req.query);
    const r = await upstream(() => tmdbClient(ctx).searchCollections(q));
    return r.results.slice(0, 20).map((c) => ({ id: c.id, name: c.name, posterPath: c.poster_path }));
  });

  /**
   * Images that live on Plex/Jellyfin/BingeBandit (collection covers) or were uploaded here. The browser
   * never gets a server token; only image paths of the expected shape are proxied.
   */
  app.get('/api/images', { config: { access: 'user' } }, async (req, reply) => {
    const { src } = parse(z.object({ src: z.string().max(500) }), req.query);
    let img: { type: string; body: Buffer } | null = null;
    try {
      if (/^plex:\/library\/(metadata|collections)\/\d+\/(thumb|composite|art)(\/\d+)?$/.test(src)) img = (await plexClient(ctx)?.image(src.slice(5))) ?? null;
      else if (/^jellyfin:\/Items\/[0-9a-f-]{32,36}\/Images\/Primary$/i.test(src)) img = (await jellyfinClient(ctx)?.image(src.slice(9))) ?? null;
      else if (/^bingebandit:\/api\/images\/(tmdb|local|poster)\/(?!.*\.\.)[\w.-]{1,200}$/.test(src)) img = (await bingeBanditClient(ctx)?.image(src.slice(12))) ?? null;
      else if (/^abs:\/api\/items\/[\w-]{1,64}\/cover$/.test(src)) img = (await absClient(ctx)?.image(src.slice(4))) ?? null;
      else if (/^local:[\w.-]+\.(jpg|png|webp)$/.test(src)) {
        const file = path.join(postersDir(ctx), path.basename(src.slice(6)));
        if (fs.existsSync(file)) img = { type: `image/${path.extname(file).slice(1).replace('jpg', 'jpeg')}`, body: fs.readFileSync(file) };
      } else throw badRequest('Unsupported image');
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw failure(err);
    }
    if (!img || !img.type.startsWith('image/')) throw notFound('Image not found');
    return reply.header('content-type', img.type).header('cache-control', 'private, max-age=86400').header('x-content-type-options', 'nosniff').send(img.body);
  });
}
