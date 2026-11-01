import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { monitored, monitorExclusions, users } from '../db/schema.js';
import { fetchJson } from '../integrations/http.js';
import { listProfiles } from '../arr/profiles.js';
import { audit } from '../audit/log.js';
import { importOverseerr, importRadarr, importRuns, importSonarr, type ImportProgress, type ImportSource } from './service.js';

/**
 * Moving over in one pass: a dry run that says what each source would bring (and what has to be
 * set up by hand), then one run that does Overseerr's users, Radarr, Sonarr and Overseerr's
 * requests in that order, so requests find their users and titles.
 */

const NAMES: Record<ImportSource, string> = { radarr: 'Radarr', sonarr: 'Sonarr', overseerr: 'Overseerr' };

function configured(ctx: AppContext, source: ImportSource) {
  const s = ctx.settings.get(source);
  return s.url && s.apiKey ? { url: s.url.replace(/\/+$/, ''), apiKey: s.apiKey } : null;
}

function get<T>(ctx: AppContext, source: ImportSource, path: string): Promise<T> {
  const c = configured(ctx, source)!;
  return fetchJson<T>(NAMES[source], `${c.url}${path}`, { headers: { 'X-Api-Key': c.apiKey } }, 300_000);
}

interface ArrNamed {
  id: number;
  name: string;
}
interface ArrClient extends ArrNamed {
  implementation: string;
  enable: boolean;
  protocol?: string;
}
interface ArrIndexer extends ArrNamed {
  implementation: string;
  enableRss?: boolean;
  protocol?: string;
}

export interface OverseerrUserFull {
  id: number;
  email?: string;
  username?: string | null;
  plexUsername?: string | null;
  plexId?: number | null;
  displayName?: string;
  movieQuotaLimit?: number | null;
  tvQuotaLimit?: number | null;
}

async function overseerrUsers(ctx: AppContext): Promise<OverseerrUserFull[]> {
  const all: OverseerrUserFull[] = [];
  for (let skip = 0; skip < 10_000; skip += 100) {
    const page = await get<{ results: OverseerrUserFull[] }>(ctx, 'overseerr', `/api/v1/user?take=100&skip=${skip}`);
    all.push(...page.results);
    if (page.results.length < 100) break;
  }
  return all;
}

/** The Cinemask user an Overseerr user already is: same Plex account, email or username. */
function matchUser(ctx: AppContext, u: OverseerrUserFull) {
  const names = [u.username, u.plexUsername].filter((x): x is string => Boolean(x)).map((x) => x.toLowerCase());
  const conds = [
    ...(u.plexId ? [eq(users.plexId, String(u.plexId))] : []),
    ...(u.email ? [eq(sql`lower(${users.email})`, u.email.toLowerCase())] : []),
    ...(names.length ? [inArray(sql`lower(${users.username})`, names)] : []),
  ];
  return conds.length ? (ctx.db.select().from(users).where(or(...conds)).get() ?? null) : null;
}

const usernameFor = (u: OverseerrUserFull) =>
  (u.plexUsername || u.username || u.email?.split('@')[0] || `overseerr-${u.id}`)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 40) || `overseerr-${u.id}`;

interface SourcePlan {
  source: ImportSource;
  name: string;
  configured: boolean;
  error?: string;
  /** Titles or requests the import would add, bring in line, or leave out. */
  add?: number;
  update?: number;
  skip?: number;
  /** Their quality profiles and the Cinemask profile each one maps to (by name, or the default). */
  profiles?: { name: string; mapsTo: string | null }[];
  /** Set up by hand: their keys and passwords can't be read back from the API. */
  manual?: string[];
  users?: { create: string[]; existing: string[] };
}

/** What a one-pass migration would do, changing nothing. */
export async function migrationPlan(ctx: AppContext): Promise<SourcePlan[]> {
  const ours = listProfiles(ctx);
  const mapProfiles = (theirs: ArrNamed[]) => theirs.map((p) => ({ name: p.name, mapsTo: ours.find((o) => o.name.toLowerCase() === p.name.toLowerCase())?.name ?? null }));
  const have = (kind: 'movie' | 'show', ids: number[]) => {
    if (!ids.length) return { existing: new Set<number>(), excluded: new Set<number>() };
    const existing = new Set(ctx.db.select({ id: monitored.tmdbId }).from(monitored).where(and(eq(monitored.kind, kind), inArray(monitored.tmdbId, ids))).all().map((r) => r.id));
    const excluded = new Set(ctx.db.select({ id: monitorExclusions.tmdbId }).from(monitorExclusions).where(and(eq(monitorExclusions.kind, kind), inArray(monitorExclusions.tmdbId, ids))).all().map((r) => r.id));
    return { existing, excluded };
  };
  const manualOf = async (source: 'radarr' | 'sonarr') => {
    const [clients, idx] = await Promise.all([get<ArrClient[]>(ctx, source, '/api/v3/downloadclient').catch(() => []), get<ArrIndexer[]>(ctx, source, '/api/v3/indexer').catch(() => [])]);
    return [
      ...clients.filter((c) => c.enable).map((c) => `Download client "${c.name}" (${c.implementation}): add it in Settings → Download clients`),
      ...(idx.length ? [`${idx.length} indexer${idx.length === 1 ? '' : 's'} (${idx.slice(0, 5).map((i) => i.name).join(', ')}${idx.length > 5 ? '…' : ''}): connect Prowlarr in Settings → Indexers, or add them there`] : []),
    ];
  };

  const out: SourcePlan[] = [];
  for (const source of ['radarr', 'sonarr', 'overseerr'] as const) {
    const p: SourcePlan = { source, name: NAMES[source], configured: Boolean(configured(ctx, source)) };
    out.push(p);
    if (!p.configured) continue;
    try {
      if (source === 'radarr') {
        const [movies, profiles] = await Promise.all([get<{ tmdbId?: number }[]>(ctx, source, '/api/v3/movie'), get<ArrNamed[]>(ctx, source, '/api/v3/qualityprofile')]);
        const ids = movies.map((m) => m.tmdbId).filter((x): x is number => Boolean(x));
        const h = have('movie', ids);
        p.skip = movies.length - ids.length + ids.filter((i) => h.excluded.has(i)).length;
        p.update = ids.filter((i) => h.existing.has(i) && !h.excluded.has(i)).length;
        p.add = ids.length - p.update - ids.filter((i) => h.excluded.has(i)).length;
        p.profiles = mapProfiles(profiles);
        p.manual = await manualOf(source);
      } else if (source === 'sonarr') {
        const [series, profiles] = await Promise.all([get<{ tmdbId?: number; tvdbId?: number }[]>(ctx, source, '/api/v3/series'), get<ArrNamed[]>(ctx, source, '/api/v3/qualityprofile')]);
        // Shows with only a TVDB id are looked up on TMDB during the import; they count as new here.
        const ids = series.map((s) => s.tmdbId).filter((x): x is number => Boolean(x));
        const h = have('show', ids);
        p.update = ids.filter((i) => h.existing.has(i) && !h.excluded.has(i)).length;
        p.skip = ids.filter((i) => h.excluded.has(i)).length + series.filter((s) => !s.tmdbId && !s.tvdbId).length;
        p.add = series.length - p.update - p.skip;
        p.profiles = mapProfiles(profiles);
        p.manual = await manualOf(source);
      } else {
        const people = await overseerrUsers(ctx);
        const create: string[] = [];
        const existing: string[] = [];
        for (const u of people) (matchUser(ctx, u) ? existing : create).push(u.displayName || u.plexUsername || u.username || u.email || `#${u.id}`);
        p.users = { create, existing };
        const first = await get<{ pageInfo: { results: number } }>(ctx, source, '/api/v1/request?take=1');
        p.add = first.pageInfo.results;
        p.manual = ['Notification agents and Overseerr settings: set them up in Settings → Notifications and Settings → Requests'];
      }
    } catch (err) {
      p.error = (err as Error).message;
    }
  }
  return out;
}

/**
 * Overseerr users become Cinemask users (role "user", no password) so their requests keep their
 * owner. With their Plex account linked they sign in with Plex; their request limits come along.
 */
export async function importOverseerrUsers(ctx: AppContext): Promise<{ created: number; existing: number }> {
  let created = 0;
  let existing = 0;
  for (const u of await overseerrUsers(ctx)) {
    const found = matchUser(ctx, u);
    if (found) {
      existing++;
      // Link the Plex account when nobody has it yet, so Plex sign-in finds them.
      if (u.plexId && !found.plexId && !ctx.db.select().from(users).where(eq(users.plexId, String(u.plexId))).get()) ctx.db.update(users).set({ plexId: String(u.plexId) }).where(and(eq(users.id, found.id), isNull(users.plexId))).run();
      continue;
    }
    let name = usernameFor(u);
    for (let n = 2; ctx.db.select().from(users).where(eq(users.username, name)).get(); n++) name = `${usernameFor(u).slice(0, 36)}-${n}`;
    ctx.db
      .insert(users)
      .values({
        username: name,
        displayName: u.displayName || null,
        email: u.email || null,
        role: 'user',
        plexId: u.plexId ? String(u.plexId) : null,
        createdAt: Date.now(),
        movieRequestLimit: u.movieQuotaLimit ?? null,
        seasonRequestLimit: u.tvQuotaLimit ?? null,
      })
      .run();
    created++;
  }
  return { created, existing };
}

export interface MigrationRun {
  running: boolean;
  step: string;
  steps: { source: string; result: string }[];
  startedAt: number;
  finishedAt: number | null;
}

let migration: MigrationRun | null = null;
export const migrationStatus = () => migration;

/** Runs every configured source in order. Each source's own progress shows as usual. */
export function startMigration(ctx: AppContext, userId: number): MigrationRun {
  if (migration?.running) return migration;
  const run: MigrationRun = { running: true, step: '', steps: [], startedAt: Date.now(), finishedAt: null };
  migration = run;
  const each = async (source: ImportSource, job: (ctx: AppContext, r: ImportProgress, userId: number) => Promise<void>) => {
    if (!configured(ctx, source)) return;
    run.step = NAMES[source];
    const r: ImportProgress = { source, running: true, total: 0, done: 0, added: 0, updated: 0, skipped: 0, errors: [], startedAt: Date.now(), finishedAt: null };
    importRuns.set(source, r);
    try {
      await job(ctx, r, userId);
    } catch (err) {
      r.errors.push((err as Error).message);
    }
    r.running = false;
    r.finishedAt = Date.now();
    run.steps.push({ source: NAMES[source], result: `${r.added} added, ${r.updated} updated, ${r.skipped} skipped${r.errors.length ? `, ${r.errors.length} with problems` : ''}` });
  };
  void (async () => {
    if (configured(ctx, 'overseerr')) {
      run.step = 'Overseerr users';
      try {
        const u = await importOverseerrUsers(ctx);
        run.steps.push({ source: 'Overseerr users', result: `${u.created} created, ${u.existing} already here` });
      } catch (err) {
        run.steps.push({ source: 'Overseerr users', result: (err as Error).message });
      }
    }
    await each('radarr', importRadarr);
    await each('sonarr', importSonarr);
    await each('overseerr', (c, r) => importOverseerr(c, r));
    audit(ctx.db, null, 'import.migration_finished', { user: null, details: { steps: run.steps } });
  })().finally(() => {
    run.running = false;
    run.step = '';
    run.finishedAt = Date.now();
  });
  return run;
}
