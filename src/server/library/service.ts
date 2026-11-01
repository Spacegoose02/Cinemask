import { and, eq, inArray, isNull, notInArray, or } from 'drizzle-orm';
import { requestAvailable } from '../notify/events.js';
import type { AppContext } from '../context.js';
import { libraryEpisodes, libraryItems, matchOverrides, media, monitoredEpisodes, requests, type MediaKind, type ServerType } from '../db/schema.js';
import { localDay } from '../lib/dates.js';
import { bestResolution } from '../integrations/http.js';
import { BingeBanditClient } from '../integrations/bingebandit.js';
import { JellyfinClient } from '../integrations/jellyfin.js';
import type { MediaServerClient, ServerItem } from '../integrations/mediaserver.js';
import { MdblistClient } from '../integrations/mdblist.js';
import { PlexClient } from '../integrations/plex.js';
import { pickTrailer, releaseDates, TmdbClient, type TmdbMovie, type TmdbSearchResult, type TmdbShow } from '../integrations/tmdb.js';
import { ageOf, certificationOf } from '../kids/ratings.js';

export type Availability = 'on_server' | 'partial' | 'not_on_server' | 'not_available';

const METADATA_MAX_AGE = 3 * 24 * 60 * 60 * 1000;
const today = () => localDay();

export function tmdbClient(ctx: AppContext): TmdbClient {
  const m = ctx.settings.get('metadata');
  return new TmdbClient(() => ctx.db, m.tmdbApiKey, m.language, m.region);
}

export function mdblistClient(ctx: AppContext): MdblistClient {
  return new MdblistClient(ctx.settings.get('metadata').mdblistApiKey);
}

export function mediaServers(ctx: AppContext): { server: ServerType; client: MediaServerClient }[] {
  const out: { server: ServerType; client: MediaServerClient }[] = [];
  const plex = ctx.settings.get('plex');
  if (plex.enabled && plex.url && plex.token) out.push({ server: 'plex', client: new PlexClient(plex.url, plex.token) });
  const jf = ctx.settings.get('jellyfin');
  if (jf.enabled && jf.url && jf.apiKey) out.push({ server: 'jellyfin', client: new JellyfinClient(jf.url, jf.apiKey) });
  const bb = ctx.settings.get('bingebandit');
  if (bb.enabled && bb.url && bb.apiKey) out.push({ server: 'bingebandit', client: new BingeBanditClient(bb.url, bb.apiKey) });
  return out;
}

/** Returns the media row id for a TMDB title, creating a placeholder row if it is new. */
export function ensureMedia(ctx: AppContext, kind: MediaKind, tmdbId: number, fallback: { title: string; year?: number | null }): number {
  const existing = ctx.db.select({ id: media.id }).from(media).where(and(eq(media.kind, kind), eq(media.tmdbId, tmdbId))).get();
  if (existing) return existing.id;
  return ctx.db.insert(media).values({ kind, tmdbId, title: fallback.title, year: fallback.year ?? null }).returning({ id: media.id }).get().id;
}

/** Fetches details from TMDB into the media table when missing or older than a few days. */
export async function refreshMetadata(ctx: AppContext, kind: MediaKind, tmdbId: number, force = false) {
  const tmdb = tmdbClient(ctx);
  const row = ctx.db.select().from(media).where(and(eq(media.kind, kind), eq(media.tmdbId, tmdbId))).get();
  if (row && !force && row.metadataUpdatedAt && Date.now() - row.metadataUpdatedAt < METADATA_MAX_AGE) return row;
  if (!tmdb.configured) return row ?? null;
  const region = ctx.settings.get('metadata').region;
  const rated = (k: MediaKind, t: TmdbMovie | TmdbShow) => {
    const certification = certificationOf(k, t, region);
    return { certification, minAge: ageOf(certification) };
  };
  let values: Omit<typeof media.$inferInsert, 'id' | 'kind' | 'tmdbId'>;
  if (kind === 'movie') {
    const m = await tmdb.movie(tmdbId);
    const dates = releaseDates(m, region);
    values = {
      title: m.title,
      year: m.release_date ? Number(m.release_date.slice(0, 4)) : null,
      overview: m.overview,
      posterPath: m.poster_path,
      backdropPath: m.backdrop_path,
      releaseDate: m.release_date || null,
      digitalRelease: dates.digital,
      physicalRelease: dates.physical,
      tmdbStatus: m.status,
      runtime: m.runtime,
      genres: JSON.stringify(m.genres.map((g) => g.name)),
      rating: m.vote_average,
      imdbId: m.imdb_id,
      trailerKey: pickTrailer(m.videos?.results),
      ...rated('movie', m),
      metadataUpdatedAt: Date.now(),
    };
  } else {
    const s = await tmdb.show(tmdbId);
    values = {
      title: s.name,
      year: s.first_air_date ? Number(s.first_air_date.slice(0, 4)) : null,
      overview: s.overview,
      posterPath: s.poster_path,
      backdropPath: s.backdrop_path,
      releaseDate: s.first_air_date || null,
      nextAirDate: s.next_episode_to_air?.air_date ?? null,
      tmdbStatus: s.status,
      runtime: s.episode_run_time[0] ?? null,
      genres: JSON.stringify(s.genres.map((g) => g.name)),
      network: s.networks[0]?.name ?? null,
      rating: s.vote_average,
      imdbId: s.external_ids?.imdb_id ?? null,
      tvdbId: s.external_ids?.tvdb_id ?? null,
      trailerKey: pickTrailer(s.videos?.results),
      ...rated('show', s),
      metadataUpdatedAt: Date.now(),
    };
  }
  return ctx.db
    .insert(media)
    .values({ kind, tmdbId, ...values })
    .onConflictDoUpdate({ target: [media.kind, media.tmdbId], set: values })
    .returning()
    .get();
}

/** Has the title been released for home viewing yet? Uses digital/physical dates for movies when known. */
export function isReleased(kind: MediaKind, dates: { releaseDate?: string | null; digitalRelease?: string | null; physicalRelease?: string | null }): boolean {
  const t = today();
  if (kind === 'movie' && (dates.digitalRelease || dates.physicalRelease)) {
    return [dates.digitalRelease, dates.physicalRelease].some((d) => d && d <= t);
  }
  return Boolean(dates.releaseDate && dates.releaseDate <= t);
}

export interface AvailabilityInfo {
  status: Availability;
  resolution: string | null;
  servers: ServerType[];
}

/** Availability for many TMDB ids at once (for lists and search results). */
export function availabilityFor(ctx: AppContext, kind: MediaKind, items: { tmdbId: number; releaseDate?: string | null }[]): Map<number, AvailabilityInfo> {
  const ids = [...new Set(items.map((i) => i.tmdbId))];
  const rows = ids.length
    ? ctx.db
        .select({ tmdbId: libraryItems.tmdbId, server: libraryItems.server, resolution: libraryItems.resolution, id: libraryItems.id })
        .from(libraryItems)
        .where(and(eq(libraryItems.kind, kind), inArray(libraryItems.tmdbId, ids)))
        .all()
    : [];
  const mediaRows = ids.length
    ? ctx.db.select().from(media).where(and(eq(media.kind, kind), inArray(media.tmdbId, ids))).all()
    : [];
  const out = new Map<number, AvailabilityInfo>();
  for (const item of items) {
    const found = rows.filter((r) => r.tmdbId === item.tmdbId);
    const m = mediaRows.find((r) => r.tmdbId === item.tmdbId);
    if (found.length) {
      let resolution = bestResolution(found.map((f) => f.resolution));
      if (kind === 'show') {
        const eps = ctx.db
          .select({ resolution: libraryEpisodes.resolution })
          .from(libraryEpisodes)
          .where(inArray(libraryEpisodes.libraryItemId, found.map((f) => f.id)))
          .all();
        resolution = bestResolution(eps.map((e) => e.resolution));
      }
      out.set(item.tmdbId, { status: 'on_server', resolution, servers: [...new Set(found.map((f) => f.server))] });
    } else {
      const released = isReleased(kind, { releaseDate: m?.releaseDate ?? item.releaseDate, digitalRelease: m?.digitalRelease, physicalRelease: m?.physicalRelease });
      out.set(item.tmdbId, { status: released ? 'not_on_server' : 'not_available', resolution: null, servers: [] });
    }
  }
  return out;
}

/** Episodes on any server for a show, keyed "season:episode". */
export function episodesOnServer(ctx: AppContext, tmdbId: number): Map<string, { resolution: string | null; servers: ServerType[]; viewCount: number | null; lastViewedAt: number | null }> {
  const items = ctx.db.select().from(libraryItems).where(and(eq(libraryItems.kind, 'show'), eq(libraryItems.tmdbId, tmdbId))).all();
  const map = new Map<string, { resolution: string | null; servers: ServerType[]; viewCount: number | null; lastViewedAt: number | null }>();
  for (const item of items) {
    const eps = ctx.db.select().from(libraryEpisodes).where(eq(libraryEpisodes.libraryItemId, item.id)).all();
    for (const e of eps) {
      const k = `${e.season}:${e.episode}`;
      const prev = map.get(k);
      map.set(k, {
        resolution: bestResolution([prev?.resolution ?? null, e.resolution]),
        servers: [...new Set([...(prev?.servers ?? []), item.server])],
        // Watched on either server counts; plays are added up across them.
        viewCount: e.viewCount === null && !prev ? null : (prev?.viewCount ?? 0) + (e.viewCount ?? 0),
        lastViewedAt: Math.max(prev?.lastViewedAt ?? 0, e.lastViewedAt ?? 0) || null,
      });
    }
  }
  return map;
}

/**
 * Whether every aired episode of the seasons a show request asked for is on a server (or imported), so the request
 * isn't called ready while only last year's season is there (or before the season has aired). Without an episode
 * list to go by, the show being on a server is enough, as before.
 */
export function requestedEpisodesHere(ctx: AppContext, r: typeof requests.$inferSelect): boolean {
  if (r.monitoredId === null) return true;
  const asked = r.seasons ? new Set(JSON.parse(r.seasons) as number[]) : null;
  const day = today();
  const episodes = ctx.db.select().from(monitoredEpisodes).where(eq(monitoredEpisodes.monitoredId, r.monitoredId)).all();
  if (!episodes.length) return true;
  // A season that hasn't aired yet isn't ready either.
  const aired = episodes.filter((e) => e.season > 0 && (!asked || asked.has(e.season)) && e.airDate !== null && e.airDate <= day);
  if (!aired.length) return false;
  const here = episodesOnServer(ctx, r.tmdbId);
  return aired.every((e) => e.filePath || here.has(`${e.season}:${e.episode}`));
}

export function toCard(kind: MediaKind, r: TmdbSearchResult) {
  return {
    kind,
    tmdbId: r.id,
    title: r.title ?? r.name ?? '',
    year: (r.release_date ?? r.first_air_date ?? '').slice(0, 4) || null,
    releaseDate: r.release_date ?? r.first_air_date ?? null,
    posterPath: r.poster_path ?? null,
    backdropPath: r.backdrop_path ?? null,
    overview: r.overview ?? '',
    rating: r.vote_average ?? null,
  };
}

export type Card = ReturnType<typeof toCard> & { availability: AvailabilityInfo };

/** Converts TMDB results into cards annotated with server availability. */
export function cards(ctx: AppContext, results: TmdbSearchResult[], fixedKind?: MediaKind): Card[] {
  const typed = results
    .map((r) => {
      const kind: MediaKind | null = fixedKind ?? (r.media_type === 'movie' ? 'movie' : r.media_type === 'tv' ? 'show' : null);
      return kind ? toCard(kind, r) : null;
    })
    .filter((c): c is ReturnType<typeof toCard> => c !== null);
  const out: Card[] = [];
  for (const kind of ['movie', 'show'] as const) {
    const ofKind = typed.filter((c) => c.kind === kind);
    const avail = availabilityFor(ctx, kind, ofKind);
    for (const c of ofKind) out.push({ ...c, availability: avail.get(c.tmdbId)! });
  }
  // Keep TMDB's ordering.
  return typed.map((c) => out.find((o) => o.kind === c.kind && o.tmdbId === c.tmdbId)!);
}

export interface SyncStatus {
  running: boolean;
  lastRunAt: number | null;
  results: Partial<Record<ServerType, { ok: boolean; movies?: number; shows?: number; episodes?: number; error?: string }>>;
  /** Titles the last sync started monitoring (Settings → Media servers → Monitor what's found). */
  autoMonitored?: number;
}

export class LibrarySync {
  status: SyncStatus = { running: false, lastRunAt: null, results: {} };

  private soon: NodeJS.Timeout | null = null;

  constructor(private readonly ctx: AppContext) {}

  /** Syncs once, a little later: media servers take a moment to pick up new files. Repeated calls wait for the last. */
  runSoon(delayMs = 2 * 60 * 1000) {
    if (!this.ctx.settings.get('library').syncEnabled) return;
    this.cancelSoon();
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.run().catch(() => undefined);
    }, delayMs);
    this.soon.unref();
  }

  cancelSoon() {
    if (this.soon) clearTimeout(this.soon);
    this.soon = null;
  }

  async run(): Promise<SyncStatus> {
    if (this.status.running) return this.status;
    this.status.running = true;
    try {
      for (const { server, client } of mediaServers(this.ctx)) {
        try {
          const items = await client.fetchLibrary();
          await this.resolveMissingTmdbIds(items);
          this.store(server, items);
          this.status.results[server] = {
            ok: true,
            movies: items.filter((i) => i.kind === 'movie').length,
            shows: items.filter((i) => i.kind === 'show').length,
            episodes: items.reduce((n, i) => n + (i.episodes?.length ?? 0), 0),
          };
        } catch (err) {
          this.status.results[server] = { ok: false, error: (err as Error).message };
        }
      }
      this.status.lastRunAt = Date.now();
      this.markRequestsAvailable();
      // Imported lazily: arr/monitor uses this module too.
      const { monitorLibrary } = await import('../arr/monitor.js');
      this.status.autoMonitored = await monitorLibrary(this.ctx).catch(() => 0);
      // Titles moved between libraries on the server (Movies → Kids Movies) keep their new folder.
      const { followMovedFolders } = await import('../files/service.js');
      followMovedFolders(this.ctx);
      return this.status;
    } finally {
      this.status.running = false;
      // New titles, and requests that became available, show up in open tabs without a refresh.
      this.ctx.live.publish({ topic: 'library', access: 'user' });
      this.ctx.live.publish({ topic: 'requests', access: 'user' });
    }
  }

  /** Approved requests whose title is now on a server are marked available. */
  private markRequestsAvailable() {
    const approved = this.ctx.db.select().from(requests).where(eq(requests.status, 'approved')).all();
    for (const r of approved) {
      const status = availabilityFor(this.ctx, r.kind, [{ tmdbId: r.tmdbId }]).get(r.tmdbId)!.status;
      if (status !== 'on_server') continue;
      if (r.kind === 'show' && !requestedEpisodesHere(this.ctx, r)) continue;
      this.ctx.db.update(requests).set({ status: 'available' }).where(eq(requests.id, r.id)).run();
      requestAvailable(this.ctx, r);
    }
  }

  /** Items matched by IMDb or TVDB id only (older Plex agents) get their TMDB id looked up. */
  private async resolveMissingTmdbIds(items: ServerItem[]) {
    const tmdb = tmdbClient(this.ctx);
    if (!tmdb.configured) return;
    for (const item of items.filter((i) => !i.tmdbId && (i.imdbId || i.tvdbId))) {
      try {
        const found = item.imdbId ? await tmdb.findByExternal(item.imdbId, 'imdb_id') : await tmdb.findByExternal(String(item.tvdbId), 'tvdb_id');
        const hit = item.kind === 'movie' ? found.movie_results[0] : found.tv_results[0];
        if (hit) item.tmdbId = hit.id;
      } catch {
        // Leave unmatched; it still shows in the library by title.
      }
    }
  }

  /** Replaces everything known about one server in a single transaction. */
  store(server: ServerType, items: ServerItem[]) {
    const { sqlite } = this.ctx.dbHandle;
    // Titles fixed by hand (wrong match on the server) keep the TMDB id they were given.
    const overrides = new Map(this.ctx.db.select().from(matchOverrides).where(eq(matchOverrides.server, server)).all().map((o) => [o.externalKey, o.tmdbId]));
    for (const item of items) if (overrides.has(item.externalKey)) item.tmdbId = overrides.get(item.externalKey)!;
    sqlite.transaction(() => {
      this.ctx.db.delete(libraryItems).where(eq(libraryItems.server, server)).run();
      for (const item of items) {
        const mediaId = item.tmdbId ? ensureMedia(this.ctx, item.kind, item.tmdbId, item) : null;
        const row = this.ctx.db
          .insert(libraryItems)
          .values({
            server,
            externalKey: item.externalKey,
            kind: item.kind,
            title: item.title,
            year: item.year,
            tmdbId: item.tmdbId,
            tvdbId: item.tvdbId,
            imdbId: item.imdbId,
            // A show's quality is its best episode's.
            resolution: item.kind === 'show' ? bestResolution((item.episodes ?? []).map((e) => e.resolution)) : item.resolution,
            addedAt: item.addedAt,
            mediaId,
            viewCount: item.viewCount ?? null,
            lastViewedAt: item.lastViewedAt ?? null,
            labels: item.labels?.length ? JSON.stringify(item.labels) : null,
            library: item.library ?? null,
          })
          .onConflictDoNothing()
          .returning({ id: libraryItems.id })
          .get();
        if (row && item.episodes?.length) {
          for (const e of item.episodes) {
            this.ctx.db
              .insert(libraryEpisodes)
              .values({ libraryItemId: row.id, season: e.season, episode: e.episode, title: e.title, resolution: e.resolution, viewCount: e.viewCount ?? null, lastViewedAt: e.lastViewedAt ?? null })
              .run();
          }
        }
      }
    })();
  }

  /**
   * Fills TMDB details (posters, overview, rating) for library titles that have none yet. Works through
   * all of them in batches, a few at a time, up to `limit`; a title that fails is skipped for the rest
   * of the run so it can't hold up the others, and is tried again next run.
   */
  async backfillMetadata(limit = 5000) {
    if (!tmdbClient(this.ctx).configured) return 0;
    const tried = new Set<number>();
    let filled = 0;
    while (tried.size < limit) {
      const batch = this.ctx.db
        .select()
        .from(media)
        // Titles from before age ratings were kept are looked up again once, for kids profiles.
        .where(and(or(isNull(media.metadataUpdatedAt), isNull(media.certification)), tried.size ? notInArray(media.id, [...tried]) : undefined))
        .limit(Math.min(8, limit - tried.size))
        .all();
      if (!batch.length) break;
      for (const m of batch) tried.add(m.id);
      const results = await Promise.allSettled(batch.map((m) => refreshMetadata(this.ctx, m.kind, m.tmdbId, m.certification === null)));
      filled += results.filter((r) => r.status === 'fulfilled').length;
    }
    return filled;
  }
}

/** How often a title was played on the servers (by their own accounts), and when last. Null when no server says. */
export function watchInfo(ctx: AppContext, kind: MediaKind, tmdbId: number): { viewCount: number; lastViewedAt: number | null } | null {
  const rows = ctx.db.select({ v: libraryItems.viewCount, l: libraryItems.lastViewedAt }).from(libraryItems).where(and(eq(libraryItems.kind, kind), eq(libraryItems.tmdbId, tmdbId))).all();
  const known = rows.filter((r) => r.v !== null);
  if (!known.length) return null;
  return { viewCount: known.reduce((n, r) => n + (r.v ?? 0), 0), lastViewedAt: Math.max(...known.map((r) => r.l ?? 0)) || null };
}
