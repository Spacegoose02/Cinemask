import { and, asc, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { blocklist, downloadClients, downloads, indexers, monitored, type DownloadClientType } from '../db/schema.js';
import { media } from '../db/schema.js';
import { bestDecision, decide, type Decision, type Target } from './decision.js';
import { createClient } from './clients.js';
import { CATEGORIES, searchIndexer, type IndexerConfig, type Release, type SearchQuery } from './indexers.js';
import { wantedTarget, type MonitoredRow } from './monitor.js';
import { getProfile } from './profiles.js';
import { openSecret } from './secrets.js';

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

export interface SearchResult {
  decisions: Decision[];
  errors: string[];
}

const recentReleases = new Map<string, { release: Release; at: number }>();

/** Releases shown in a manual search, so a grab can only use something the indexers actually returned. */
export function rememberedRelease(guid: string): Release | null {
  const hit = recentReleases.get(guid);
  return hit && Date.now() - hit.at < 60 * 60 * 1000 ? hit.release : null;
}

export async function searchMonitored(ctx: AppContext, row: MonitoredRow, filter?: { season?: number; episode?: number }): Promise<SearchResult> {
  const profile = getProfile(ctx, row.profileId);
  const target = wantedTarget(ctx, { ...row, monitored: true }, filter) ?? {
    kind: row.kind,
    title: row.title,
    year: row.year,
    // Nothing wanted: still show results for a manual search, judged as if missing.
    episodes: filter?.season !== undefined ? [{ season: filter.season, episode: filter.episode ?? 1, currentQuality: null }] : undefined,
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
  for (const r of unique) recentReleases.set(r.guid, { release: r, at: Date.now() });
  if (recentReleases.size > 5000) for (const k of [...recentReleases.keys()].slice(0, 1000)) recentReleases.delete(k);
  const bl = blocked(ctx, row.id);
  const decisions = unique.map((r) => decide(r, target, profile, bl)).sort((a, b) => Number(b.accepted) - Number(a.accepted) || b.score - a.score);
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
export async function grab(ctx: AppContext, release: Release, row: MonitoredRow | null, opts: { covers?: Decision['covers']; userId?: number | null; quality?: string }) {
  const picked = pickClient(ctx, release.protocol);
  if (!picked) throw new Error(`No ${release.protocol === 'torrent' ? 'torrent' : 'Usenet'} download client is set up`);
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
      addedBy: opts.userId ?? null,
      addedAt: Date.now(),
    })
    .returning()
    .get();
  try {
    const id = await picked.client.add(release.downloadUrl, { category: picked.row.category, tag: `mm-${dl.id}`, title: release.title });
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
    await grab(ctx, best.release, row, { quality: best.parsed.quality });
    return 1;
  }
  const taken = new Set<string>();
  for (const a of active) {
    const c = a.episodes ? (JSON.parse(a.episodes) as { season: number; episodes: number[] }) : null;
    for (const e of c?.episodes ?? []) taken.add(`${c!.season}:${e}`);
  }
  let grabbed = 0;
  for (const d of decisions.filter((x) => x.accepted).sort((a, b) => (b.covers?.episodes.length ?? 0) - (a.covers?.episodes.length ?? 0) || b.score - a.score)) {
    const keys = (d.covers?.episodes ?? []).map((e) => `${d.covers!.season}:${e}`);
    if (!keys.length || keys.some((k) => taken.has(k))) continue;
    try {
      await grab(ctx, d.release, row, { covers: d.covers, quality: d.parsed.quality });
      keys.forEach((k) => taken.add(k));
      grabbed++;
    } catch {
      // try the next candidate
    }
  }
  return grabbed;
}
