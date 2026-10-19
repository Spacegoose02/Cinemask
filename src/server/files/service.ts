import { and, eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { monitored, monitoredEpisodes } from '../db/schema.js';
import { findVideos } from '../arr/importer.js';
import type { MonitoredRow } from '../arr/monitor.js';
import { renderName } from '../arr/naming.js';
import { parseRelease } from '../arr/parser.js';
import { insideRoot } from '../lib/paths.js';

export { insideRoot };

/**
 * File management for monitored titles: list, adopt existing files, rename to the naming
 * templates and delete. Every path is checked against the configured media root (after
 * resolving symlinks) so a bad template or a tampered row can never touch anything else.
 */

export function rootFor(ctx: AppContext, row: Pick<MonitoredRow, 'kind'>): string {
  const s = ctx.settings.get('media');
  return row.kind === 'movie' ? s.moviesPath : s.tvPath;
}

function assertInside(root: string, target: string) {
  if (!insideRoot(root, target)) throw new Error(`Refusing to touch ${target}: it is outside ${root}`);
}

/** Removes empty folders from dir upwards, stopping at the media root. */
function pruneEmpty(root: string, dir: string) {
  let cur = dir;
  while (insideRoot(root, cur) && fs.existsSync(cur)) {
    if (fs.readdirSync(cur).length) return;
    fs.rmdirSync(cur);
    cur = path.dirname(cur);
  }
}

const sizeOf = (p: string | null) => {
  try {
    return p ? fs.statSync(p).size : null;
  } catch {
    return null;
  }
};

export interface FileEntry {
  path: string;
  quality: string | null;
  size: number | null;
  exists: boolean;
  season?: number;
  episodes?: number[];
}

/** Files the app tracks for a title. Multi-episode files are listed once. */
export function listFiles(ctx: AppContext, row: MonitoredRow): { folder: string | null; files: FileEntry[]; totalSize: number } {
  const files: FileEntry[] = [];
  if (row.kind === 'movie') {
    if (row.filePath) files.push({ path: row.filePath, quality: row.fileQuality, size: sizeOf(row.filePath), exists: fs.existsSync(row.filePath) });
  } else {
    const byPath = new Map<string, FileEntry>();
    for (const e of episodesOf(ctx, row.id)) {
      if (!e.filePath) continue;
      const f = byPath.get(e.filePath);
      if (f) f.episodes!.push(e.episode);
      else byPath.set(e.filePath, { path: e.filePath, quality: e.fileQuality, size: sizeOf(e.filePath), exists: fs.existsSync(e.filePath), season: e.season, episodes: [e.episode] });
    }
    files.push(...byPath.values());
  }
  return { folder: row.path, files, totalSize: files.reduce((n, f) => n + (f.size ?? 0), 0) };
}

const episodesOf = (ctx: AppContext, monitoredId: number) =>
  ctx.db.select().from(monitoredEpisodes).where(eq(monitoredEpisodes.monitoredId, monitoredId)).orderBy(monitoredEpisodes.season, monitoredEpisodes.episode).all();

/** The folder a title belongs in under the current naming settings. */
export function expectedFolder(ctx: AppContext, row: MonitoredRow): string {
  const naming = ctx.settings.get('naming');
  const root = rootFor(ctx, row);
  return row.kind === 'movie'
    ? path.join(root, renderName(naming.movieFolder, { movieTitle: row.title, year: row.year, tmdbId: row.tmdbId }))
    : path.join(root, renderName(naming.seriesFolder, { seriesTitle: row.title, year: row.year, tmdbId: row.tmdbId }));
}

/**
 * Finds video files already in the title's folder and links them to the movie or episodes,
 * so existing libraries can be managed without re-downloading. Tracked files that vanished
 * from disk are forgotten.
 */
export function scanFolder(ctx: AppContext, row: MonitoredRow): { found: number; missing: number; folder: string } {
  const root = rootFor(ctx, row);
  const folder = row.path ?? expectedFolder(ctx, row);
  assertInside(root, folder);
  const videos = findVideos(folder);
  let found = 0;
  let missing = 0;
  if (row.kind === 'movie') {
    if (row.filePath && !fs.existsSync(row.filePath)) {
      missing++;
      ctx.db.update(monitored).set({ filePath: null, fileQuality: null }).where(eq(monitored.id, row.id)).run();
    }
    const current = row.filePath && fs.existsSync(row.filePath) ? row.filePath : null;
    if (!current && videos.length) {
      const file = videos.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0]!;
      ctx.db.update(monitored).set({ path: folder, filePath: file, fileQuality: parseRelease(path.basename(file)).quality }).where(eq(monitored.id, row.id)).run();
      found++;
    }
  } else {
    for (const e of episodesOf(ctx, row.id)) {
      if (e.filePath && !fs.existsSync(e.filePath)) {
        missing++;
        ctx.db.update(monitoredEpisodes).set({ filePath: null, fileQuality: null }).where(eq(monitoredEpisodes.id, e.id)).run();
      }
    }
    for (const file of videos) {
      const p = parseRelease(path.basename(file));
      // Fall back to the season folder name ("Season 2") when the file name has no season.
      const folderSeason = /season\s*(\d+)/i.exec(path.basename(path.dirname(file)))?.[1];
      const season = p.season ?? (folderSeason ? Number(folderSeason) : null);
      if (season === null || !p.episodes.length) continue;
      for (const n of p.episodes) {
        const e = ctx.db.select().from(monitoredEpisodes).where(and(eq(monitoredEpisodes.monitoredId, row.id), eq(monitoredEpisodes.season, season), eq(monitoredEpisodes.episode, n))).get();
        if (!e || (e.filePath && fs.existsSync(e.filePath))) continue;
        ctx.db.update(monitoredEpisodes).set({ filePath: file, fileQuality: p.quality }).where(eq(monitoredEpisodes.id, e.id)).run();
        found++;
      }
    }
    if (videos.length) ctx.db.update(monitored).set({ path: folder }).where(eq(monitored.id, row.id)).run();
  }
  return { found, missing, folder };
}

export interface RenameItem {
  from: string;
  to: string;
}

/** What renaming to the current naming settings would change. Nothing is touched. */
export function renamePreview(ctx: AppContext, row: MonitoredRow): RenameItem[] {
  const naming = ctx.settings.get('naming');
  const folder = expectedFolder(ctx, row);
  const out: RenameItem[] = [];
  if (row.kind === 'movie') {
    if (!row.filePath) return out;
    const name = renderName(naming.movieFile, { movieTitle: row.title, year: row.year, quality: row.fileQuality, tmdbId: row.tmdbId });
    const to = path.join(folder, `${name}${path.extname(row.filePath).toLowerCase()}`);
    if (to !== row.filePath) out.push({ from: row.filePath, to });
    return out;
  }
  const byPath = new Map<string, (typeof monitoredEpisodes.$inferSelect)[]>();
  for (const e of episodesOf(ctx, row.id)) if (e.filePath) byPath.set(e.filePath, [...(byPath.get(e.filePath) ?? []), e]);
  for (const [from, eps] of byPath) {
    const values = {
      seriesTitle: row.title,
      year: row.year,
      season: eps[0]!.season,
      episodes: eps.map((e) => e.episode),
      episodeTitle: eps.length === 1 ? eps[0]!.title : eps.map((e) => e.title).join(' + '),
      quality: eps[0]!.fileQuality,
      airDate: eps[0]!.airDate,
      tmdbId: row.tmdbId,
    };
    const to = path.join(folder, renderName(naming.seasonFolder, values), `${renderName(naming.episodeFile, values)}${path.extname(from).toLowerCase()}`);
    if (to !== from) out.push({ from, to });
  }
  return out;
}

/** Applies a rename preview (or the chosen subset of it). Files stay on the same disk, so this is a move, not a copy. */
export function applyRename(ctx: AppContext, row: MonitoredRow, only?: string[]): { renamed: number; errors: string[] } {
  const root = rootFor(ctx, row);
  const items = renamePreview(ctx, row).filter((i) => !only || only.includes(i.from));
  const errors: string[] = [];
  let renamed = 0;
  for (const { from, to } of items) {
    try {
      assertInside(root, from);
      assertInside(root, to);
      if (!fs.existsSync(from)) throw new Error(`${path.basename(from)} is missing on disk`);
      if (fs.existsSync(to)) throw new Error(`${path.basename(to)} already exists`);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      if (row.kind === 'movie') ctx.db.update(monitored).set({ filePath: to }).where(eq(monitored.id, row.id)).run();
      else ctx.db.update(monitoredEpisodes).set({ filePath: to }).where(and(eq(monitoredEpisodes.monitoredId, row.id), eq(monitoredEpisodes.filePath, from))).run();
      pruneEmpty(root, path.dirname(from));
      renamed++;
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  if (renamed) ctx.db.update(monitored).set({ path: expectedFolder(ctx, row) }).where(eq(monitored.id, row.id)).run();
  return { renamed, errors };
}

export type DeleteScope = { scope: 'movie' } | { scope: 'show' } | { scope: 'season'; season: number } | { scope: 'episode'; season: number; episode: number };

/**
 * Deletes files for a movie, a whole show, a season or one episode. With unmonitor the app
 * also stops looking for them, otherwise they are searched for again.
 */
export function deleteFiles(ctx: AppContext, row: MonitoredRow, what: DeleteScope, unmonitor: boolean): { deleted: number; freed: number } {
  const root = rootFor(ctx, row);
  let deleted = 0;
  let freed = 0;
  const remove = (p: string) => {
    assertInside(root, p);
    if (fs.existsSync(p)) {
      freed += sizeOf(p) ?? 0;
      fs.rmSync(p);
      deleted++;
    }
    pruneEmpty(root, path.dirname(p));
  };

  if (row.kind === 'movie') {
    if (what.scope !== 'movie') throw new Error('Movies only have one file');
    if (row.filePath) remove(row.filePath);
    ctx.db.update(monitored).set({ filePath: null, fileQuality: null, ...(unmonitor ? { monitored: false } : {}) }).where(eq(monitored.id, row.id)).run();
    return { deleted, freed };
  }
  if (what.scope === 'movie') throw new Error('Pick a show, season or episode');
  const eps = episodesOf(ctx, row.id).filter((e) => what.scope === 'show' || (e.season === what.season && (what.scope === 'season' || e.episode === what.episode)));
  const paths = new Set(eps.map((e) => e.filePath).filter((p): p is string => Boolean(p)));
  for (const p of paths) remove(p);
  for (const e of episodesOf(ctx, row.id)) {
    // A multi-episode file takes its partner episodes with it.
    // Only the episodes picked are unmonitored; partners are searched for again.
    const picked = eps.some((x) => x.id === e.id);
    if (picked || (e.filePath && paths.has(e.filePath))) {
      ctx.db.update(monitoredEpisodes).set({ filePath: null, fileQuality: null, ...(unmonitor && picked ? { monitored: false } : {}) }).where(eq(monitoredEpisodes.id, e.id)).run();
    }
  }
  if (unmonitor && what.scope === 'show') ctx.db.update(monitored).set({ monitored: false }).where(eq(monitored.id, row.id)).run();
  if (unmonitor && what.scope === 'season' && row.seasons) {
    const seasons = (JSON.parse(row.seasons) as number[]).filter((s) => s !== what.season);
    ctx.db.update(monitored).set({ seasons: JSON.stringify(seasons) }).where(eq(monitored.id, row.id)).run();
  }
  return { deleted, freed };
}

/** Deletes a title's whole folder (extras and subtitles included). Used when removing a title with "delete files". */
export function deleteFolder(ctx: AppContext, row: MonitoredRow): number {
  const root = rootFor(ctx, row);
  const folder = row.path;
  if (!folder || !fs.existsSync(folder)) return 0;
  assertInside(root, folder);
  let freed = 0;
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) freed += sizeOf(full) ?? 0;
    }
  };
  walk(folder);
  fs.rmSync(folder, { recursive: true });
  return freed;
}
