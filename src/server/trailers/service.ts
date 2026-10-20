import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, exists, isNotNull, or, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { MonitoredRow } from '../arr/monitor.js';
import { monitored, monitoredEpisodes } from '../db/schema.js';
import { refreshMediaServers } from '../arr/tracker.js';
import { expectedFolder, rootFor } from '../files/service.js';
import { tmdbClient } from '../library/service.js';
import { insideRoot } from '../lib/paths.js';
import { sanitizeSegment } from '../arr/naming.js';

export type TrailerSite = 'YouTube' | 'Vimeo';

export interface TrailerCandidate {
  site: TrailerSite;
  key: string;
  name: string;
  type: string;
  official: boolean;
  size: number | null;
  publishedAt: string | null;
}

export interface TrailerJob {
  status: 'downloading' | 'done' | 'failed';
  key: string;
  error?: string;
  startedAt: number;
}

const VIDEO_EXT = /\.(mp4|mkv|webm|mov|m4v)$/i;
const YT_KEY = /^[\w-]{6,20}$/;
const VIMEO_KEY = /^\d{4,12}$/;
const validKey = (site: TrailerSite, key: string) => (site === 'YouTube' ? YT_KEY : VIMEO_KEY).test(key);
const videoUrl = (site: TrailerSite, key: string) => (site === 'YouTube' ? `https://www.youtube.com/watch?v=${key}` : `https://vimeo.com/${key}`);

/**
 * Reads a YouTube or Vimeo link someone pasted. Only those two sites are accepted, and only the
 * video id is kept, so yt-dlp never sees an arbitrary URL.
 */
export function parseVideoUrl(raw: string): { site: TrailerSite; key: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let found: { site: TrailerSite; key: string } | null = null;
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const key = u.searchParams.get('v') ?? /^\/(?:embed|shorts|v|live)\/([\w-]+)/.exec(u.pathname)?.[1];
    if (key) found = { site: 'YouTube', key };
  } else if (host === 'youtu.be') found = { site: 'YouTube', key: u.pathname.slice(1).split('/')[0]! };
  else if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const key = /\/(?:video\/)?(\d+)/.exec(u.pathname)?.[1];
    if (key) found = { site: 'Vimeo', key };
  }
  return found && validKey(found.site, found.key) ? found : null;
}
const jobs = new Map<number, TrailerJob>();

export const trailerJob = (monitoredId: number) => jobs.get(monitoredId) ?? null;

/** YouTube and Vimeo trailers and teasers from TMDB, best first (official, then highest resolution). */
export async function trailerCandidates(ctx: AppContext, row: MonitoredRow): Promise<TrailerCandidate[]> {
  const tmdb = tmdbClient(ctx);
  if (!tmdb.configured) return [];
  const r = await tmdb.videos(row.kind === 'movie' ? 'movie' : 'tv', row.tmdbId);
  const score = (v: TrailerCandidate) => (v.type === 'Trailer' ? 1000 : v.type === 'Teaser' ? 500 : 0) + (v.official ? 200 : 0) + (v.size ?? 0) / 10;
  return r.results
    .filter((v) => (v.site === 'YouTube' || v.site === 'Vimeo') && validKey(v.site, v.key) && ['Trailer', 'Teaser', 'Clip', 'Featurette'].includes(v.type))
    .map((v) => ({ site: v.site as TrailerSite, key: v.key, name: v.name ?? v.type, type: v.type, official: Boolean(v.official), size: v.size ?? null, publishedAt: v.published_at ?? null }))
    .sort((a, b) => score(b) - score(a));
}

/** Plex and Jellyfin both read "<Movie>-trailer.ext" beside a movie, and a "trailers" folder inside a show. */
function trailerTarget(ctx: AppContext, row: MonitoredRow): { dir: string; stem: string } {
  const folder = row.path ?? expectedFolder(ctx, row);
  if (row.kind === 'movie') {
    const stem = row.filePath ? path.parse(row.filePath).name : path.basename(folder);
    return { dir: row.filePath ? path.dirname(row.filePath) : folder, stem: `${stem}-trailer` };
  }
  return { dir: path.join(folder, 'trailers'), stem: sanitizeSegment(`${row.title}${row.year ? ` (${row.year})` : ''} - Trailer`) };
}

/** Trailer files already on disk for a title. */
export function existingTrailers(ctx: AppContext, row: MonitoredRow): { path: string; size: number }[] {
  const { dir, stem } = trailerTarget(ctx, row);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => VIDEO_EXT.test(f) && (row.kind === 'show' || f.startsWith(`${stem}.`)))
    .map((f) => ({ path: path.join(dir, f), size: fs.statSync(path.join(dir, f)).size }));
}

/**
 * The yt-dlp program from settings. Only an absolute path to a file named yt-dlp is run, so the
 * setting can't be pointed at some other program in the container.
 */
export function ytDlpBinary(ctx: AppContext): string {
  const p = ctx.settings.get('extras').ytDlpPath;
  if (!path.isAbsolute(p) || !/^yt-dlp(_linux)?$/.test(path.basename(p))) throw new Error('The yt-dlp path must be a full path to a program named yt-dlp');
  if (!fs.existsSync(p)) throw new Error(`yt-dlp was not found at ${p}`);
  return p;
}

/**
 * Downloads a YouTube or Vimeo trailer with yt-dlp into the title's folder. Runs in the background;
 * progress is read with trailerJob(). The video id is validated and passed as an argument,
 * never through a shell.
 */
export function downloadTrailer(ctx: AppContext, row: MonitoredRow, key: string, site: TrailerSite = 'YouTube'): TrailerJob {
  if (!validKey(site, key)) throw new Error(`Not a valid ${site} video id`);
  const s = ctx.settings.get('extras');
  if (!s.trailersEnabled) throw new Error('Trailer downloads are turned off (Settings → Media management)');
  const bin = ytDlpBinary(ctx);
  if (jobs.get(row.id)?.status === 'downloading') throw new Error('A trailer is already downloading for this title');
  const root = rootFor(ctx, row);
  const { dir, stem } = trailerTarget(ctx, row);
  if (!insideRoot(root, path.join(dir, stem))) throw new Error('Refusing to write outside the media folder');
  fs.mkdirSync(dir, { recursive: true });
  const h = s.trailerMaxHeight;
  const args = [
    '--no-playlist',
    '--no-progress',
    '--restrict-filenames',
    '-f',
    `bv*[height<=${h}]+ba/b[height<=${h}]`,
    '--merge-output-format',
    'mkv',
    '-o',
    path.join(dir, `${stem}.%(ext)s`),
    '--',
    videoUrl(site, key),
  ];
  const job: TrailerJob = { status: 'downloading', key, startedAt: Date.now() };
  jobs.set(row.id, job);
  // Replace an older trailer only once the new one has arrived.
  const before = existingTrailers(ctx, row).map((t) => t.path);
  execFile(bin, args, { timeout: 15 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }, (err, _stdout, stderr) => {
    if (err) {
      job.status = 'failed';
      job.error = (String(stderr).trim().split('\n').pop() || err.message).slice(0, 500);
      return;
    }
    const after = existingTrailers(ctx, row).map((t) => t.path);
    const fresh = after.filter((p) => !before.includes(p));
    if (fresh.length) for (const old of before) if (row.kind === 'movie' && insideRoot(root, old)) fs.rmSync(old, { force: true });
    job.status = 'done';
    void refreshMediaServers(ctx);
  });
  return job;
}

export function removeTrailers(ctx: AppContext, row: MonitoredRow): number {
  const root = rootFor(ctx, row);
  let n = 0;
  for (const t of existingTrailers(ctx, row)) {
    if (!insideRoot(root, t.path)) continue;
    fs.rmSync(t.path);
    n++;
  }
  jobs.delete(row.id);
  return n;
}

/** After an import: fetch the best trailer for a movie or show when the setting is on and there isn't one yet. */
export async function autoTrailer(ctx: AppContext, row: MonitoredRow): Promise<void> {
  const s = ctx.settings.get('extras');
  if (!s.trailersEnabled || !s.autoDownloadTrailers || existingTrailers(ctx, row).length || jobs.get(row.id)?.status === 'downloading') return;
  const best = (await trailerCandidates(ctx, row))[0];
  if (best) downloadTrailer(ctx, row, best.key, best.site);
}

/** Titles whose automatic trailer failed since the app started; the sweep doesn't keep retrying them. */
const sweepFailed = new Set<number>();

/**
 * Fetches trailers for titles that already have files but no trailer yet (titles on the server
 * before Cinemask managed them, or added before the setting was on). One at a time, until
 * `budgetMs` runs out; the next run carries on.
 */
export async function sweepTrailers(ctx: AppContext, budgetMs = 45 * 60 * 1000): Promise<number> {
  const s = ctx.settings.get('extras');
  if (!s.trailersEnabled || !s.autoDownloadTrailers) return 0;
  try {
    ytDlpBinary(ctx);
  } catch {
    return 0;
  }
  const until = Date.now() + budgetMs;
  const withFiles = ctx.db
    .select()
    .from(monitored)
    .where(or(isNotNull(monitored.filePath), exists(ctx.db.select({ one: sql`1` }).from(monitoredEpisodes).where(and(eq(monitoredEpisodes.monitoredId, monitored.id), isNotNull(monitoredEpisodes.filePath))))))
    .all();
  let fetched = 0;
  for (const row of withFiles) {
    if (Date.now() > until) break;
    if (sweepFailed.has(row.id) || jobs.get(row.id)?.status === 'downloading') continue;
    try {
      if (existingTrailers(ctx, row).length) continue;
      const best = (await trailerCandidates(ctx, row))[0];
      if (!best) {
        sweepFailed.add(row.id);
        continue;
      }
      const job = downloadTrailer(ctx, row, best.key, best.site);
      while (job.status === 'downloading') await new Promise((r) => setTimeout(r, 2000));
      if (job.status === 'done') fetched++;
      else sweepFailed.add(row.id);
    } catch {
      sweepFailed.add(row.id);
    }
  }
  return fetched;
}

const MIME: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime' };
export const trailerMime = (file: string) => MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
