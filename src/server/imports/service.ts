import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { monitored, requests, users, type MediaKind } from '../db/schema.js';
import { fetchJson } from '../integrations/http.js';
import { refreshMetadata, tmdbClient } from '../library/service.js';
import { monitorTitle } from '../arr/monitor.js';
import { defaultProfileId, listProfiles } from '../arr/profiles.js';
import { scanFolder } from '../files/service.js';

export const IMPORT_SOURCES = ['radarr', 'sonarr', 'overseerr'] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export interface ImportProgress {
  source: ImportSource;
  running: boolean;
  total: number;
  done: number;
  added: number;
  skipped: number;
  errors: string[];
  startedAt: number;
  finishedAt: number | null;
}

/** The last run of each import, kept in memory so the settings page can show progress. */
export const importRuns = new Map<ImportSource, ImportProgress>();

const base = (url: string) => url.replace(/\/+$/, '');

function connection(ctx: AppContext, source: ImportSource) {
  const s = ctx.settings.get(source);
  if (!s.url || !s.apiKey) throw new Error(`Enter the ${NAMES[source]} address and API key first`);
  return { url: base(s.url), headers: { 'X-Api-Key': s.apiKey } };
}

const NAMES: Record<ImportSource, string> = { radarr: 'Radarr', sonarr: 'Sonarr', overseerr: 'Overseerr' };

function api<T>(ctx: AppContext, source: ImportSource, path: string, timeoutMs = 60_000): Promise<T> {
  const c = connection(ctx, source);
  return fetchJson<T>(NAMES[source], `${c.url}${path}`, { headers: c.headers }, timeoutMs);
}

export async function testImport(ctx: AppContext, source: ImportSource): Promise<string> {
  if (source === 'overseerr') {
    const s = await api<{ version: string }>(ctx, source, '/api/v1/status');
    const n = await api<{ pageInfo: { results: number } }>(ctx, source, '/api/v1/request?take=1');
    return `Connected to Overseerr ${s.version}: ${n.pageInfo.results} requests`;
  }
  const s = await api<{ version: string }>(ctx, source, '/api/v3/system/status');
  return `Connected to ${NAMES[source]} ${s.version}`;
}

interface ArrProfile {
  id: number;
  name: string;
}
interface RadarrMovie {
  title: string;
  year?: number;
  tmdbId?: number;
  monitored: boolean;
  qualityProfileId: number;
}
interface SonarrSeries {
  title: string;
  year?: number;
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
  monitored: boolean;
  qualityProfileId: number;
  seasons?: { seasonNumber: number; monitored: boolean }[];
}

/** A Cinemask profile with the same name as the Radarr/Sonarr one, or the default. */
function profileFor(ctx: AppContext, kind: MediaKind, arrProfiles: ArrProfile[], id: number): number {
  const name = arrProfiles.find((p) => p.id === id)?.name.toLowerCase();
  return listProfiles(ctx).find((p) => p.name.toLowerCase() === name)?.id ?? defaultProfileId(ctx, kind);
}

/** Runs an import in the background; progress is in importRuns. Only one per source at a time. */
export function startImport(ctx: AppContext, source: ImportSource, userId: number): ImportProgress {
  const current = importRuns.get(source);
  if (current?.running) return current;
  connection(ctx, source); // fail fast when it isn't set up
  const run: ImportProgress = { source, running: true, total: 0, done: 0, added: 0, skipped: 0, errors: [], startedAt: Date.now(), finishedAt: null };
  importRuns.set(source, run);
  const job = source === 'radarr' ? importRadarr : source === 'sonarr' ? importSonarr : importOverseerr;
  void job(ctx, run, userId)
    .catch((err: Error) => run.errors.push(err.message))
    .finally(() => {
      run.running = false;
      run.finishedAt = Date.now();
    });
  return run;
}

const note = (run: ImportProgress, title: string, err: unknown) => {
  if (run.errors.length < 50) run.errors.push(`${title}: ${(err as Error).message}`);
};

/**
 * Every Radarr movie becomes a monitored movie with the matching quality profile (by name).
 * Files are found where they already are, in any Cinemask movie folder; nothing is downloaded.
 */
export async function importRadarr(ctx: AppContext, run: ImportProgress, userId: number) {
  const [movies, profiles] = await Promise.all([api<RadarrMovie[]>(ctx, 'radarr', '/api/v3/movie', 300_000), api<ArrProfile[]>(ctx, 'radarr', '/api/v3/qualityprofile')]);
  run.total = movies.length;
  for (const m of movies) {
    try {
      if (!m.tmdbId) {
        run.skipped++;
        continue;
      }
      const row = await monitorTitle(ctx, { kind: 'movie', tmdbId: m.tmdbId, profileId: profileFor(ctx, 'movie', profiles, m.qualityProfileId), addedBy: userId });
      if (!m.monitored) ctx.db.update(monitored).set({ monitored: false }).where(eq(monitored.id, row.id)).run();
      scanFolder(ctx, ctx.db.select().from(monitored).where(eq(monitored.id, row.id)).get()!);
      run.added++;
    } catch (err) {
      note(run, m.title, err);
    } finally {
      run.done++;
    }
  }
}

/** Every Sonarr series becomes a monitored show, keeping which seasons were monitored. */
export async function importSonarr(ctx: AppContext, run: ImportProgress, userId: number) {
  const [series, profiles] = await Promise.all([api<SonarrSeries[]>(ctx, 'sonarr', '/api/v3/series', 300_000), api<ArrProfile[]>(ctx, 'sonarr', '/api/v3/qualityprofile')]);
  run.total = series.length;
  const tmdb = tmdbClient(ctx);
  for (const s of series) {
    try {
      // Sonarr v4 knows the TMDB id; older versions only have TVDB and IMDb ids.
      let tmdbId = s.tmdbId || null;
      if (!tmdbId && s.tvdbId) tmdbId = (await tmdb.findByExternal(String(s.tvdbId), 'tvdb_id')).tv_results?.[0]?.id ?? null;
      if (!tmdbId && s.imdbId) tmdbId = (await tmdb.findByExternal(s.imdbId, 'imdb_id')).tv_results?.[0]?.id ?? null;
      if (!tmdbId) {
        run.skipped++;
        continue;
      }
      const seasons = s.seasons?.filter((x) => x.seasonNumber > 0);
      const picked = seasons?.filter((x) => x.monitored).map((x) => x.seasonNumber) ?? [];
      const row = await monitorTitle(ctx, {
        kind: 'show',
        tmdbId,
        profileId: profileFor(ctx, 'show', profiles, s.qualityProfileId),
        // Every season monitored means future seasons too.
        seasons: !seasons?.length || picked.length === seasons.length ? null : picked,
        addedBy: userId,
      });
      if (!s.monitored) ctx.db.update(monitored).set({ monitored: false }).where(eq(monitored.id, row.id)).run();
      scanFolder(ctx, ctx.db.select().from(monitored).where(eq(monitored.id, row.id)).get()!);
      run.added++;
    } catch (err) {
      note(run, s.title, err);
    } finally {
      run.done++;
    }
  }
}

interface OverseerrUser {
  email?: string;
  username?: string | null;
  plexUsername?: string | null;
  displayName?: string;
}
interface OverseerrRequest {
  id: number;
  status: number; // 1 pending, 2 approved, 3 declined
  type: 'movie' | 'tv';
  createdAt: string;
  media: { tmdbId: number; status: number }; // media status 5 = available
  seasons?: { seasonNumber: number }[];
  requestedBy?: OverseerrUser;
  modifiedBy?: OverseerrUser | null;
}

/**
 * Overseerr requests become Cinemask requests, kept with their status and who asked (matched to a
 * Cinemask user by email or username). Approved requests are not searched for again.
 */
export async function importOverseerr(ctx: AppContext, run: ImportProgress) {
  const all: OverseerrRequest[] = [];
  for (let skip = 0; skip < 20_000; skip += 100) {
    const page = await api<{ pageInfo: { results: number }; results: OverseerrRequest[] }>(ctx, 'overseerr', `/api/v1/request?take=100&skip=${skip}&sort=added`);
    all.push(...page.results);
    run.total = page.pageInfo.results;
    if (page.results.length < 100) break;
  }
  run.total = all.length;
  for (const r of all) {
    const kind: MediaKind = r.type === 'movie' ? 'movie' : 'show';
    const tmdbId = r.media?.tmdbId;
    try {
      if (!tmdbId || ![1, 2, 3].includes(r.status)) {
        run.skipped++;
        continue;
      }
      const status = r.status === 1 ? 'pending' : r.status === 3 ? 'declined' : r.media.status === 5 ? 'available' : 'approved';
      // The same title asked for again stays one request.
      const open = ctx.db
        .select()
        .from(requests)
        .where(and(eq(requests.kind, kind), eq(requests.tmdbId, tmdbId), inArray(requests.status, status === 'declined' ? ['declined'] : ['pending', 'approved', 'available'])))
        .get();
      if (open) {
        run.skipped++;
        continue;
      }
      const meta = await refreshMetadata(ctx, kind, tmdbId);
      if (!meta) throw new Error('not found on TMDB');
      const who = matchUser(ctx, r.requestedBy);
      const mon = ctx.db.select().from(monitored).where(and(eq(monitored.kind, kind), eq(monitored.tmdbId, tmdbId))).get();
      const seasons = r.seasons?.map((s) => s.seasonNumber).filter((n) => n > 0) ?? [];
      ctx.db
        .insert(requests)
        .values({
          kind,
          tmdbId,
          title: meta.title,
          year: meta.year,
          posterPath: meta.posterPath,
          seasons: kind === 'show' && seasons.length ? JSON.stringify(seasons) : null,
          status,
          requestedBy: who?.id ?? null,
          requestedByName: who ? who.displayName || who.username : userLabel(r.requestedBy),
          decidedByName: status === 'pending' ? null : userLabel(r.modifiedBy ?? undefined) || 'Overseerr',
          decidedAt: status === 'pending' ? null : Date.parse(r.createdAt) || Date.now(),
          monitoredId: mon?.id ?? null,
          createdAt: Date.parse(r.createdAt) || Date.now(),
        })
        .run();
      run.added++;
    } catch (err) {
      note(run, `${kind} ${tmdbId}`, err);
    } finally {
      run.done++;
    }
  }
}

const userLabel = (u?: OverseerrUser) => (u ? u.displayName || u.plexUsername || u.username || u.email || 'Overseerr user' : 'Overseerr user');

function matchUser(ctx: AppContext, u?: OverseerrUser) {
  if (!u) return null;
  const names = [u.username, u.plexUsername].filter((x): x is string => Boolean(x)).map((x) => x.toLowerCase());
  const email = u.email?.toLowerCase();
  const conds = [
    ...(names.length ? [inArray(sql`lower(${users.username})`, names)] : []),
    ...(email ? [eq(sql`lower(${users.email})`, email)] : []),
  ];
  if (!conds.length) return null;
  return ctx.db.select().from(users).where(or(...conds)).get() ?? null;
}
