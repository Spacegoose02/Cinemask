import { and, eq, gte, inArray, ne } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { downloads, media, monitored, monitoredEpisodes, requests, users, type MediaKind } from '../db/schema.js';
import { hasRole } from '../auth/guard.js';
import type { Role } from '../db/schema.js';
import { tmdbClient } from '../library/service.js';
import { liveStats } from '../arr/tracker.js';
import { localDay } from '../lib/dates.js';

const DAY = 24 * 60 * 60 * 1000;

export interface QuotaPart {
  /** 0 means no limit. */
  limit: number;
  used: number;
  remaining: number | null;
}

export interface Quota {
  days: number;
  movies: QuotaPart;
  seasons: QuotaPart;
  /** Managers and above are never limited. */
  exempt: boolean;
}

/** How many seasons a show request stands for: its own list, or every season of the show when it asked for all. */
async function seasonCount(ctx: AppContext, tmdbId: number, seasons: string | null): Promise<number> {
  if (seasons) return (JSON.parse(seasons) as number[]).length;
  return showSeasonCount(ctx, tmdbId);
}

/** Regular seasons of a show (specials don't count), at least 1. */
export async function showSeasonCount(ctx: AppContext, tmdbId: number): Promise<number> {
  const tmdb = tmdbClient(ctx);
  if (tmdb.configured) {
    const show = await tmdb.show(tmdbId).catch(() => null);
    const n = show?.seasons.filter((s) => s.season_number > 0).length;
    if (n) return n;
  }
  const row = ctx.db.select({ id: monitored.id }).from(monitored).where(and(eq(monitored.kind, 'show'), eq(monitored.tmdbId, tmdbId))).get();
  if (row) {
    const eps = ctx.db.select({ s: monitoredEpisodes.season }).from(monitoredEpisodes).where(eq(monitoredEpisodes.monitoredId, row.id)).all();
    const n = new Set(eps.map((e) => e.s).filter((s) => s > 0)).size;
    if (n) return n;
  }
  return 1;
}

/** A user's request allowance for the current period: requests made in the last N days, declined ones excepted. */
export async function quotaFor(ctx: AppContext, user: { id: number; role: Role }): Promise<Quota> {
  const s = ctx.settings.get('requests');
  const u = ctx.db.select().from(users).where(eq(users.id, user.id)).get();
  const exempt = hasRole(user.role, 'manager');
  const movieLimit = exempt ? 0 : (u?.movieRequestLimit ?? s.movieLimit);
  const seasonLimit = exempt ? 0 : (u?.seasonRequestLimit ?? s.seasonLimit);
  const since = Date.now() - s.limitDays * DAY;
  const mine = ctx.db
    .select()
    .from(requests)
    .where(and(eq(requests.requestedBy, user.id), gte(requests.createdAt, since), ne(requests.status, 'declined')))
    .all();
  const moviesUsed = mine.filter((r) => r.kind === 'movie').length;
  let seasonsUsed = 0;
  for (const r of mine) if (r.kind === 'show') seasonsUsed += await seasonCount(ctx, r.tmdbId, r.seasons);
  const part = (limit: number, used: number): QuotaPart => ({ limit, used, remaining: limit ? Math.max(0, limit - used) : null });
  return { days: s.limitDays, movies: part(movieLimit, moviesUsed), seasons: part(seasonLimit, seasonsUsed), exempt };
}

/** Throws a readable message when a request of this size would go over the user's allowance. */
export function quotaProblem(q: Quota, kind: MediaKind, cost: number): string | null {
  const part = kind === 'movie' ? q.movies : q.seasons;
  if (!part.limit || part.used + cost <= part.limit) return null;
  const what = kind === 'movie' ? 'movie' : 'season';
  const period = q.days === 7 ? 'week' : `${q.days} days`;
  const left = Math.max(0, part.limit - part.used);
  if (left === 0) return `You've used all ${part.limit} ${what} requests for this ${q.days === 7 ? 'week' : 'period'}. Older requests stop counting after ${period}.`;
  return `That's ${cost} ${what}s, and you have ${left} ${what} request${left === 1 ? '' : 's'} left this ${q.days === 7 ? 'week' : 'period'}. Pick fewer, or ask a manager.`;
}

export interface StreamingHit {
  providers: { id: number; name: string; logoPath: string | null }[];
  region: string;
  link: string | null;
}

/** Subscription services the title is on in the household's region, limited to the household's own services when set. */
export async function streamingFor(ctx: AppContext, kind: MediaKind, tmdbId: number): Promise<StreamingHit | null> {
  const tmdb = tmdbClient(ctx);
  if (!tmdb.configured) return null;
  const data = await tmdb.titleProviders(kind === 'movie' ? 'movie' : 'tv', tmdbId).catch(() => null);
  const region = tmdb.watchRegion;
  const here = data?.results?.[region];
  const wanted = ctx.settings.get('requests').streamingProviders;
  const providers = (here?.flatrate ?? []).filter((p) => !wanted.length || wanted.includes(p.provider_id)).map((p) => ({ id: p.provider_id, name: p.provider_name, logoPath: p.logo_path ?? null }));
  return providers.length ? { providers, region, link: here?.link ?? null } : null;
}

export type ProgressState = 'waiting' | 'unreleased' | 'searching' | 'queued' | 'downloading' | 'importing' | 'partial' | 'ready';

export interface RequestProgress {
  state: ProgressState;
  /** 0 to 1 while downloading. */
  percent?: number;
  /** Seconds left, when the download client knows. */
  eta?: number | null;
  /** Shows: aired episodes of the requested seasons on disk, and how many have aired. */
  have?: number;
  total?: number;
  /** Movies not out yet: when it's expected (digital or physical release, else the cinema date). */
  releaseDate?: string | null;
}

const ACTIVE = ['held', 'queued', 'downloading', 'paused', 'completed', 'importing'] as const;

/** Where an approved request has got to, from the downloads and files Cinemask is tracking for it. */
export function requestProgress(ctx: AppContext, r: typeof requests.$inferSelect): RequestProgress | null {
  if (r.status === 'available') return { state: 'ready' };
  if (r.status !== 'approved') return null;
  if (!r.monitoredId) return { state: 'waiting' };
  const row = ctx.db.select().from(monitored).where(eq(monitored.id, r.monitoredId)).get();
  if (!row) return { state: 'waiting' };
  const active = ctx.db
    .select()
    .from(downloads)
    .where(and(eq(downloads.monitoredId, row.id), inArray(downloads.status, [...ACTIVE])))
    .all();
  let have: number | undefined;
  let total: number | undefined;
  if (row.kind === 'show') {
    const wanted = r.seasons ? (JSON.parse(r.seasons) as number[]) : null;
    const today = localDay();
    const eps = ctx.db
      .select()
      .from(monitoredEpisodes)
      .where(eq(monitoredEpisodes.monitoredId, row.id))
      .all()
      .filter((e) => e.season > 0 && (!wanted || wanted.includes(e.season)) && e.airDate && e.airDate <= today);
    have = eps.filter((e) => e.filePath).length;
    total = eps.length;
  }
  const counts = row.kind === 'show' ? { have, total } : {};
  const downloading = active.filter((d) => d.status === 'downloading' || d.status === 'paused');
  if (downloading.length) {
    const percent = downloading.reduce((n, d) => n + d.progress, 0) / downloading.length;
    const etas = downloading.map((d) => liveStats.get(d.id)?.eta).filter((e): e is number => typeof e === 'number');
    return { state: 'downloading', percent, eta: etas.length ? Math.max(...etas) : null, ...counts };
  }
  if (active.some((d) => d.status === 'completed' || d.status === 'importing')) return { state: 'importing', ...counts };
  if (active.length) return { state: 'queued', ...counts };
  if (row.kind === 'movie') {
    if (row.filePath) return { state: 'ready' };
    const m = ctx.db.select().from(media).where(and(eq(media.kind, 'movie'), eq(media.tmdbId, row.tmdbId))).get();
    const out = m?.digitalRelease ?? m?.physicalRelease ?? null;
    if (m && out && out > localDay()) return { state: 'unreleased', releaseDate: out };
    if (m && !out && m.releaseDate && m.releaseDate > localDay()) return { state: 'unreleased', releaseDate: m.releaseDate };
    return { state: 'searching' };
  }
  if (total === 0) return { state: 'unreleased', ...counts };
  if (have && have >= total!) return { state: 'ready', ...counts };
  return { state: have ? 'partial' : 'searching', ...counts };
}
