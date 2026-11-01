import fs from 'node:fs';
import path from 'node:path';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { monitored, monitoredEpisodes } from '../db/schema.js';
import { fetchJson, IntegrationError, connectError } from '../integrations/http.js';
import { insideRoot } from '../lib/paths.js';
import { rootOf } from '../arr/roots.js';
import type { MonitoredRow } from '../arr/monitor.js';

/**
 * Subtitles from OpenSubtitles.com, saved next to the video as "Movie (2014).en.srt" so Plex,
 * Jellyfin and BingeBandit pick them up. Matching by file hash first gives subtitles that are in
 * sync with that exact copy.
 */
const API = 'https://api.opensubtitles.com/api/v1';
const SERVICE = 'OpenSubtitles';
const MAX_SUB_BYTES = 5 * 1024 * 1024;

/** OpenSubtitles' file hash: the size plus the 64-bit sums of the first and last 64 KB. */
export function movieHash(file: string): string | null {
  const CHUNK = 65536;
  let fd: number | null = null;
  try {
    // Open first and size the open file, so it can't change between the check and the read.
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < CHUNK * 2) return null;
    let sum = BigInt(size);
    const buf = Buffer.alloc(CHUNK);
    for (const at of [0, size - CHUNK]) {
      fs.readSync(fd, buf, 0, CHUNK, at);
      for (let i = 0; i < CHUNK; i += 8) sum = (sum + buf.readBigUInt64LE(i)) & 0xffffffffffffffffn;
    }
    return sum.toString(16).padStart(16, '0');
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

let session: { key: string; token: string; until: number } | null = null;

function headers(apiKey: string, token?: string): Record<string, string> {
  return { 'Api-Key': apiKey, 'User-Agent': 'Cinemask v1', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

/** Signs in when a username is set (more downloads a day than anonymous use). */
async function token(ctx: AppContext): Promise<string | undefined> {
  const s = ctx.settings.get('subtitles');
  if (!s.username || !s.password) return undefined;
  const key = `${s.apiKey}|${s.username}|${s.password}`;
  if (session?.key === key && session.until > Date.now()) return session.token;
  const r = await fetchJson<{ token: string }>(SERVICE, `${API}/login`, { method: 'POST', headers: headers(s.apiKey), body: JSON.stringify({ username: s.username, password: s.password }) });
  session = { key, token: r.token, until: Date.now() + 12 * 60 * 60 * 1000 };
  return r.token;
}

interface SubResult {
  attributes: {
    language: string;
    download_count: number;
    hearing_impaired: boolean;
    moviehash_match?: boolean;
    ai_translated?: boolean;
    machine_translated?: boolean;
    files: { file_id: number; file_name: string }[];
  };
}

/** Picks the best subtitle: exact file match first, then not machine-translated, then most downloaded. */
export function pickSubtitle(results: SubResult[], hearingImpaired: 'prefer_not' | 'include' | 'only'): SubResult | null {
  const usable = results.filter((r) => r.attributes.files.length && (hearingImpaired !== 'only' || r.attributes.hearing_impaired));
  const rank = (r: SubResult) =>
    (r.attributes.moviehash_match ? 1e9 : 0) +
    (r.attributes.ai_translated || r.attributes.machine_translated ? 0 : 1e8) +
    (hearingImpaired === 'prefer_not' && !r.attributes.hearing_impaired ? 1e7 : 0) +
    Math.min(r.attributes.download_count ?? 0, 9_999_999);
  return usable.sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

export interface SubtitleScope {
  season?: number | null;
  episode?: number | null;
}

/** Videos of a title to find subtitles for: the movie, or the episodes in scope that have a file. */
function videosFor(ctx: AppContext, row: MonitoredRow, scope: SubtitleScope): { file: string; season?: number; episode?: number }[] {
  if (row.kind === 'movie') return row.filePath ? [{ file: row.filePath }] : [];
  return ctx.db
    .select()
    .from(monitoredEpisodes)
    .where(and(eq(monitoredEpisodes.monitoredId, row.id), isNotNull(monitoredEpisodes.filePath)))
    .all()
    .filter((e) => (scope.season === undefined || scope.season === null || e.season === scope.season) && (scope.episode === undefined || scope.episode === null || e.episode === scope.episode))
    .map((e) => ({ file: e.filePath!, season: e.season, episode: e.episode }));
}

const SUB_EXT = /\.(srt|ass|ssa|vtt|sub|sup)$/i;

/** Subtitle files already next to a video for a language (Movie.en.srt, Movie.eng.forced.srt…). */
export function hasSidecar(file: string, lang: string): boolean {
  const dir = path.dirname(file);
  const base = path.parse(file).name;
  try {
    return fs.readdirSync(dir).some((f) => f.startsWith(`${base}.`) && SUB_EXT.test(f) && new RegExp(`\\.(${lang}|${lang}[a-z])(\\.|$)`, 'i').test(f.slice(base.length)));
  } catch {
    return false;
  }
}

export interface SubtitleResult {
  saved: string[];
  missing: string[];
}

/**
 * Downloads subtitles in each wanted language that a title's videos don't have yet (or replaces
 * them when force is set). Returns the files saved and what couldn't be found.
 */
export async function fetchSubtitles(ctx: AppContext, row: MonitoredRow, scope: SubtitleScope = {}, opts: { languages?: string[]; force?: boolean; limit?: number } = {}): Promise<SubtitleResult> {
  const s = ctx.settings.get('subtitles');
  if (!s.enabled || !s.apiKey) throw new IntegrationError(SERVICE, 'add an API key in Settings → Media management → Subtitles first');
  const languages = opts.languages?.length ? opts.languages : s.languages;
  const root = rootOf(ctx, row).path;
  const out: SubtitleResult = { saved: [], missing: [] };
  const videos = videosFor(ctx, row, scope).slice(0, opts.limit ?? 60);
  for (const v of videos) {
    if (!fs.existsSync(v.file)) continue;
    const hash = movieHash(v.file);
    for (const lang of languages) {
      if (!opts.force && hasSidecar(v.file, lang)) continue;
      const label = v.season !== undefined ? `S${String(v.season).padStart(2, '0')}E${String(v.episode).padStart(2, '0')} (${lang})` : `${row.title} (${lang})`;
      const qs = new URLSearchParams({ languages: lang, ...(hash ? { moviehash: hash } : {}) });
      if (row.kind === 'movie') qs.set('tmdb_id', String(row.tmdbId));
      else {
        qs.set('parent_tmdb_id', String(row.tmdbId));
        qs.set('season_number', String(v.season));
        qs.set('episode_number', String(v.episode));
      }
      const found = await fetchJson<{ data: SubResult[] }>(SERVICE, `${API}/subtitles?${qs.toString()}`, { headers: headers(s.apiKey) });
      const best = pickSubtitle(found.data ?? [], s.hearingImpaired);
      if (!best) {
        out.missing.push(label);
        continue;
      }
      const auth = await token(ctx);
      const dl = await fetchJson<{ link: string }>(SERVICE, `${API}/download`, { method: 'POST', headers: headers(s.apiKey, auth), body: JSON.stringify({ file_id: best.attributes.files[0]!.file_id, sub_format: 'srt' }) });
      const link = new URL(dl.link);
      if (link.protocol !== 'https:' || !/(^|\.)opensubtitles\.(com|org)$/.test(link.hostname)) throw new IntegrationError(SERVICE, 'gave a download link somewhere unexpected');
      let res: Response;
      try {
        res = await fetch(link, { signal: AbortSignal.timeout(30_000) });
      } catch (err) {
        throw new IntegrationError(SERVICE, connectError(err));
      }
      if (!res.ok) throw new IntegrationError(SERVICE, `the subtitle download answered HTTP ${res.status}`, res.status);
      const text = await res.text();
      if (text.length > MAX_SUB_BYTES) throw new IntegrationError(SERVICE, 'sent a subtitle file that is far too big');
      // Only ever write what is plainly a subtitle file: SubRip timings, and no binary content.
      if (!isSubRip(text)) throw new IntegrationError(SERVICE, "sent something that isn't a subtitle file");
      const dest = path.join(path.dirname(v.file), `${path.parse(v.file).name}.${lang}${best.attributes.hearing_impaired ? '.sdh' : ''}.srt`);
      if (!insideRoot(root, dest)) throw new Error('Refusing to write outside the media folder');
      writeNoFollow(dest, text);
      out.saved.push(dest);
    }
  }
  return out;
}

/** SubRip text: has at least one "00:00:01,000 --> 00:00:02,000" timing and no NUL bytes. */
export function isSubRip(text: string): boolean {
  return !text.includes('\0') && /\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/.test(text);
}

/** Writes a file without following a symlink planted where it goes. */
function writeNoFollow(dest: string, text: string) {
  const fd = fs.openSync(dest, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0), 0o644);
  try {
    fs.writeFileSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
}

/** After an import: fetch subtitles automatically when that's turned on. Errors are ignored. */
export async function autoSubtitles(ctx: AppContext, monitoredId: number): Promise<void> {
  const s = ctx.settings.get('subtitles');
  if (!s.enabled || !s.auto || !s.apiKey) return;
  const row = ctx.db.select().from(monitored).where(eq(monitored.id, monitoredId)).get();
  if (!row) return;
  await fetchSubtitles(ctx, row, {}, { limit: 20 }).catch(() => undefined);
}
