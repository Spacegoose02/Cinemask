import fs from 'node:fs';
import { and, asc, eq, gte, inArray, isNotNull, lte } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import type { AppContext } from '../context.js';
import { downloads, media, monitored, monitoredEpisodes, SERIES_TYPES, type MediaKind } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { refreshMetadata, tmdbClient } from '../library/service.js';
import { upstream } from '../library/routes.js';
import { excludeFromAutoMonitor, monitorTitle, refreshEpisodes, type MonitoredRow } from '../arr/monitor.js';
import { defaultProfileId, getProfile, listProfiles } from '../arr/profiles.js';
import { listRoots } from '../arr/roots.js';
import { autoSearch } from '../arr/search.js';
import { liveStats } from '../arr/tracker.js';
import { deleteFolder } from '../files/service.js';

/**
 * A Radarr- and Sonarr-compatible API (v3), so apps made for them (Overseerr and Jellyseerr,
 * LunaSea, nzb360, Home Assistant) can use Cinemask instead. Point them at this server with the URL
 * base /api/compat/radarr or /api/compat/sonarr and a Cinemask API key (Settings → API). Only what
 * those apps use is here: titles, lookups, adding, searching, the queue, profiles, folders and
 * the calendar. Ids are Cinemask's own.
 */
const RADARR = '/api/compat/radarr/api/v3';
const SONARR = '/api/compat/sonarr/api/v3';

const read = { config: { access: 'manager' as const, apiKey: true } };
const write = read;
const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
const img = (p: string | null | undefined) => (p ? [{ coverType: 'poster', remoteUrl: p.startsWith('/') ? `https://image.tmdb.org/t/p/original${p}` : p, url: p.startsWith('/') ? `https://image.tmdb.org/t/p/original${p}` : p }] : []);
const size = (p: string | null) => {
  try {
    return p ? fs.statSync(p).size : 0;
  } catch {
    return 0;
  }
};

function status(ctx: AppContext, appName: 'Radarr' | 'Sonarr') {
  return { appName, instanceName: 'Cinemask', version: appName === 'Radarr' ? '5.14.0.0' : '4.0.10.0', isProduction: true, authentication: 'apiKey', urlBase: `/api/compat/${appName.toLowerCase()}`, startTime: iso(Date.now() - process.uptime() * 1000), osName: process.platform, branch: 'cinemask' };
}

function profiles(ctx: AppContext) {
  return listProfiles(ctx).map((p) => ({ id: p.id, name: p.name, upgradeAllowed: p.upgradesAllowed, cutoff: 0, items: [] }));
}

function rootfolders(ctx: AppContext, kind: MediaKind) {
  return listRoots(ctx, kind)
    .filter((r) => r.path)
    .map((r, i) => {
      let free: number | null = null;
      try {
        const st = fs.statfsSync(r.path);
        free = st.bavail * st.bsize;
      } catch {
        // not mounted
      }
      return { id: i + 1, path: r.path, accessible: free !== null, freeSpace: free ?? 0, unmappedFolders: [] };
    });
}

/** The Cinemask root folder for a path an app sends (it picks from the list above). */
function rootIdFor(ctx: AppContext, kind: MediaKind, p: string | undefined): string | undefined {
  if (!p) return undefined;
  const clean = p.replace(/\/+$/, '');
  return listRoots(ctx, kind).find((r) => r.path.replace(/\/+$/, '') === clean)?.id;
}

const profileOr = (ctx: AppContext, kind: MediaKind, id: number | undefined) => (id && getProfile(ctx, id) ? id : defaultProfileId(ctx, kind));

function metaOf(ctx: AppContext, kind: MediaKind, tmdbId: number) {
  return ctx.db.select().from(media).where(and(eq(media.kind, kind), eq(media.tmdbId, tmdbId))).get();
}

const monitoredRow = (ctx: AppContext, kind: MediaKind, id: number) => {
  const row = ctx.db.select().from(monitored).where(and(eq(monitored.id, id), eq(monitored.kind, kind))).get();
  if (!row) throw notFound(kind === 'movie' ? 'Movie not found' : 'Series not found');
  return row;
};

// ---------------- Radarr ----------------

function movieView(ctx: AppContext, tmdbId: number, row?: MonitoredRow | null, extra: { title?: string; year?: number | null; overview?: string; poster?: string | null } = {}) {
  const m = metaOf(ctx, 'movie', tmdbId);
  const fileSize = row ? size(row.filePath) : 0;
  return {
    ...(row ? { id: row.id } : {}),
    title: m?.title ?? row?.title ?? extra.title ?? '',
    sortTitle: (m?.title ?? row?.title ?? extra.title ?? '').toLowerCase(),
    year: m?.year ?? row?.year ?? extra.year ?? 0,
    tmdbId,
    imdbId: m?.imdbId ?? undefined,
    overview: m?.overview ?? extra.overview ?? '',
    images: img(m?.posterOverride ?? m?.posterPath ?? extra.poster),
    titleSlug: String(tmdbId),
    status: m?.releaseDate && m.releaseDate <= new Date().toISOString().slice(0, 10) ? 'released' : 'announced',
    inCinemas: m?.releaseDate ?? undefined,
    digitalRelease: m?.digitalRelease ?? undefined,
    physicalRelease: m?.physicalRelease ?? undefined,
    runtime: m?.runtime ?? 0,
    isAvailable: true,
    minimumAvailability: 'released',
    monitored: row?.monitored ?? false,
    hasFile: Boolean(row?.filePath),
    qualityProfileId: row?.profileId ?? 0,
    path: row?.path ?? undefined,
    rootFolderPath: row ? listRoots(ctx, 'movie').find((r) => r.id === (row.rootId ?? 'default'))?.path : undefined,
    added: iso(row?.addedAt) ?? '0001-01-01T00:00:00Z',
    sizeOnDisk: fileSize,
    tags: [],
    ...(row?.filePath ? { movieFile: { id: row.id, movieId: row.id, relativePath: row.filePath.split('/').pop(), path: row.filePath, size: fileSize, quality: { quality: { name: row.fileQuality ?? 'Unknown' } } } } : {}),
  };
}

const movieRows = (ctx: AppContext) => ctx.db.select().from(monitored).where(eq(monitored.kind, 'movie')).orderBy(asc(monitored.title)).all();
const byTmdb = (ctx: AppContext, kind: MediaKind, tmdbId: number) => ctx.db.select().from(monitored).where(and(eq(monitored.kind, kind), eq(monitored.tmdbId, tmdbId))).get() ?? null;

async function lookupMovies(ctx: AppContext, term: string) {
  const t = term.trim();
  const tm = /^tmdb:(\d+)$/i.exec(t);
  const im = /^imdb:(tt\d+)$/i.exec(t) ?? /^(tt\d+)$/i.exec(t);
  let ids: number[] = [];
  if (tm) ids = [Number(tm[1])];
  else if (im) ids = ((await tmdbClient(ctx).findByExternal(im[1]!, 'imdb_id')).movie_results ?? []).map((r) => r.id);
  if (ids.length) {
    const out = [];
    for (const id of ids) if (await refreshMetadata(ctx, 'movie', id)) out.push(movieView(ctx, id, byTmdb(ctx, 'movie', id)));
    return out;
  }
  const r = await tmdbClient(ctx).searchKind('movie', t);
  return r.results.slice(0, 20).map((x) => movieView(ctx, x.id, byTmdb(ctx, 'movie', x.id), { title: x.title ?? x.name, year: (x.release_date ?? '').slice(0, 4) ? Number((x.release_date ?? '').slice(0, 4)) : null, overview: x.overview, poster: x.poster_path }));
}

// ---------------- Sonarr ----------------

function episodeRows(ctx: AppContext, ids: number[]) {
  return ids.length ? ctx.db.select().from(monitoredEpisodes).where(inArray(monitoredEpisodes.monitoredId, ids)).orderBy(asc(monitoredEpisodes.season), asc(monitoredEpisodes.episode)).all() : [];
}

type EpisodeRow = typeof monitoredEpisodes.$inferSelect;

function seriesView(ctx: AppContext, tmdbId: number, row: MonitoredRow | null, eps: EpisodeRow[], extra: { title?: string; year?: number | null; overview?: string; poster?: string | null; seasons?: number[]; tvdbId?: number | null } = {}) {
  const m = metaOf(ctx, 'show', tmdbId);
  const today = new Date().toISOString().slice(0, 10);
  const wanted: number[] | null = row?.seasons ? (JSON.parse(row.seasons) as number[]) : null;
  const seasonNums = eps.length ? [...new Set(eps.map((e) => e.season))] : (extra.seasons ?? []);
  const stat = (list: EpisodeRow[]) => {
    const files = new Set(list.filter((e) => e.filePath).map((e) => e.filePath!));
    return {
      episodeFileCount: list.filter((e) => e.filePath).length,
      episodeCount: list.filter((e) => e.monitored && e.airDate && e.airDate <= today).length,
      totalEpisodeCount: list.length,
      sizeOnDisk: [...files].reduce((n, f) => n + size(f), 0),
      percentOfEpisodes: list.length ? Math.round((list.filter((e) => e.filePath).length / list.length) * 1000) / 10 : 0,
    };
  };
  return {
    ...(row ? { id: row.id } : {}),
    title: m?.title ?? row?.title ?? extra.title ?? '',
    sortTitle: (m?.title ?? row?.title ?? extra.title ?? '').toLowerCase(),
    year: m?.year ?? row?.year ?? extra.year ?? 0,
    tvdbId: m?.tvdbId ?? extra.tvdbId ?? 0,
    tmdbId,
    imdbId: m?.imdbId ?? undefined,
    overview: m?.overview ?? extra.overview ?? '',
    network: m?.network ?? undefined,
    status: m?.tmdbStatus === 'Ended' || m?.tmdbStatus === 'Canceled' ? 'ended' : 'continuing',
    images: img(m?.posterOverride ?? m?.posterPath ?? extra.poster),
    titleSlug: String(tmdbId),
    seriesType: row?.seriesType ?? 'standard',
    seasonFolder: true,
    monitored: row?.monitored ?? false,
    qualityProfileId: row?.profileId ?? 0,
    languageProfileId: 1,
    path: row?.path ?? undefined,
    rootFolderPath: row ? listRoots(ctx, 'show').find((r) => r.id === (row.rootId ?? 'default'))?.path : undefined,
    added: iso(row?.addedAt) ?? '0001-01-01T00:00:00Z',
    tags: [],
    seasons: seasonNums.map((n) => ({ seasonNumber: n, monitored: Boolean(row?.monitored) && (wanted === null || wanted.includes(n)), statistics: stat(eps.filter((e) => e.season === n)) })),
    statistics: { seasonCount: seasonNums.length, ...stat(eps) },
  };
}

function episodeView(e: EpisodeRow) {
  return {
    id: e.id,
    seriesId: e.monitoredId,
    seasonNumber: e.season,
    episodeNumber: e.episode,
    absoluteEpisodeNumber: e.absoluteNumber ?? undefined,
    title: e.title ?? '',
    airDate: e.airDate ?? undefined,
    airDateUtc: e.airDate ? `${e.airDate}T00:00:00Z` : undefined,
    hasFile: Boolean(e.filePath),
    monitored: e.monitored,
    ...(e.filePath ? { episodeFile: { id: e.id, path: e.filePath, relativePath: e.filePath.split('/').pop(), quality: { quality: { name: e.fileQuality ?? 'Unknown' } } } } : {}),
  };
}

async function tmdbForTvdb(ctx: AppContext, tvdbId: number): Promise<number | null> {
  const known = ctx.db.select().from(media).where(and(eq(media.kind, 'show'), eq(media.tvdbId, tvdbId))).get();
  if (known) return known.tmdbId;
  return (await tmdbClient(ctx).findByExternal(String(tvdbId), 'tvdb_id')).tv_results?.[0]?.id ?? null;
}

async function seriesLookup(ctx: AppContext, tmdbId: number, tvdbId?: number | null) {
  const row = byTmdb(ctx, 'show', tmdbId);
  if (row) return seriesView(ctx, tmdbId, row, episodeRows(ctx, [row.id]));
  await refreshMetadata(ctx, 'show', tmdbId);
  const show = await tmdbClient(ctx).show(tmdbId);
  return seriesView(ctx, tmdbId, null, [], { seasons: show.seasons.map((s) => s.season_number), tvdbId: tvdbId ?? show.external_ids?.tvdb_id ?? null });
}

async function lookupSeries(ctx: AppContext, term: string) {
  const t = term.trim();
  const tv = /^tvdb:(\d+)$/i.exec(t);
  const tm = /^tmdb:(\d+)$/i.exec(t);
  if (tv || tm) {
    const tmdbId = tm ? Number(tm[1]) : await tmdbForTvdb(ctx, Number(tv![1]));
    return tmdbId ? [await seriesLookup(ctx, tmdbId, tv ? Number(tv[1]) : null)] : [];
  }
  const r = await tmdbClient(ctx).searchKind('tv', t);
  return r.results.slice(0, 20).map((x) => {
    const row = byTmdb(ctx, 'show', x.id);
    return seriesView(ctx, x.id, row, row ? episodeRows(ctx, [row.id]) : [], { title: x.name ?? x.title, year: (x.first_air_date ?? '').slice(0, 4) ? Number((x.first_air_date ?? '').slice(0, 4)) : null, overview: x.overview, poster: x.poster_path });
  });
}

// ---------------- Queue ----------------

function queue(ctx: AppContext, kind: MediaKind) {
  const rows = ctx.db
    .select({ d: downloads, m: monitored })
    .from(downloads)
    .innerJoin(monitored, eq(monitored.id, downloads.monitoredId))
    .where(and(eq(monitored.kind, kind), inArray(downloads.status, ['held', 'queued', 'downloading', 'paused', 'completed', 'importing'])))
    .all();
  const records = rows.map(({ d, m }) => {
    const total = d.size ?? 0;
    const eta = liveStats.get(d.id)?.eta ?? null;
    const hms = eta === null ? undefined : `${String(Math.floor(eta / 3600)).padStart(2, '0')}:${String(Math.floor((eta % 3600) / 60)).padStart(2, '0')}:${String(eta % 60).padStart(2, '0')}`;
    const ep = d.episodes ? (JSON.parse(d.episodes) as { season: number; episodes: number[] }) : null;
    const epRow = ep?.episodes.length ? ctx.db.select().from(monitoredEpisodes).where(and(eq(monitoredEpisodes.monitoredId, m.id), eq(monitoredEpisodes.season, ep.season), eq(monitoredEpisodes.episode, ep.episodes[0]!))).get() : undefined;
    return {
      id: d.id,
      ...(kind === 'movie' ? { movieId: m.id, movie: movieView(ctx, m.tmdbId, m) } : { seriesId: m.id, episodeId: epRow?.id, ...(epRow ? { episode: episodeView(epRow) } : {}), seasonNumber: ep?.season }),
      title: d.title,
      size: total,
      sizeleft: Math.round(total * (1 - d.progress)),
      timeleft: hms,
      estimatedCompletionTime: eta === null ? undefined : new Date(Date.now() + eta * 1000).toISOString(),
      status: d.status === 'downloading' ? 'downloading' : d.status === 'paused' ? 'paused' : d.status === 'queued' || d.status === 'held' ? 'queued' : 'completed',
      trackedDownloadStatus: d.warning ? 'warning' : 'ok',
      trackedDownloadState: d.status === 'importing' || d.status === 'completed' ? 'importPending' : 'downloading',
      statusMessages: d.warning ? [{ title: d.title, messages: [d.warning] }] : [],
      downloadId: d.downloadId ?? String(d.id),
      protocol: d.protocol === 'usenet' ? 'usenet' : 'torrent',
      downloadClient: 'Cinemask',
      indexer: d.indexer ?? undefined,
      quality: { quality: { name: d.quality ?? 'Unknown' } },
    };
  });
  return { page: 1, pageSize: records.length, totalRecords: records.length, records };
}

const commandBody = z
  .object({
    name: z.string().max(100),
    movieIds: z.array(z.number().int().positive()).max(500).optional(),
    seriesId: z.number().int().positive().optional(),
    seasonNumber: z.number().int().min(0).max(500).optional(),
    episodeIds: z.array(z.number().int().positive()).max(500).optional(),
  })
  .passthrough();

let commandId = 0;
const accepted = (name: string) => ({ id: ++commandId, name, commandName: name, status: 'queued', queued: new Date().toISOString(), trigger: 'manual' });

export async function compatRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const who = (req: FastifyRequest) => req.user!.displayName || req.user!.username;

  for (const [prefix, appName, kind] of [
    [RADARR, 'Radarr', 'movie'],
    [SONARR, 'Sonarr', 'show'],
  ] as const) {
    app.get(`${prefix}/system/status`, read, async () => status(ctx, appName));
    app.get(`${prefix}/qualityprofile`, read, async () => profiles(ctx));
    app.get(`${prefix}/rootfolder`, read, async () => rootfolders(ctx, kind));
    app.get(`${prefix}/tag`, read, async () => []);
    app.get(`${prefix}/queue`, read, async () => queue(ctx, kind));
    app.get(`${prefix}/health`, read, async () => []);
  }

  // ---- Radarr
  app.get(`${RADARR}/movie`, read, async (req) => {
    const q = parse(z.object({ tmdbId: z.coerce.number().int().positive().optional() }), req.query);
    const rows = q.tmdbId ? [byTmdb(ctx, 'movie', q.tmdbId)].filter((r): r is MonitoredRow => Boolean(r)) : movieRows(ctx);
    return rows.map((r) => movieView(ctx, r.tmdbId, r));
  });
  app.get(`${RADARR}/movie/lookup`, read, async (req) => {
    const { term } = parse(z.object({ term: z.string().trim().min(1).max(200) }), req.query);
    return upstream(() => lookupMovies(ctx, term));
  });
  app.get(`${RADARR}/movie/lookup/tmdb`, read, async (req) => {
    const { tmdbId } = parse(z.object({ tmdbId: z.coerce.number().int().positive() }), req.query);
    const [m] = await upstream(() => lookupMovies(ctx, `tmdb:${tmdbId}`));
    if (!m) throw notFound('Movie not found');
    return m;
  });
  app.get(`${RADARR}/movie/:id`, read, async (req) => {
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const r = monitoredRow(ctx, 'movie', id);
    return movieView(ctx, r.tmdbId, r);
  });
  const movieBody = z
    .object({
      tmdbId: z.number().int().positive(),
      qualityProfileId: z.number().int().optional(),
      rootFolderPath: z.string().max(1000).optional(),
      monitored: z.boolean().default(true),
      addOptions: z.object({ searchForMovie: z.boolean().optional() }).passthrough().optional(),
    })
    .passthrough();
  app.post(`${RADARR}/movie`, write, async (req) => {
    const b = parse(movieBody, req.body);
    if (byTmdb(ctx, 'movie', b.tmdbId)) throw badRequest('This movie has already been added');
    const row = await upstream(() => monitorTitle(ctx, { kind: 'movie', tmdbId: b.tmdbId, profileId: profileOr(ctx, 'movie', b.qualityProfileId), rootId: rootIdFor(ctx, 'movie', b.rootFolderPath), addedBy: req.user!.id }));
    if (!b.monitored) ctx.db.update(monitored).set({ monitored: false }).where(eq(monitored.id, row.id)).run();
    audit(ctx.db, req, 'compat.movie_added', { target: row.title });
    if (b.monitored && b.addOptions?.searchForMovie !== false) void autoSearch(ctx, row).catch(() => undefined);
    return movieView(ctx, row.tmdbId, ctx.db.select().from(monitored).where(eq(monitored.id, row.id)).get()!);
  });
  const updateMovie = async (req: FastifyRequest, id: number) => {
    const b = parse(z.object({ monitored: z.boolean().optional(), qualityProfileId: z.number().int().optional(), addOptions: z.object({ searchForMovie: z.boolean().optional() }).passthrough().optional() }).passthrough(), req.body);
    const r = monitoredRow(ctx, 'movie', id);
    ctx.db
      .update(monitored)
      .set({ ...(b.monitored !== undefined ? { monitored: b.monitored } : {}), ...(b.qualityProfileId && getProfile(ctx, b.qualityProfileId) ? { profileId: b.qualityProfileId } : {}) })
      .where(eq(monitored.id, id))
      .run();
    audit(ctx.db, req, 'compat.movie_updated', { target: r.title });
    const fresh = monitoredRow(ctx, 'movie', id);
    if (b.addOptions?.searchForMovie && fresh.monitored) void autoSearch(ctx, fresh).catch(() => undefined);
    return movieView(ctx, fresh.tmdbId, fresh);
  };
  app.put(`${RADARR}/movie/:id`, write, async (req) => updateMovie(req, parse(z.object({ id: z.coerce.number().int().positive() }), req.params).id));
  app.put(`${RADARR}/movie`, write, async (req) => updateMovie(req, parse(z.object({ id: z.number().int().positive() }).passthrough(), req.body).id));
  app.delete(`${RADARR}/movie/:id`, write, async (req) => {
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const { deleteFiles } = parse(z.object({ deleteFiles: z.coerce.boolean().default(false) }).passthrough(), req.query);
    const r = monitoredRow(ctx, 'movie', id);
    if (deleteFiles) deleteFolder(ctx, r, who(req));
    ctx.db.delete(monitored).where(eq(monitored.id, id)).run();
    excludeFromAutoMonitor(ctx, 'movie', r.tmdbId);
    audit(ctx.db, req, 'compat.movie_removed', { target: r.title, details: { deleteFiles } });
    return {};
  });
  app.get(`${RADARR}/calendar`, read, async (req) => {
    const q = parse(z.object({ start: z.string().max(40).optional(), end: z.string().max(40).optional() }).passthrough(), req.query);
    const start = (q.start ?? new Date().toISOString()).slice(0, 10);
    const end = (q.end ?? new Date(Date.now() + 7 * 86_400_000).toISOString()).slice(0, 10);
    return movieRows(ctx)
      .filter((r) => {
        const m = metaOf(ctx, 'movie', r.tmdbId);
        return [m?.releaseDate, m?.digitalRelease, m?.physicalRelease].some((d) => d && d >= start && d <= end);
      })
      .map((r) => movieView(ctx, r.tmdbId, r));
  });

  // ---- Sonarr
  app.get(`${SONARR}/languageprofile`, read, async () => [{ id: 1, name: 'Any' }]);
  app.get(`${SONARR}/series`, read, async (req) => {
    const q = parse(z.object({ tvdbId: z.coerce.number().int().positive().optional() }), req.query);
    let rows = ctx.db.select().from(monitored).where(eq(monitored.kind, 'show')).orderBy(asc(monitored.title)).all();
    if (q.tvdbId) {
      const tmdbId = ctx.db.select().from(media).where(and(eq(media.kind, 'show'), eq(media.tvdbId, q.tvdbId))).get()?.tmdbId;
      rows = rows.filter((r) => r.tmdbId === tmdbId);
    }
    const eps = episodeRows(ctx, rows.map((r) => r.id));
    return rows.map((r) => seriesView(ctx, r.tmdbId, r, eps.filter((e) => e.monitoredId === r.id)));
  });
  app.get(`${SONARR}/series/lookup`, read, async (req) => {
    const { term } = parse(z.object({ term: z.string().trim().min(1).max(200) }), req.query);
    return upstream(() => lookupSeries(ctx, term));
  });
  app.get(`${SONARR}/series/:id`, read, async (req) => {
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const r = monitoredRow(ctx, 'show', id);
    return seriesView(ctx, r.tmdbId, r, episodeRows(ctx, [r.id]));
  });
  const seasonsSchema = z.array(z.object({ seasonNumber: z.number().int().min(0).max(500), monitored: z.boolean() }).passthrough()).max(200).optional();
  /** The seasons to keep: null means every season (and future ones), the way Cinemask stores it. */
  const pickSeasons = (seasons: z.infer<typeof seasonsSchema>) => {
    const regular = (seasons ?? []).filter((s) => s.seasonNumber > 0);
    const on = regular.filter((s) => s.monitored).map((s) => s.seasonNumber);
    return !regular.length || on.length === regular.length ? null : on;
  };
  app.post(`${SONARR}/series`, write, async (req) => {
    const b = parse(
      z
        .object({
          tvdbId: z.number().int().positive().optional(),
          tmdbId: z.number().int().positive().optional(),
          qualityProfileId: z.number().int().optional(),
          rootFolderPath: z.string().max(1000).optional(),
          seriesType: z.enum(SERIES_TYPES).optional(),
          monitored: z.boolean().default(true),
          seasons: seasonsSchema,
          addOptions: z.object({ searchForMissingEpisodes: z.boolean().optional() }).passthrough().optional(),
        })
        .passthrough(),
      req.body,
    );
    const tmdbId = b.tmdbId ?? (b.tvdbId ? await upstream(() => tmdbForTvdb(ctx, b.tvdbId!)) : null);
    if (!tmdbId) throw badRequest('Could not find that series');
    if (byTmdb(ctx, 'show', tmdbId)) throw badRequest('This series has already been added');
    const row = await upstream(() => monitorTitle(ctx, { kind: 'show', tmdbId, profileId: profileOr(ctx, 'show', b.qualityProfileId), seasons: pickSeasons(b.seasons), rootId: rootIdFor(ctx, 'show', b.rootFolderPath), addedBy: req.user!.id }));
    if (!b.monitored || b.seriesType) ctx.db.update(monitored).set({ ...(b.monitored ? {} : { monitored: false }), ...(b.seriesType ? { seriesType: b.seriesType } : {}) }).where(eq(monitored.id, row.id)).run();
    audit(ctx.db, req, 'compat.series_added', { target: row.title });
    const fresh = monitoredRow(ctx, 'show', row.id);
    if (fresh.monitored && b.addOptions?.searchForMissingEpisodes !== false) void autoSearch(ctx, fresh).catch(() => undefined);
    return seriesView(ctx, tmdbId, fresh, episodeRows(ctx, [row.id]));
  });
  const updateSeries = async (req: FastifyRequest, id: number) => {
    const b = parse(z.object({ monitored: z.boolean().optional(), qualityProfileId: z.number().int().optional(), seriesType: z.enum(SERIES_TYPES).optional(), seasons: seasonsSchema }).passthrough(), req.body);
    const r = monitoredRow(ctx, 'show', id);
    const seasons = b.seasons ? pickSeasons(b.seasons) : undefined;
    ctx.db
      .update(monitored)
      .set({
        ...(b.monitored !== undefined ? { monitored: b.monitored } : {}),
        ...(b.qualityProfileId && getProfile(ctx, b.qualityProfileId) ? { profileId: b.qualityProfileId } : {}),
        ...(b.seriesType ? { seriesType: b.seriesType } : {}),
        ...(seasons !== undefined ? { seasons: seasons ? JSON.stringify(seasons) : null } : {}),
      })
      .where(eq(monitored.id, id))
      .run();
    const fresh = monitoredRow(ctx, 'show', id);
    if (seasons !== undefined) await refreshEpisodes(ctx, fresh, true).catch(() => undefined);
    audit(ctx.db, req, 'compat.series_updated', { target: r.title });
    return seriesView(ctx, fresh.tmdbId, fresh, episodeRows(ctx, [id]));
  };
  app.put(`${SONARR}/series/:id`, write, async (req) => updateSeries(req, parse(z.object({ id: z.coerce.number().int().positive() }), req.params).id));
  app.put(`${SONARR}/series`, write, async (req) => updateSeries(req, parse(z.object({ id: z.number().int().positive() }).passthrough(), req.body).id));
  app.delete(`${SONARR}/series/:id`, write, async (req) => {
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const { deleteFiles } = parse(z.object({ deleteFiles: z.coerce.boolean().default(false) }).passthrough(), req.query);
    const r = monitoredRow(ctx, 'show', id);
    if (deleteFiles) deleteFolder(ctx, r, who(req));
    ctx.db.delete(monitored).where(eq(monitored.id, id)).run();
    excludeFromAutoMonitor(ctx, 'show', r.tmdbId);
    audit(ctx.db, req, 'compat.series_removed', { target: r.title, details: { deleteFiles } });
    return {};
  });
  app.get(`${SONARR}/episode`, read, async (req) => {
    const q = parse(z.object({ seriesId: z.coerce.number().int().positive() }).passthrough(), req.query);
    monitoredRow(ctx, 'show', q.seriesId);
    return episodeRows(ctx, [q.seriesId]).map(episodeView);
  });
  app.get(`${SONARR}/calendar`, read, async (req) => {
    const q = parse(z.object({ start: z.string().max(40).optional(), end: z.string().max(40).optional() }).passthrough(), req.query);
    const start = (q.start ?? new Date().toISOString()).slice(0, 10);
    const end = (q.end ?? new Date(Date.now() + 7 * 86_400_000).toISOString()).slice(0, 10);
    const eps = ctx.db
      .select()
      .from(monitoredEpisodes)
      .where(and(isNotNull(monitoredEpisodes.airDate), gte(monitoredEpisodes.airDate, start), lte(monitoredEpisodes.airDate, end)))
      .orderBy(asc(monitoredEpisodes.airDate))
      .limit(500)
      .all();
    const shows = new Map(
      ctx.db
        .select()
        .from(monitored)
        .where(inArray(monitored.id, [...new Set(eps.map((e) => e.monitoredId)), 0]))
        .all()
        .map((r) => [r.id, r]),
    );
    return eps.filter((e) => shows.get(e.monitoredId)?.monitored).map((e) => ({ ...episodeView(e), series: seriesView(ctx, shows.get(e.monitoredId)!.tmdbId, shows.get(e.monitoredId)!, []) }));
  });

  // ---- Commands (both)
  for (const [prefix, kind] of [
    [RADARR, 'movie'],
    [SONARR, 'show'],
  ] as const) {
    app.post(`${prefix}/command`, write, async (req) => {
      const b = parse(commandBody, req.body);
      const search = (row: MonitoredRow, filter?: { season?: number; episode?: number }) => void autoSearch(ctx, row, filter).catch(() => undefined);
      if (kind === 'movie' && b.name === 'MoviesSearch') for (const id of b.movieIds ?? []) search(monitoredRow(ctx, 'movie', id));
      else if (kind === 'show' && b.name === 'SeriesSearch' && b.seriesId) search(monitoredRow(ctx, 'show', b.seriesId));
      else if (kind === 'show' && b.name === 'SeasonSearch' && b.seriesId && b.seasonNumber !== undefined) search(monitoredRow(ctx, 'show', b.seriesId), { season: b.seasonNumber });
      else if (kind === 'show' && b.name === 'EpisodeSearch') {
        for (const e of b.episodeIds?.length ? ctx.db.select().from(monitoredEpisodes).where(inArray(monitoredEpisodes.id, b.episodeIds)).all() : []) search(monitoredRow(ctx, 'show', e.monitoredId), { season: e.season, episode: e.episode });
      } else if (!['RefreshMovie', 'RefreshSeries', 'RssSync', 'RescanMovie', 'RescanSeries', 'MissingMoviesSearch', 'MissingEpisodeSearch'].includes(b.name)) throw badRequest(`Cinemask doesn't do the ${b.name} command`);
      audit(ctx.db, req, 'compat.command', { target: b.name });
      return accepted(b.name);
    });
  }
}
