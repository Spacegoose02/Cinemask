import { and, asc, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { blocklist, downloadClients, downloads, indexers, monitored, monitoredEpisodes, type DownloadClientType } from '../db/schema.js';
import { media } from '../db/schema.js';
import { bestDecision, byPreference, decide, type DecideOptions, type Decision, type Target } from './decision.js';
import { createClient } from './clients.js';
import { CATEGORIES, searchIndexer, type IndexerConfig, type Release, type SearchQuery } from './indexers.js';
import { wantedTarget, type MonitoredRow } from './monitor.js';
import { getProfile } from './profiles.js';
import { openSecret } from './secrets.js';
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
    .where(and(eq(downloads.monitoredId, monitoredId), inArray(downloads.status, ['queued', 'downloading', 'paused', 'completed', 'importing'])))
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

/** Largest wanted release for a title in bytes (per movie or per episode), or null for no limit. */
export function maxSizeFor(ctx: AppContext, row: Pick<MonitoredRow, 'kind' | 'maxSizeMb'>): number | null {
  if (row.maxSizeMb !== null && row.maxSizeMb !== undefined) return row.maxSizeMb ? row.maxSizeMb * MB : null;
  const s = ctx.settings.get('downloading');
  const gb = row.kind === 'movie' ? s.maxMovieSizeGb : s.maxEpisodeSizeGb;
  return gb ? gb * GB : null;
}

/** How releases are judged for a title, from settings and the title's own size limit. */
export function decideOptions(ctx: AppContext, row: Pick<MonitoredRow, 'kind' | 'maxSizeMb'>): DecideOptions {
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

export async function searchMonitored(ctx: AppContext, row: MonitoredRow, filter?: { season?: number; episode?: number }): Promise<SearchResult> {
  const profile = getProfile(ctx, row.profileId);
  const target = wantedTarget(ctx, { ...row, monitored: true }, filter) ?? {
    kind: row.kind,
    title: row.title,
    year: row.year,
    // Nothing wanted: still show results for a manual search, judged as if missing.
    episodes: filter?.season !== undefined ? seasonEpisodes(ctx, row.id, filter.season, filter.episode) : undefined,
  };
  if (!profile) return { decisions: [], errors: ['Quality profile is missing'] };
  const queries = queriesFor(ctx, row, target);
  const all: Release[] = [];
  const errors: string[] = [];
  for (const q of queries) {
    const r = await searchAll(ctx, q);
    all.push(...r.releases);
    errors.push(...r.errors);
  }
  const unique = [...new Map(all.map((r) => [r.title, r])).values()];
  const bl = blocked(ctx, row.id);
  const opts = decideOptions(ctx, row);
  const decisions = unique.map((r) => decide(r, target, profile, bl, opts)).sort((a, b) => Number(b.accepted) - Number(a.accepted) || byPreference(a, b));
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
export async function grab(ctx: AppContext, release: Release, row: MonitoredRow | null, opts: { covers?: Decision['covers']; userId?: number | null; quality?: string; warning?: string | null }) {
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
export async function autoSearch(ctx: AppContext, row: MonitoredRow, filter?: { season?: number; episode?: number }): Promise<number> {
  if (!wantedTarget(ctx, row, filter)) return 0;
  const { decisions } = await searchMonitored(ctx, row, filter);
  return grabBest(ctx, row, decisions);
}

/** Grabs the best accepted decisions without overlapping what's already downloading. */
export async function grabBest(ctx: AppContext, row: MonitoredRow, decisions: Decision[]): Promise<number> {
  const active = activeDownloads(ctx, row.id);
  if (row.kind === 'movie') {
    if (active.length) return 0;
    const best = bestDecision(decisions);
    if (!best) return 0;
    await grabWithWarning(ctx, row, best);
    return 1;
  }
  const taken = new Set<string>();
  for (const a of active) {
    const c = a.episodes ? (JSON.parse(a.episodes) as { season: number; episodes: number[] }) : null;
    for (const e of c?.episodes ?? []) taken.add(`${c!.season}:${e}`);
  }
  let grabbed = 0;
  const ordered = decisions
    .filter((x) => x.accepted)
    .sort((a, b) => Number(a.oversize !== null) - Number(b.oversize !== null) || (b.covers?.episodes.length ?? 0) - (a.covers?.episodes.length ?? 0) || b.score - a.score);
  for (const d of ordered) {
    const keys = (d.covers?.episodes ?? []).map((e) => `${d.covers!.season}:${e}`);
    if (!keys.length || keys.some((k) => taken.has(k))) continue;
    try {
      await grabWithWarning(ctx, row, d);
      keys.forEach((k) => taken.add(k));
      grabbed++;
    } catch {
      // try the next candidate
    }
  }
  return grabbed;
}

/** Grabs an automatic pick. One over the size limit (only picked when nothing smaller was found) is flagged. */
async function grabWithWarning(ctx: AppContext, row: MonitoredRow, d: Decision) {
  const warning = d.oversize !== null ? oversizeWarning(ctx, row, d) : null;
  await grab(ctx, d.release, row, { covers: d.covers, quality: d.parsed.quality, warning });
  if (warning) notify(ctx, { event: 'download.warning', title: 'Download over the size limit', message: `${row.title}: ${warning}`, data: { kind: row.kind, tmdbId: row.tmdbId, release: d.release.title } });
}
