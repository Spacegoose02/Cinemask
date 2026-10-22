import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type AnyColumn } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { downloads, libraryItems, matchOverrides, media, MEDIA_KINDS, monitored, type MediaKind } from '../db/schema.js';
import { rootOf } from '../arr/roots.js';
import { bestResolution, IntegrationError } from '../integrations/http.js';
import { HttpError } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { availabilityFor, cards, episodesOnServer, isReleased, mdblistClient, refreshMetadata, tmdbClient, watchInfo, type LibrarySync } from './service.js';

const kindParam = z.enum(MEDIA_KINDS);

/** Case-insensitive "contains", with % and _ in the user's text matched literally. */
export function contains(col: AnyColumn, text: string) {
  return sql`${col} LIKE ${`%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`} ESCAPE '\\'`;
}

/** Integration failures become a 502 with a readable message instead of a generic 500. */
export async function upstream<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof IntegrationError) throw new HttpError(502, err.message, 'upstream');
    throw err;
  }
}

export async function libraryRoutes(app: FastifyInstance, opts: { sync: LibrarySync }) {
  const ctx = app.ctx;

  app.get('/api/library', { config: { access: 'user' } }, async (req) => {
    const q = parse(
      z.object({
        kind: kindParam.optional(),
        q: z.string().trim().max(200).optional(),
        resolution: z.enum(['SD', '720p', '1080p', '2160p']).optional(),
        watched: z.enum(['watched', 'unwatched']).optional(),
        library: z.string().trim().min(1).max(200).optional(),
        unmatched: z.enum(['true', '1']).optional(),
        sort: z.enum(['title', 'year', 'added', 'release', 'rating']).default('added'),
        order: z.enum(['asc', 'desc']).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(60),
      }),
      req.query,
    );
    const where = and(
      q.kind ? eq(libraryItems.kind, q.kind) : undefined,
      q.q ? contains(libraryItems.title, q.q) : undefined,
      q.resolution ? eq(libraryItems.resolution, q.resolution) : undefined,
      q.library ? eq(libraryItems.library, q.library) : undefined,
      q.unmatched ? isNull(libraryItems.tmdbId) : undefined,
    );
    // Watched on any server counts as watched.
    const having = q.watched === 'watched' ? sql`max(coalesce(${libraryItems.viewCount}, 0)) > 0` : q.watched === 'unwatched' ? sql`max(coalesce(${libraryItems.viewCount}, 0)) = 0` : undefined;
    const dir = q.order ?? (q.sort === 'title' ? 'asc' : 'desc');
    const o = dir === 'asc' ? asc : desc;
    const sortCol = {
      title: sql`lower(${libraryItems.title})`,
      year: libraryItems.year,
      added: sql`max(${libraryItems.addedAt})`,
      release: media.releaseDate,
      rating: media.rating,
    }[q.sort];
    // One row per title even when it's on both Plex and Jellyfin.
    const groupKey = sql`coalesce(${libraryItems.kind} || ':' || ${libraryItems.tmdbId}, ${libraryItems.server} || ':' || ${libraryItems.externalKey})`;
    const rows = ctx.db
      .select({
        kind: libraryItems.kind,
        tmdbId: libraryItems.tmdbId,
        title: sql<string>`coalesce(${media.title}, ${libraryItems.title})`,
        year: libraryItems.year,
        posterPath: sql<string | null>`coalesce(${media.posterOverride}, ${media.posterPath})`,
        rating: media.rating,
        releaseDate: media.releaseDate,
        addedAt: sql<number>`max(${libraryItems.addedAt})`,
        resolutions: sql<string>`group_concat(${libraryItems.resolution})`,
        servers: sql<string>`group_concat(distinct ${libraryItems.server})`,
        viewCount: sql<number | null>`sum(${libraryItems.viewCount})`,
        lastViewedAt: sql<number | null>`max(${libraryItems.lastViewedAt})`,
        itemIds: sql<string>`group_concat(${libraryItems.id})`,
      })
      .from(libraryItems)
      .leftJoin(media, eq(media.id, libraryItems.mediaId))
      .where(where)
      .groupBy(groupKey)
      .having(having)
      .orderBy(o(sortCol), asc(libraryItems.title))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize)
      .all();
    const total = having
      ? ctx.db.select({ n: sql<number>`count(*)` }).from(ctx.db.select({ k: sql`1` }).from(libraryItems).where(where).groupBy(groupKey).having(having).as('t')).get()!.n
      : ctx.db.select({ n: sql<number>`count(distinct ${groupKey})` }).from(libraryItems).where(where).get()!.n;
    return {
      total,
      page: q.page,
      items: rows.map((r) => ({
        ...r,
        resolution: bestResolution((r.resolutions ?? '').split(',').filter(Boolean)),
        servers: (r.servers ?? '').split(',').filter(Boolean),
        itemIds: (r.itemIds ?? '').split(',').filter(Boolean).map(Number),
        resolutions: undefined,
      })),
    };
  });

  // The Plex libraries titles are in ("Movies", "Kids Movies", "4K Movies"), for the Library filter.
  app.get('/api/library/sections', { config: { access: 'user' } }, async () => ({
    libraries: ctx.db
      .select({ name: sql<string>`${libraryItems.library}`, kind: libraryItems.kind, count: sql<number>`count(*)` })
      .from(libraryItems)
      .where(isNotNull(libraryItems.library))
      .groupBy(libraryItems.library, libraryItems.kind)
      .orderBy(asc(libraryItems.library))
      .all(),
  }));

  app.get('/api/search', { config: { access: 'user' } }, async (req) => {
    const { q, page } = parse(z.object({ q: z.string().trim().min(1).max(200), page: z.coerce.number().int().min(1).max(50).default(1) }), req.query);
    const tmdb = tmdbClient(ctx);
    const local = ctx.db
      .select({ kind: libraryItems.kind, tmdbId: libraryItems.tmdbId, title: libraryItems.title, year: libraryItems.year, posterPath: sql<string | null>`coalesce(${media.posterOverride}, ${media.posterPath})` })
      .from(libraryItems)
      .leftJoin(media, eq(media.id, libraryItems.mediaId))
      .where(contains(libraryItems.title, q))
      .groupBy(sql`coalesce(${libraryItems.kind} || ':' || ${libraryItems.tmdbId}, ${libraryItems.id})`)
      .limit(10)
      .all();
    let results: ReturnType<typeof cards> = [];
    let totalPages = 0;
    let error: string | null = null;
    if (tmdb.configured) {
      try {
        const r = await tmdb.searchMulti(q, page);
        results = cards(ctx, r.results);
        totalPages = r.total_pages;
      } catch (err) {
        error = (err as Error).message;
      }
    }
    return { library: local, results, totalPages, error };
  });

  app.get('/api/media/:kind/:tmdbId', { config: { access: 'user' } }, async (req) => {
    const { kind, tmdbId } = parse(z.object({ kind: kindParam, tmdbId: z.coerce.number().int().positive() }), req.params);
    const row = await upstream(() => refreshMetadata(ctx, kind, tmdbId));
    if (!row) throw new HttpError(404, 'Not found. Set a TMDB API key in Settings → Metadata to look up titles.', 'not_found');
    const availability = availabilityFor(ctx, kind, [{ tmdbId, releaseDate: row.releaseDate }]).get(tmdbId)!;
    let seasons: { seasonNumber: number; name: string; episodeCount: number; airDate: string | null; onServer: number }[] = [];
    let collection: { id: number; name: string } | null = null;
    const tmdb = tmdbClient(ctx);
    if (kind === 'show' && tmdb.configured) {
      const show = await upstream(() => tmdb.show(tmdbId));
      const eps = episodesOnServer(ctx, tmdbId);
      seasons = show.seasons.map((s) => ({
        seasonNumber: s.season_number,
        name: s.name,
        episodeCount: s.episode_count,
        airDate: s.air_date,
        onServer: [...eps.keys()].filter((k) => k.startsWith(`${s.season_number}:`)).length,
      }));
      const airedTotal = show.seasons.filter((s) => s.season_number > 0 && s.air_date && s.air_date <= new Date().toISOString().slice(0, 10)).reduce((n, s) => n + s.episode_count, 0);
      const have = [...eps.keys()].filter((k) => !k.startsWith('0:')).length;
      if (availability.status === 'on_server' && have < airedTotal) availability.status = 'partial';
    }
    if (kind === 'movie' && tmdb.configured) {
      const m = await upstream(() => tmdb.movie(tmdbId));
      collection = m.belongs_to_collection ? { id: m.belongs_to_collection.id, name: m.belongs_to_collection.name } : null;
    }
    let ratings: { source: string; value: number | null; score: number | null }[] = [];
    const mdb = mdblistClient(ctx);
    if (mdb.configured) {
      try {
        ratings = await mdb.ratings(kind, tmdbId);
      } catch {
        // ratings are optional
      }
    }
    return {
      ...row,
      posterPath: row.posterOverride ?? row.posterPath,
      genres: row.genres ? (JSON.parse(row.genres) as string[]) : [],
      released: isReleased(kind, row),
      availability,
      seasons,
      collection,
      ratings,
      watch: watchInfo(ctx, kind, tmdbId),
    };
  });

  app.get('/api/media/show/:tmdbId/season/:season', { config: { access: 'user' } }, async (req) => {
    const { tmdbId, season } = parse(z.object({ tmdbId: z.coerce.number().int().positive(), season: z.coerce.number().int().min(0).max(500) }), req.params);
    const s = await upstream(() => tmdbClient(ctx).season(tmdbId, season));
    const eps = episodesOnServer(ctx, tmdbId);
    return {
      seasonNumber: s.season_number,
      episodes: s.episodes.map((e) => {
        const have = eps.get(`${season}:${e.episode_number}`);
        return {
          episodeNumber: e.episode_number,
          name: e.name,
          airDate: e.air_date,
          overview: e.overview,
          stillPath: e.still_path,
          runtime: e.runtime,
          onServer: Boolean(have),
          resolution: have?.resolution ?? null,
          viewCount: have?.viewCount ?? null,
          lastViewedAt: have?.lastViewedAt ?? null,
        };
      }),
    };
  });

  app.get('/api/discover/trending', { config: { access: 'user' } }, async (req) => {
    const { kind } = parse(z.object({ kind: z.enum(['all', 'movie', 'tv']).default('all') }), req.query);
    const tmdb = tmdbClient(ctx);
    if (!tmdb.configured) return { results: [] };
    const r = await upstream(() => tmdb.trending(kind));
    return { results: cards(ctx, r.results, kind === 'all' ? undefined : kind === 'movie' ? 'movie' : 'show') };
  });

  app.get('/api/discover/popular', { config: { access: 'user' } }, async (req) => {
    const { kind, page } = parse(z.object({ kind: z.enum(['movie', 'tv']), page: z.coerce.number().int().min(1).max(500).default(1) }), req.query);
    const tmdb = tmdbClient(ctx);
    if (!tmdb.configured) return { results: [] };
    const r = await upstream(() => tmdb.popular(kind, page));
    return { results: cards(ctx, r.results, kind === 'movie' ? 'movie' : 'show'), totalPages: r.total_pages };
  });

  app.get('/api/library/recent', { config: { access: 'user' } }, async (req) => {
    const q = parse(z.object({ kind: kindParam.optional(), library: z.string().trim().min(1).max(200).optional() }), req.query);
    const rows = ctx.db
      .select({ kind: libraryItems.kind, tmdbId: libraryItems.tmdbId, title: sql<string>`coalesce(${media.title}, ${libraryItems.title})`, year: libraryItems.year, posterPath: sql<string | null>`coalesce(${media.posterOverride}, ${media.posterPath})`, addedAt: sql<number>`max(${libraryItems.addedAt})` })
      .from(libraryItems)
      .leftJoin(media, eq(media.id, libraryItems.mediaId))
      .where(and(q.kind ? eq(libraryItems.kind, q.kind) : undefined, q.library ? eq(libraryItems.library, q.library) : undefined))
      .groupBy(sql`coalesce(${libraryItems.kind} || ':' || ${libraryItems.tmdbId}, ${libraryItems.id})`)
      .orderBy(desc(sql`max(${libraryItems.addedAt})`))
      .limit(20)
      .all();
    // What Cinemask itself just imported shows straight away, before Plex/Jellyfin have scanned it. For one
    // library, imports into the root folder of the same name ("Kids Movies") count.
    const imported = ctx.db
      .select({ rootId: monitored.rootId, kind: monitored.kind, tmdbId: monitored.tmdbId, title: sql<string>`coalesce(${media.title}, ${monitored.title})`, year: monitored.year, posterPath: sql<string | null>`coalesce(${media.posterOverride}, ${media.posterPath})`, addedAt: sql<number>`max(${downloads.importedAt})` })
      .from(downloads)
      .innerJoin(monitored, eq(monitored.id, downloads.monitoredId))
      .leftJoin(media, and(eq(media.kind, monitored.kind), eq(media.tmdbId, monitored.tmdbId)))
      .where(and(eq(downloads.status, 'imported'), isNotNull(downloads.importedAt), q.kind ? eq(monitored.kind, q.kind) : undefined))
      .groupBy(monitored.id)
      .orderBy(desc(sql`max(${downloads.importedAt})`))
      .limit(20)
      .all()
      .filter((r) => !q.library || rootOf(ctx, r).name === q.library)
      .map(({ rootId: _root, ...r }) => r);
    const byKey = new Map<string, (typeof rows)[number]>();
    for (const r of [...rows, ...imported]) {
      const key = r.tmdbId ? `${r.kind}:${r.tmdbId}` : `${r.kind}:${r.title}`;
      const seen = byKey.get(key);
      if (!seen || (r.addedAt ?? 0) > (seen.addedAt ?? 0)) byKey.set(key, { ...(seen ?? r), addedAt: Math.max(r.addedAt ?? 0, seen?.addedAt ?? 0) });
    }
    return { items: [...byKey.values()].sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0)).slice(0, 20) };
  });

  app.get('/api/library/sync', { config: { access: 'manager' } }, async () => opts.sync.status);

  /**
   * Fixes a wrong (or missing) match: points library items at the right TMDB title. Remembered,
   * so the next sync keeps it. Plex and Jellyfin keep their own match; this is Cinemask's view.
   */
  app.post('/api/library/match', { config: { access: 'manager' } }, async (req) => {
    const body = parse(z.object({ itemIds: z.array(z.number().int().positive()).min(1).max(10), tmdbId: z.number().int().positive() }), req.body);
    const items = ctx.db.select().from(libraryItems).where(inArray(libraryItems.id, body.itemIds)).all();
    if (items.length !== body.itemIds.length) throw new HttpError(404, 'Library item not found', 'not_found');
    const kind = items[0]!.kind;
    if (items.some((i) => i.kind !== kind)) throw new HttpError(400, 'Those items are not all the same kind', 'bad_request');
    const meta = await upstream(() => refreshMetadata(ctx, kind, body.tmdbId));
    if (!meta) throw new HttpError(404, `No ${kind === 'movie' ? 'movie' : 'show'} with that TMDB id`, 'not_found');
    for (const i of items) {
      ctx.db
        .insert(matchOverrides)
        .values({ server: i.server, externalKey: i.externalKey, tmdbId: body.tmdbId, createdAt: Date.now() })
        .onConflictDoUpdate({ target: [matchOverrides.server, matchOverrides.externalKey], set: { tmdbId: body.tmdbId, createdAt: Date.now() } })
        .run();
      ctx.db.update(libraryItems).set({ tmdbId: body.tmdbId, mediaId: meta.id }).where(eq(libraryItems.id, i.id)).run();
    }
    audit(ctx.db, req, 'library.matched', { target: `${items[0]!.title} → ${meta.title}`, details: { tmdbId: body.tmdbId, items: body.itemIds } });
    return { kind, tmdbId: body.tmdbId, title: meta.title };
  });

  app.post('/api/library/sync', { config: { access: 'manager' } }, async (req) => {
    audit(ctx.db, req, 'library.sync_started');
    void opts.sync.run().then(() => opts.sync.backfillMetadata());
    return { started: true };
  });

  /** Lookup used by other features (requests, calendar): TMDB ids of everything on the server. */
  app.get('/api/library/ids', { config: { access: 'user' } }, async (req) => {
    const { kind } = parse(z.object({ kind: kindParam }), req.query);
    const rows = ctx.db.selectDistinct({ tmdbId: libraryItems.tmdbId }).from(libraryItems).where(and(eq(libraryItems.kind, kind as MediaKind))).all();
    return rows.map((r) => r.tmdbId).filter((x): x is number => x !== null);
  });

}
