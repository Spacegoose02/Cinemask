import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type AnyColumn } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { downloads, libraryEpisodes, libraryItems, matchOverrides, media, MEDIA_KINDS, monitored, monitoredEpisodes, type MediaKind } from '../db/schema.js';
import { rootOf } from '../arr/roots.js';
import { bestResolution, IntegrationError } from '../integrations/http.js';
import type { AppContext } from '../context.js';
import type { TmdbPersonCredit } from '../integrations/tmdb.js';
import { HttpError } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { availabilityFor, cards, episodesOnServer, isReleased, mdblistClient, mediaServers, refreshMetadata, tmdbClient, watchInfo, type LibrarySync } from './service.js';
import { localDay } from '../lib/dates.js';
import { assertSuitable, certificationOf, forViewer, maxAgeOf, suitableSql } from '../kids/ratings.js';

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

/** How many titles a person page lists under "Known for", and at most in each of its credit lists. */
const KNOWN_FOR_SIZE = 8;
const PERSON_CREDITS_MAX = 300;
/** TMDB genres for talk and news shows, where a person only appears as themselves as a guest. */
const GUEST_GENRES = new Set([10763, 10767]);

/**
 * A person's TMDB credits as title cards, one per title (several roles on one title are joined),
 * newest first with titles that have no date yet at the top. Adult titles and talk/news guest spots are left out.
 */
export function personCredits(ctx: AppContext, credits: TmdbPersonCredit[], roleOf: (c: TmdbPersonCredit) => string | undefined) {
  const byTitle = new Map<string, { credit: TmdbPersonCredit; roles: string[]; episodes: number }>();
  for (const c of credits) {
    if ((c.media_type !== 'movie' && c.media_type !== 'tv') || c.adult) continue;
    if (c.media_type === 'tv' && c.genre_ids?.some((g) => GUEST_GENRES.has(g))) continue;
    const k = `${c.media_type}:${c.id}`;
    const entry = byTitle.get(k) ?? { credit: c, roles: [], episodes: 0 };
    const role = roleOf(c)?.trim();
    if (role && !entry.roles.includes(role)) entry.roles.push(role);
    entry.episodes += c.episode_count ?? 0;
    byTitle.set(k, entry);
  }
  const date = (c: TmdbPersonCredit) => c.release_date || c.first_air_date || '';
  const list = [...byTitle.values()]
    .sort((a, b) => {
      const da = date(a.credit);
      const db = date(b.credit);
      if (!da !== !db) return da ? 1 : -1;
      return db.localeCompare(da) || (b.credit.popularity ?? 0) - (a.credit.popularity ?? 0);
    })
    .slice(0, PERSON_CREDITS_MAX);
  // cards() keeps every movie/show credit in order, so its answer lines up with the list.
  return cards(ctx, list.map((e) => e.credit)).map((card, i) => ({
    ...card,
    role: list[i]!.roles.join(' / ') || null,
    episodes: list[i]!.episodes || null,
    votes: list[i]!.credit.vote_count ?? 0,
  }));
}

/** How far back "Aired in the last 60 days" looks. */
export const RECENT_DAYS = 60;
const daysAgo = (days: number) => localDay(Date.now() - days * 864e5);

/**
 * The Library's status filter. A show is missing episodes when a monitored episode of it has aired
 * and has no file here or on any media server (the same rule as the Missing page); otherwise it is
 * complete, and a movie on a server always is. Recent: a show with an episode out, or a movie
 * released, in the last RECENT_DAYS days.
 */
function statusSql(status: 'complete' | 'missing' | 'recent') {
  const day = localDay();
  if (status === 'recent') {
    const since = daysAgo(RECENT_DAYS);
    const show = sql`${libraryItems.kind} = 'show' AND EXISTS (
      SELECT 1 FROM ${monitored} JOIN ${monitoredEpisodes} ON ${monitoredEpisodes.monitoredId} = ${monitored.id}
      WHERE ${monitored.kind} = 'show' AND ${monitored.tmdbId} = ${libraryItems.tmdbId}
        AND ${monitoredEpisodes.airDate} BETWEEN ${since} AND ${day})`;
    const movie = sql`${libraryItems.kind} = 'movie' AND EXISTS (
      SELECT 1 FROM ${media} WHERE ${media.kind} = 'movie' AND ${media.tmdbId} = ${libraryItems.tmdbId}
        AND (${media.releaseDate} BETWEEN ${since} AND ${day} OR ${media.digitalRelease} BETWEEN ${since} AND ${day} OR ${media.physicalRelease} BETWEEN ${since} AND ${day}))`;
    return sql`((${show}) OR (${movie}))`;
  }
  const missing = sql`${libraryItems.kind} = 'show' AND EXISTS (
    SELECT 1 FROM ${monitored} JOIN ${monitoredEpisodes} ON ${monitoredEpisodes.monitoredId} = ${monitored.id}
    WHERE ${monitored.kind} = 'show' AND ${monitored.tmdbId} = ${libraryItems.tmdbId} AND ${monitored.monitored}
      AND ${monitoredEpisodes.monitored} AND ${monitoredEpisodes.airDate} <= ${day} AND ${monitoredEpisodes.filePath} IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM ${libraryEpisodes}
        WHERE ${libraryEpisodes.season} = ${monitoredEpisodes.season} AND ${libraryEpisodes.episode} = ${monitoredEpisodes.episode}
          -- Any server's copy of the show counts; library_items here is the inner query's, not the outer row.
          AND ${libraryEpisodes.libraryItemId} IN (SELECT ${libraryItems.id} FROM ${libraryItems} WHERE ${libraryItems.kind} = 'show' AND ${libraryItems.tmdbId} = ${monitored.tmdbId})))`;
  return status === 'missing' ? sql`(${missing})` : sql`NOT (${missing})`;
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
        status: z.enum(['complete', 'missing', 'recent']).optional(),
        sort: z.enum(['title', 'year', 'added', 'release', 'rating']).default('added'),
        order: z.enum(['asc', 'desc']).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(60),
      }),
      req.query,
    );
    const maxAge = maxAgeOf(ctx, req.user!.id);
    const where = and(
      q.kind ? eq(libraryItems.kind, q.kind) : undefined,
      q.q ? contains(libraryItems.title, q.q) : undefined,
      q.resolution ? eq(libraryItems.resolution, q.resolution) : undefined,
      q.library ? eq(libraryItems.library, q.library) : undefined,
      q.unmatched ? isNull(libraryItems.tmdbId) : undefined,
      q.status ? statusSql(q.status) : undefined,
      // Kids profiles only see titles rated for their age.
      maxAge !== null ? inArray(libraryItems.mediaId, ctx.db.select({ id: media.id }).from(media).where(suitableSql(maxAge))) : undefined,
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
        results = await forViewer(ctx, req.user!.id, cards(ctx, r.results));
        totalPages = r.total_pages;
      } catch (err) {
        error = (err as Error).message;
      }
    }
    return { library: await forViewer(ctx, req.user!.id, local), results, totalPages, error };
  });

  /** How many cast members a title page shows. */
  const CAST_SIZE = 20;

  app.get('/api/media/:kind/:tmdbId', { config: { access: 'user' } }, async (req) => {
    const { kind, tmdbId } = parse(z.object({ kind: kindParam, tmdbId: z.coerce.number().int().positive() }), req.params);
    await upstream(() => assertSuitable(ctx, req.user!.id, kind, tmdbId));
    const row = await upstream(() => refreshMetadata(ctx, kind, tmdbId));
    if (!row) throw new HttpError(404, 'Not found. Set a TMDB API key in Settings → Metadata to look up titles.', 'not_found');
    const availability = availabilityFor(ctx, kind, [{ tmdbId, releaseDate: row.releaseDate }]).get(tmdbId)!;
    let seasons: { seasonNumber: number; name: string; episodeCount: number; airDate: string | null; onServer: number }[] = [];
    let collection: { id: number; name: string } | null = null;
    // The main cast, for the row of faces on the page.
    let cast: { id: number; name: string; character: string; profilePath: string | null; episodes?: number }[] = [];
    const tmdb = tmdbClient(ctx);
    // The age rating stored with the title, or worked out from the TMDB answer below when it isn't stored yet.
    let certification = row.certification || null;
    const region = ctx.settings.get('metadata').region;
    if (kind === 'show' && tmdb.configured) {
      const show = await upstream(() => tmdb.show(tmdbId));
      certification ||= certificationOf(kind, show, region) || null;
      const eps = episodesOnServer(ctx, tmdbId);
      seasons = show.seasons.map((s) => ({
        seasonNumber: s.season_number,
        name: s.name,
        episodeCount: s.episode_count,
        airDate: s.air_date,
        onServer: [...eps.keys()].filter((k) => k.startsWith(`${s.season_number}:`)).length,
      }));
      const airedTotal = show.seasons.filter((s) => s.season_number > 0 && s.air_date && s.air_date <= localDay()).reduce((n, s) => n + s.episode_count, 0);
      cast = (show.aggregate_credits?.cast ?? [])
        .sort((a, b) => a.order - b.order)
        .slice(0, CAST_SIZE)
        .map((c) => ({ id: c.id, name: c.name, character: c.roles.map((r) => r.character).filter(Boolean).slice(0, 2).join(' / '), profilePath: c.profile_path, episodes: c.total_episode_count }));
      const have = [...eps.keys()].filter((k) => !k.startsWith('0:')).length;
      if (availability.status === 'on_server' && have < airedTotal) availability.status = 'partial';
    }
    if (kind === 'movie' && tmdb.configured) {
      const m = await upstream(() => tmdb.movie(tmdbId));
      certification ||= certificationOf(kind, m, region) || null;
      collection = m.belongs_to_collection ? { id: m.belongs_to_collection.id, name: m.belongs_to_collection.name } : null;
      cast = (m.credits?.cast ?? [])
        .sort((a, b) => a.order - b.order)
        .slice(0, CAST_SIZE)
        .map((c) => ({ id: c.id, name: c.name, character: c.character, profilePath: c.profile_path }));
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
      certification,
      released: isReleased(kind, row),
      availability,
      seasons,
      collection,
      cast,
      ratings,
      watch: watchInfo(ctx, kind, tmdbId),
    };
  });

  app.get('/api/people/:id', { config: { access: 'user' } }, async (req) => {
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const tmdb = tmdbClient(ctx);
    if (!tmdb.configured) throw new HttpError(404, 'Not found. Set a TMDB API key in Settings → Metadata to look up people.', 'not_found');
    const p = await upstream(() => tmdb.person(id));
    const cast = await forViewer(ctx, req.user!.id, personCredits(ctx, p.combined_credits?.cast ?? [], (c) => c.character));
    const crew = await forViewer(ctx, req.user!.id, personCredits(ctx, p.combined_credits?.crew ?? [], (c) => c.job));
    // Known for: their most-voted titles, from whichever side of the camera they mostly work on.
    const main = p.known_for_department === 'Acting' || !crew.length ? cast : crew;
    const knownFor = [...main].sort((a, b) => b.votes - a.votes).slice(0, KNOWN_FOR_SIZE);
    return {
      id: p.id,
      name: p.name,
      biography: p.biography ?? '',
      birthday: p.birthday ?? null,
      deathday: p.deathday ?? null,
      placeOfBirth: p.place_of_birth ?? null,
      department: p.known_for_department ?? null,
      profilePath: p.profile_path ?? null,
      imdbId: p.imdb_id ?? null,
      knownFor,
      cast,
      crew,
    };
  });

  app.get('/api/media/show/:tmdbId/season/:season', { config: { access: 'user' } }, async (req) => {
    const { tmdbId, season } = parse(z.object({ tmdbId: z.coerce.number().int().positive(), season: z.coerce.number().int().min(0).max(500) }), req.params);
    await upstream(() => assertSuitable(ctx, req.user!.id, 'show', tmdbId));
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
    return { results: await forViewer(ctx, req.user!.id, cards(ctx, r.results, kind === 'all' ? undefined : kind === 'movie' ? 'movie' : 'show')) };
  });

  app.get('/api/discover/popular', { config: { access: 'user' } }, async (req) => {
    const { kind, page } = parse(z.object({ kind: z.enum(['movie', 'tv']), page: z.coerce.number().int().min(1).max(500).default(1) }), req.query);
    const tmdb = tmdbClient(ctx);
    if (!tmdb.configured) return { results: [] };
    const r = await upstream(() => tmdb.popular(kind, page));
    return { results: await forViewer(ctx, req.user!.id, cards(ctx, r.results, kind === 'movie' ? 'movie' : 'show')), totalPages: r.total_pages };
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
    return { items: await forViewer(ctx, req.user!.id, [...byKey.values()].sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0)).slice(0, 20)) };
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

  /**
   * One library title as the media servers have it: the page for titles with no TMDB match (and so
   * no movie or show page). The same title on other servers comes along, as in the Library grid.
   */
  function libraryGroup(userId: number, id: number) {
    const first = ctx.db.select().from(libraryItems).where(eq(libraryItems.id, id)).get();
    if (!first) throw new HttpError(404, 'Library item not found', 'not_found');
    // Kids profiles only see titles rated for their age, and an unmatched title has no rating.
    const maxAge = maxAgeOf(ctx, userId);
    if (maxAge !== null) {
      const ok = first.mediaId !== null && ctx.db.select({ id: media.id }).from(media).where(and(eq(media.id, first.mediaId), suitableSql(maxAge))).get();
      if (!ok) throw new HttpError(404, 'Library item not found', 'not_found');
    }
    const items = first.tmdbId === null ? [first] : ctx.db.select().from(libraryItems).where(and(eq(libraryItems.kind, first.kind), eq(libraryItems.tmdbId, first.tmdbId))).all();
    return { first, items };
  }

  app.get('/api/library/items/:id', { config: { access: 'user' } }, async (req) => {
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const { first, items } = libraryGroup(req.user!.id, id);
    const eps = first.kind === 'show' ? ctx.db.select().from(libraryEpisodes).where(inArray(libraryEpisodes.libraryItemId, items.map((i) => i.id))).orderBy(asc(libraryEpisodes.season), asc(libraryEpisodes.episode)).all() : [];
    const byEp = new Map<string, { season: number; episode: number; title: string | null; resolution: string | null; viewCount: number | null }>();
    for (const e of eps) {
      const k = `${e.season}:${e.episode}`;
      const had = byEp.get(k);
      if (!had) byEp.set(k, { season: e.season, episode: e.episode, title: e.title, resolution: e.resolution, viewCount: e.viewCount });
      else {
        had.resolution = bestResolution([had.resolution, e.resolution]);
        if (e.viewCount !== null) had.viewCount = Math.max(had.viewCount ?? 0, e.viewCount);
      }
    }
    const meta = first.mediaId ? ctx.db.select({ posterPath: sql<string | null>`coalesce(${media.posterOverride}, ${media.posterPath})` }).from(media).where(eq(media.id, first.mediaId)).get() : undefined;
    return {
      id: first.id,
      kind: first.kind,
      tmdbId: first.tmdbId,
      imdbId: first.imdbId,
      tvdbId: first.tvdbId,
      title: first.title,
      year: first.year,
      posterPath: meta?.posterPath ?? null,
      resolution: bestResolution(items.map((i) => i.resolution)),
      itemIds: items.map((i) => i.id),
      copies: items.map((i) => ({
        id: i.id,
        server: i.server,
        library: i.library,
        resolution: i.resolution,
        addedAt: i.addedAt,
        viewCount: i.viewCount,
        lastViewedAt: i.lastViewedAt,
        labels: i.labels ? (JSON.parse(i.labels) as string[]) : [],
      })),
      episodes: [...byEp.values()],
    };
  });

  /** Managers: the files behind a library title, read from the media servers that have it. */
  app.get('/api/library/items/:id/files', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const { items } = libraryGroup(req.user!.id, id);
    const servers = mediaServers(ctx);
    const out = [];
    for (const i of items) {
      const client = servers.find((s) => s.server === i.server)?.client;
      if (!client?.itemFiles) {
        out.push({ itemId: i.id, server: i.server, files: [], error: client ? 'This server does not share file details.' : 'This server is not connected.' });
        continue;
      }
      try {
        out.push({ itemId: i.id, server: i.server, files: await client.itemFiles(i.externalKey, i.kind), error: null });
      } catch (err) {
        out.push({ itemId: i.id, server: i.server, files: [], error: (err as Error).message });
      }
    }
    return { servers: out };
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
