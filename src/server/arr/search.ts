import { and, asc, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { blocklist, downloadClients, downloads, indexers, monitored, monitoredEpisodes, type DownloadClientType } from '../db/schema.js';
import { media } from '../db/schema.js';
import { bestDecision, byPreference, decide, type DecideOptions, type Decision, type Target } from './decision.js';
import { createClient } from './clients.js';
import { CATEGORIES, searchIndexer, type IndexerConfig, type Release, type SearchQuery } from './indexers.js';
import { wantedTarget, type MonitoredRow, type SearchFilter } from './monitor.js';
import { searchProfile } from './profiles.js';
import { parseRelease, titlesMatch } from './parser.js';
import { openSecret, sealSecret } from './secrets.js';
import { rootOf } from './roots.js';
import { notify } from '../notify/service.js';

export function enabledIndexers(ctx: AppContext): IndexerConfig[] {
  return ctx.db
    .select()
    .from(indexers)
    .where(eq(indexers.enabled, true))
    .orderBy(asc(indexers.priority))
    .all()
    .map((i) => ({ id: i.id, name: i.name, type: i.type, url: i.url, apiKey: openSecret(ctx, i.apiKey), categories: JSON.parse(i.categories) as number[] }));
}

/** Searches every enabled indexer in parallel. One failing indexer doesn't stop the others. */
export async function searchAll(ctx: AppContext, query: SearchQuery): Promise<{ releases: Release[]; errors: string[] }> {
  const results = await Promise.allSettled(enabledIndexers(ctx).map((i) => searchIndexer(i, query)));
  const releases: Release[] = [];
  const errors: string[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') releases.push(...r.value);
    else errors.push((r.reason as Error).message);
  }
  // The same release often comes from several indexers; keep the first (highest priority).
  const seen = new Set<string>();
  return { releases: releases.filter((r) => (seen.has(r.title) ? false : (seen.add(r.title), true))), errors };
}

function blocked(ctx: AppContext, monitoredId: number): Set<string> {
  return new Set(ctx.db.select({ t: blocklist.releaseTitle }).from(blocklist).where(eq(blocklist.monitoredId, monitoredId)).all().map((r) => r.t));
}

/** Releases already sent to a client for this title, so the same thing isn't grabbed twice. */
function activeDownloads(ctx: AppContext, monitoredId: number) {
  return ctx.db
    .select()
    .from(downloads)
    .where(and(eq(downloads.monitoredId, monitoredId), inArray(downloads.status, ['held', 'queued', 'downloading', 'paused', 'completed', 'importing'])))
    .all();
}

function queriesFor(ctx: AppContext, row: MonitoredRow, target: Target): SearchQuery[] {
  const m = ctx.db.select().from(media).where(and(eq(media.kind, row.kind), eq(media.tmdbId, row.tmdbId))).get();
  if (row.kind === 'movie') {
    return [
      { type: 'movie', imdbId: m?.imdbId, tmdbId: row.tmdbId, categories: CATEGORIES.movies },
      { type: 'search', q: `${row.title} ${row.year ?? ''}`.trim(), categories: CATEGORIES.movies },
    ];
  }
  const seasons = [...new Set((target.episodes ?? []).map((e) => e.season))];
  return seasons.flatMap((season) => {
    const eps = (target.episodes ?? []).filter((e) => e.season === season);
    const base = { type: 'tvsearch' as const, q: row.title, tvdbId: m?.tvdbId, categories: CATEGORIES.tv };
    // Ask for single episodes when only a few are missing; otherwise ask for the season (catches packs too).
    return eps.length <= 2 ? eps.map((e) => ({ ...base, season, episode: e.episode })) : [{ ...base, season }];
  });
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** The show's usual episode length in minutes, from TMDB, or null when unknown. */
function episodeMinutes(ctx: AppContext, tmdbId: number): number | null {
  return ctx.db.select({ r: media.runtime }).from(media).where(and(eq(media.kind, 'show'), eq(media.tmdbId, tmdbId))).get()?.r ?? null;
}

/**
 * Largest wanted release for a title in bytes (per movie or per episode), or null for no limit.
 * The title's own limit wins; then, for episodes, the runtime table; then the flat setting.
 */
export function maxSizeFor(ctx: AppContext, row: Pick<MonitoredRow, 'kind' | 'maxSizeMb' | 'tmdbId'>): number | null {
  if (row.maxSizeMb !== null && row.maxSizeMb !== undefined) return row.maxSizeMb ? row.maxSizeMb * MB : null;
  const s = ctx.settings.get('downloading');
  if (row.kind === 'show' && s.episodeSizeByRuntime.length) {
    const minutes = episodeMinutes(ctx, row.tmdbId);
    if (minutes) {
      const tiers = [...s.episodeSizeByRuntime].sort((a, b) => a.minutes - b.minutes);
      return (tiers.find((t) => minutes <= t.minutes) ?? tiers[tiers.length - 1]!).gb * GB;
    }
  }
  const gb = row.kind === 'movie' ? s.maxMovieSizeGb : s.maxEpisodeSizeGb;
  return gb ? gb * GB : null;
}

/** How releases are judged for a title, from settings and the title's own size limit. */
export function decideOptions(ctx: AppContext, row: Pick<MonitoredRow, 'kind' | 'maxSizeMb' | 'tmdbId'>): DecideOptions {
  return { skipCam: ctx.settings.get('downloading').skipCamReleases, maxSize: maxSizeFor(ctx, row) };
}

const gb = (n: number) => `${(n / GB).toFixed(n < 10 * GB ? 1 : 0)} GB`;

/** The warning kept on a download (and sent to the webhook) when nothing within the size limit was found. */
function oversizeWarning(ctx: AppContext, row: MonitoredRow, d: Decision): string {
  const per = row.kind === 'show' ? ' per episode' : '';
  return `Bigger than the ${gb(maxSizeFor(ctx, row)!)} limit: ${gb(d.oversize!)}${per}. Nothing smaller was found.`;
}

export interface SearchResult {
  decisions: Decision[];
  errors: string[];
}

const recentReleases = new Map<string, { release: Release; covers: Decision['covers']; at: number }>();

/**
 * Releases shown in a title's manual search, so a grab can only use something the indexers actually
 * returned for that same title, along with the episodes it was judged to cover.
 */
export function rememberedRelease(monitoredId: number, guid: string): { release: Release; covers: Decision['covers'] } | null {
  const hit = recentReleases.get(`${monitoredId}:${guid}`);
  return hit && Date.now() - hit.at < 60 * 60 * 1000 ? hit : null;
}

export const MANUAL_TYPES = { any: [] as number[], movies: CATEGORIES.movies, tv: CATEGORIES.tv, audiobooks: CATEGORIES.audiobooks, books: CATEGORIES.books };

/** A free-text search of every indexer, not tied to a title. Results can be grabbed for an hour. */
export async function manualSearch(ctx: AppContext, q: string, type: keyof typeof MANUAL_TYPES): Promise<{ releases: (Release & { quality: string })[]; errors: string[] }> {
  const { releases, errors } = await searchAll(ctx, { type: 'search', q, categories: MANUAL_TYPES[type] });
  for (const r of releases) recentReleases.set(`manual:${r.guid}`, { release: r, covers: null, at: Date.now() });
  if (recentReleases.size > 5000) for (const k of [...recentReleases.keys()].slice(0, 1000)) recentReleases.delete(k);
  return {
    // Releases of exactly what was typed come first, so "48 hours" lists 48 Hours before Travel Man: 48 Hours in….
    releases: releases
      .map((r) => {
        const parsed = parseRelease(r.title);
        return { ...r, quality: parsed.quality, exact: titlesMatch(parsed.title, q) };
      })
      .sort((a, b) => Number(b.exact) - Number(a.exact) || (b.seeders ?? -1) - (a.seeders ?? -1) || (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
      .map(({ exact: _exact, ...r }) => r),
    errors: [...new Set(errors)],
  };
}

/** A release from a manual search, so a grab can only send what the indexers actually returned. */
export function rememberedManual(guid: string): Release | null {
  const hit = recentReleases.get(`manual:${guid}`);
  return hit && Date.now() - hit.at < 60 * 60 * 1000 ? hit.release : null;
}

/** At most this many episodes are looked up by air date in one search. */
const DATE_QUERIES = 6;

/**
 * Searches by air date for the newest wanted episodes, the way indexers file news and talk shows
 * ("20.20.2025.10.17"): Newznab takes the year as the season and "MM/DD" as the episode.
 */
function dateQueries(ctx: AppContext, row: MonitoredRow, target: Target): SearchQuery[] {
  const m = ctx.db.select().from(media).where(and(eq(media.kind, row.kind), eq(media.tmdbId, row.tmdbId))).get();
  return (target.episodes ?? [])
    .filter((e) => e.airDate)
    .sort((a, b) => b.airDate!.localeCompare(a.airDate!))
    .slice(0, DATE_QUERIES)
    .map((e) => ({ type: 'tvsearch' as const, q: row.title, tvdbId: m?.tvdbId, season: Number(e.airDate!.slice(0, 4)), episode: `${e.airDate!.slice(5, 7)}/${e.airDate!.slice(8, 10)}`, categories: CATEGORIES.tv }));
}

/** Every episode of a season (or just one) as a manual-search target, for when nothing in it is wanted. */
function seasonEpisodes(ctx: AppContext, monitoredId: number, season: number, episode?: number): NonNullable<Target['episodes']> {
  if (episode !== undefined) return [{ season, episode, currentQuality: null }];
  const eps = ctx.db
    .select({ episode: monitoredEpisodes.episode })
    .from(monitoredEpisodes)
    .where(and(eq(monitoredEpisodes.monitoredId, monitoredId), eq(monitoredEpisodes.season, season)))
    .all();
  return (eps.length ? eps : [{ episode: 1 }]).map((e) => ({ season, episode: e.episode, currentQuality: null }));
}

export async function searchMonitored(ctx: AppContext, row: MonitoredRow, filter?: SearchFilter): Promise<SearchResult> {
  const profile = searchProfile(ctx, row.profileId);
  const target = wantedTarget(ctx, { ...row, monitored: true }, filter) ?? {
    kind: row.kind,
    title: row.title,
    year: row.year,
    // Nothing wanted: still show results for a manual search, judged as if missing.
    episodes: filter?.season !== undefined ? seasonEpisodes(ctx, row.id, filter.season, filter.episode) : undefined,
  };
  if (!profile) return { decisions: [], errors: ['Quality profile is missing'] };
  const all: Release[] = [];
  const errors: string[] = [];
  const run = async (queries: SearchQuery[]) => {
    for (const q of queries) {
      const r = await searchAll(ctx, q);
      all.push(...r.releases);
      errors.push(...r.errors);
    }
  };
  const bl = blocked(ctx, row.id);
  const opts = decideOptions(ctx, row);
  const judge = () => [...new Map(all.map((r) => [r.title, r])).values()].map((r) => decide(r, target, profile, bl, opts));
  await run(queriesFor(ctx, row, target));
  let judged = judge();
  // Nothing by season and episode, and the indexers have no SxxEyy releases of it: it may be filed by air date instead.
  const numbered = judged.some((d) => d.parsed.season !== null && !d.rejections.includes('Title does not match'));
  if (row.kind === 'show' && !judged.some((d) => d.accepted) && !numbered) {
    await run(dateQueries(ctx, row, target));
    judged = judge();
  }
  const decisions = judged.sort((a, b) => Number(b.accepted) - Number(a.accepted) || byPreference(a, b));
  for (const d of decisions) recentReleases.set(`${row.id}:${d.release.guid}`, { release: d.release, covers: d.covers, at: Date.now() });
  if (recentReleases.size > 5000) for (const k of [...recentReleases.keys()].slice(0, 1000)) recentReleases.delete(k);
  ctx.db.update(monitored).set({ lastSearchAt: Date.now() }).where(eq(monitored.id, row.id)).run();
  return { decisions, errors: [...new Set(errors)] };
}

export function pickClient(ctx: AppContext, protocol: 'torrent' | 'usenet') {
  const row = ctx.db
    .select()
    .from(downloadClients)
    .where(and(eq(downloadClients.enabled, true), eq(downloadClients.protocol, protocol)))
    .orderBy(asc(downloadClients.priority))
    .get();
  if (!row) return null;
  return {
    row,
    client: createClient({ type: row.type as DownloadClientType, name: row.name, url: row.url, username: row.username, password: openSecret(ctx, row.password) }),
  };
}

/** Sends a release to a download client and records it for tracking and import. */
export async function grab(ctx: AppContext, release: Release, row: MonitoredRow | null, opts: { covers?: Decision['covers']; userId?: number | null; quality?: string; warning?: string | null; destination?: string | null }) {
  const picked = pickClient(ctx, release.protocol);
  if (!picked) throw new Error(`No ${release.protocol === 'torrent' ? 'torrent' : 'Usenet'} download client is set up`);
  // A root folder can have its own category (e.g. "kids-tv"), so the client files it separately.
  const category = (row && rootOf(ctx, row).category) || picked.row.category;
  const dl = ctx.db
    .insert(downloads)
    .values({
      clientId: picked.row.id,
      monitoredId: row?.id ?? null,
      episodes: opts.covers ? JSON.stringify(opts.covers) : null,
      title: release.title,
      quality: opts.quality ?? null,
      size: release.size,
      protocol: release.protocol,
      indexer: release.indexer,
      status: 'queued',
      sourceUrl: null,
      category,
      warning: opts.warning ?? null,
      destination: opts.destination ?? null,
      addedBy: opts.userId ?? null,
      addedAt: Date.now(),
    })
    .returning()
    .get();
  try {
    const id = await picked.client.add(release.downloadUrl, { category, tag: `mm-${dl.id}`, title: release.title });
    ctx.db.update(downloads).set({ downloadId: id }).where(eq(downloads.id, dl.id)).run();
  } catch (err) {
    ctx.db.update(downloads).set({ status: 'failed', error: (err as Error).message }).where(eq(downloads.id, dl.id)).run();
    throw err;
  }
  return dl.id;
}

/** Searches and grabs the best release(s) for everything wanted on a title. Returns how many were grabbed. */
export async function autoSearch(ctx: AppContext, row: MonitoredRow, filter?: SearchFilter): Promise<number> {
  return (await explainedSearch(ctx, row, filter)).grabbed;
}

/** "season:episode" keys of a download's episodes column. */
function keysOf(episodes: string): string[] {
  const c = JSON.parse(episodes) as { season: number; episodes: number[] };
  return c.episodes.map((e) => `${c.season}:${e}`);
}

/** What the episode label of a search is, such as "S06E01" or "season 6". */
function scopeLabel(row: MonitoredRow, filter?: SearchFilter) {
  if (row.kind === 'movie' || filter?.season === undefined) return row.title;
  const pad = (n: number) => String(n).padStart(2, '0');
  return filter.episode !== undefined ? `S${pad(filter.season)}E${pad(filter.episode)}` : `season ${filter.season}`;
}

/**
 * An automatic search that also says why nothing was grabbed (nothing wanted, nothing found, every
 * release rejected, already downloading, or the download client refused it), for the Search buttons.
 */
export async function explainedSearch(ctx: AppContext, row: MonitoredRow, filter?: SearchFilter): Promise<{ grabbed: number; message: string }> {
  const label = scopeLabel(row, filter);
  if (!wantedTarget(ctx, row, filter)) {
    if (filter?.missingOnly) return { grabbed: 0, message: `Nothing missing for ${label}: ${row.kind === 'show' ? 'every monitored episode that has aired has a file' : 'it has a file'}.` };
    return { grabbed: 0, message: `Nothing to search for: ${label} already has a file at the profile's cutoff${row.kind === 'show' ? ", or hasn't aired yet" : ''}.` };
  }
  const { decisions, errors } = await searchMonitored(ctx, row, filter);
  const notes: string[] = [];
  const grabbed = await grabBest(ctx, row, decisions, notes);
  const indexerNote = errors.length ? ` Indexer errors: ${errors.join('; ')}.` : '';
  if (grabbed) return { grabbed, message: `Grabbed ${grabbed === 1 ? 'a release' : `${grabbed} releases`} for ${label}. It's on Downloads.` };
  if (notes.length) return { grabbed, message: `Nothing grabbed for ${label}. ${[...new Set(notes)].join(' ')}${indexerNote}` };
  if (!decisions.length) return { grabbed, message: `No releases found for ${label}.${indexerNote}` };
  // Every release was rejected: name the most common reason, so it can be fixed or overridden with Manual.
  const counts = new Map<string, number>();
  for (const d of decisions) for (const r of new Set(d.rejections)) counts.set(r, (counts.get(r) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return { grabbed, message: `Found ${decisions.length} release(s) for ${label}, but none fit${top ? `: ${top[0]} (${top[1]})` : ''}. Manual shows each one and why.${indexerNote}` };
}

/**
 * Grabs the best accepted decisions without overlapping what's already downloading. When notes is
 * given, the reason each accepted release was not grabbed is added to it.
 */
export async function grabBest(ctx: AppContext, row: MonitoredRow, decisions: Decision[], notes?: string[]): Promise<number> {
  const active = activeDownloads(ctx, row.id);
  if (row.kind === 'movie') {
    if (active.length) {
      notes?.push(`Already downloading ${active[0]!.title} (${active[0]!.status}). Remove it on Downloads to search again.`);
      return 0;
    }
    const best = bestDecision(decisions);
    if (!best) return 0;
    try {
      await grabWithWarning(ctx, row, best);
    } catch (err) {
      if (best.oversize !== null && ctx.settings.get('downloading').oversize === 'skip') {
        notes?.push('Only releases over the size limit were found, and Settings → Media management skips those.');
        return 0;
      }
      throw err;
    }
    return 1;
  }
  const taken = new Set<string>();
  for (const a of active) if (a.episodes) keysOf(a.episodes).forEach((k) => taken.add(k));
  let grabbed = 0;
  const ordered = decisions
    .filter((x) => x.accepted)
    .sort((a, b) => Number(a.oversize !== null) - Number(b.oversize !== null) || (b.covers?.episodes.length ?? 0) - (a.covers?.episodes.length ?? 0) || b.score - a.score);
  for (const d of ordered) {
    const keys = (d.covers?.episodes ?? []).map((e) => `${d.covers!.season}:${e}`);
    if (!keys.length) continue;
    const busy = keys.find((k) => taken.has(k));
    if (busy) {
      const by = active.find((a) => a.episodes && keysOf(a.episodes).includes(busy));
      if (by) notes?.push(`Already downloading ${by.title} (${by.status}). Remove it on Downloads to search again.`);
      continue;
    }
    try {
      await grabWithWarning(ctx, row, d);
      keys.forEach((k) => taken.add(k));
      grabbed++;
    } catch (err) {
      // try the next candidate
      notes?.push(`${d.release.title} couldn't be sent: ${(err as Error).message}.`);
    }
  }
  return grabbed;
}

/**
 * Grabs an automatic pick. One over the size limit (only picked when nothing smaller was found) is
 * grabbed with a warning, held for a manager to confirm, or skipped (Settings → Media management).
 */
async function grabWithWarning(ctx: AppContext, row: MonitoredRow, d: Decision) {
  const warning = d.oversize !== null ? oversizeWarning(ctx, row, d) : null;
  const mode = ctx.settings.get('downloading').oversize;
  if (warning && mode === 'skip') throw new Error('Only releases over the size limit were found');
  if (warning && mode === 'ask') {
    holdRelease(ctx, d, row, warning);
    notify(ctx, { event: 'download.warning', title: 'Confirm a big download', message: `${row.title}: ${warning} It waits on Downloads until you confirm it.`, data: { kind: row.kind, tmdbId: row.tmdbId, release: d.release.title } });
    return;
  }
  await grab(ctx, d.release, row, { covers: d.covers, quality: d.parsed.quality, warning });
  if (warning) notify(ctx, { event: 'download.warning', title: 'Download over the size limit', message: `${row.title}: ${warning}`, data: { kind: row.kind, tmdbId: row.tmdbId, release: d.release.title } });
}

/** Records an oversize pick as "held" on Downloads; nothing is sent to a client until it's confirmed. */
function holdRelease(ctx: AppContext, d: Decision, row: MonitoredRow, warning: string) {
  ctx.db
    .insert(downloads)
    .values({
      monitoredId: row.id,
      episodes: d.covers ? JSON.stringify(d.covers) : null,
      title: d.release.title,
      quality: d.parsed.quality,
      size: d.release.size,
      protocol: d.release.protocol,
      indexer: d.release.indexer,
      status: 'held',
      warning,
      heldRelease: sealSecret(ctx, JSON.stringify(d.release)),
      addedAt: Date.now(),
    })
    .run();
}

/** Sends a held release to the download client. The held row is replaced by the real download. */
export async function confirmHeld(ctx: AppContext, id: number, userId: number | null): Promise<number> {
  const held = ctx.db.select().from(downloads).where(and(eq(downloads.id, id), eq(downloads.status, 'held'))).get();
  if (!held?.heldRelease || !held.monitoredId) throw new Error('That download is no longer waiting');
  const row = ctx.db.select().from(monitored).where(eq(monitored.id, held.monitoredId)).get();
  if (!row) throw new Error('The movie or show was removed');
  const release = JSON.parse(openSecret(ctx, held.heldRelease)) as Release;
  const covers = held.episodes ? (JSON.parse(held.episodes) as NonNullable<Decision['covers']>) : undefined;
  // The held row stays until the client has the release, so a failed send can be tried again.
  const newId = await grab(ctx, release, row, { covers, quality: held.quality ?? undefined, warning: held.warning, userId });
  ctx.db.delete(downloads).where(eq(downloads.id, id)).run();
  return newId;
}
