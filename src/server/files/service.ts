import { and, eq, isNotNull } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { media, monitored, monitoredEpisodes, type MediaKind } from '../db/schema.js';
import { findVideos } from '../arr/importer.js';
import type { MonitoredRow } from '../arr/monitor.js';
import { renderName } from '../arr/naming.js';
import { parseRelease } from '../arr/parser.js';
import { insideRoot } from '../lib/paths.js';
import { listRoots, rootOf } from '../arr/roots.js';

export { insideRoot };

/**
 * File management for monitored titles: list, adopt existing files, rename to the naming
 * templates and delete. Every path is checked against the configured media root (after
 * resolving symlinks) so a bad template or a tampered row can never touch anything else.
 */

/** The media root a title lives in: its chosen root folder, or the main Movies or TV folder. */
export function rootFor(ctx: AppContext, row: Pick<MonitoredRow, 'kind' | 'rootId'>): string {
  return rootOf(ctx, row).path;
}

/**
 * Moves a title's folder into another root folder (Kids Movies → Movies, say) and points every
 * tracked file at its new place. Renames on the same disk; copies then deletes across disks.
 * A folder Cinemask hasn't recorded (a title imported from Plex, or not managed at all) is found
 * by name first. A row with id 0 (from titleOnDisk) is only moved on disk.
 */
export function moveToRoot(ctx: AppContext, row: MonitoredRow, rootId: string): MonitoredRow {
  if (!row.path || !fs.existsSync(row.path)) {
    const found = locateFolder(ctx, row);
    if (found) row = { ...row, path: found.folder, rootId: found.rootId === 'default' ? null : found.rootId };
  }
  const from = rootFor(ctx, row);
  const to = rootFor(ctx, { kind: row.kind, rootId });
  const next = rootId === 'default' ? null : rootId;
  const save = (values: Partial<MonitoredRow>) => (row.id ? ctx.db.update(monitored).set(values).where(eq(monitored.id, row.id)).returning().get() : { ...row, ...values });
  if (!row.path || !fs.existsSync(row.path) || from === to) {
    // Nothing on disk yet (or same place): new downloads just go to the new folder.
    return save({ rootId: next, path: row.path && from !== to ? null : row.path });
  }
  assertInside(from, row.path);
  const dest = path.join(to, path.basename(row.path));
  assertInside(to, dest);
  if (fs.existsSync(dest)) throw new Error(`${dest} already exists`);
  fs.mkdirSync(to, { recursive: true });
  try {
    fs.renameSync(row.path, dest);
  } catch {
    fs.cpSync(row.path, dest, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    fs.rmSync(row.path, { recursive: true });
  }
  return repoint(ctx, row, dest, rootId);
}

/** Points a title and its tracked files at the folder it now sits in, in root folder rootId. */
function repoint(ctx: AppContext, row: MonitoredRow, dest: string, rootId: string): MonitoredRow {
  const from = row.path!;
  const moved = (p: string | null) => (p && (p === from || p.startsWith(`${from}${path.sep}`)) ? path.join(dest, path.relative(from, p)) : p);
  const values = { rootId: rootId === 'default' ? null : rootId, path: dest, filePath: moved(row.filePath) };
  if (!row.id) return { ...row, ...values };
  for (const e of episodesOf(ctx, row.id)) {
    if (e.filePath) ctx.db.update(monitoredEpisodes).set({ filePath: moved(e.filePath) }).where(eq(monitoredEpisodes.id, e.id)).run();
  }
  return ctx.db.update(monitored).set(values).where(eq(monitored.id, row.id)).returning().get()!;
}

/**
 * A title whose folder was moved outside Cinemask, such as by BingeBandit's "Move to library"
 * (Movies → Kids Movies), is found again in whichever root folder holds it now: first by the
 * folder's own name, then the way locateFolder looks. Its root folder, path and tracked files
 * follow, so upgrades land beside it rather than in the old folder. Unchanged when the folder is
 * still there or can't be found.
 */
export function followMovedFolder(ctx: AppContext, row: MonitoredRow): MonitoredRow {
  if (!row.path || fs.existsSync(row.path)) return row;
  const name = path.basename(row.path);
  let found: { folder: string; rootId: string } | null = null;
  for (const r of listRoots(ctx, row.kind)) {
    const folder = path.join(r.path, name);
    if (insideRoot(r.path, folder) && fs.existsSync(folder)) {
      found = { folder, rootId: r.id };
      break;
    }
  }
  found ??= locateFolder(ctx, row);
  return found ? repoint(ctx, row, found.folder, found.rootId) : row;
}

/** Runs followMovedFolder over every title with a folder; returns how many moved. */
export function followMovedFolders(ctx: AppContext): number {
  let n = 0;
  for (const row of ctx.db.select().from(monitored).where(isNotNull(monitored.path)).all()) {
    try {
      if (followMovedFolder(ctx, row) !== row) n++;
    } catch {
      // A folder that can't be read is looked for again next sync.
    }
  }
  return n;
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

/** Extras named the Plex way ("Movie-trailer.mkv", or in a "Trailers" or "Featurettes" folder) sit next to a movie on purpose; they aren't the movie. */
const EXTRA_FILE = /-(trailer|teaser|featurette|behindthescenes|deleted|interview|scene|short|other|sample)$/i;
const EXTRA_DIR = /^(trailers|featurettes|behind the scenes|deleted scenes|interviews|scenes|shorts|other|extras|samples?)$/i;
export const isExtra = (folder: string, file: string) => EXTRA_FILE.test(path.basename(file, path.extname(file))) || path.relative(folder, file).split(path.sep).slice(0, -1).some((d) => EXTRA_DIR.test(d));

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

const folderKey = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');

/**
 * Finds a title's existing folder when it isn't named the way Cinemask would name it, such as
 * "Paddington (2014) {tmdb-116149}" or "Paddington.2014.1080p", in any root folder of its kind.
 * A folder carrying the TMDB id wins; otherwise the name must start with the title and, when
 * the year is known, contain it.
 */
export function locateFolder(ctx: AppContext, row: MonitoredRow): { folder: string; rootId: string } | null {
  const expected = expectedFolder(ctx, row);
  if (fs.existsSync(expected)) return { folder: expected, rootId: row.rootId ?? 'default' };
  const title = folderKey(row.title);
  if (!title) return null;
  const idTag = new RegExp(`(tmdb(id)?[-= ]?${row.tmdbId})(?!\\d)`, 'i');
  let byName: { folder: string; rootId: string } | null = null;
  const roots = listRoots(ctx, row.kind);
  // The title's own root first.
  roots.sort((a, b) => Number(b.id === (row.rootId ?? 'default')) - Number(a.id === (row.rootId ?? 'default')));
  for (const r of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(r.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const folder = path.join(r.path, e.name);
      if (!insideRoot(r.path, folder)) continue;
      if (idTag.test(e.name)) return { folder, rootId: r.id };
      const key = folderKey(e.name);
      if (!byName && (key === title || key.startsWith(`${title} `)) && (!row.year || key.slice(title.length).split(' ').includes(String(row.year)) || key === title)) byName = { folder, rootId: r.id };
    }
  }
  return byName;
}

/**
 * A title as it sits on disk: its monitored row with the folder filled in when one is found. For a
 * title Cinemask doesn't manage, a stand-in row built from its details, so its folder and trailers
 * can still be shown. Null when there's no folder.
 */
export function titleOnDisk(ctx: AppContext, kind: MediaKind, tmdbId: number): MonitoredRow | null {
  let row = ctx.db.select().from(monitored).where(and(eq(monitored.kind, kind), eq(monitored.tmdbId, tmdbId))).get() ?? null;
  if (!row) {
    const m = ctx.db.select().from(media).where(and(eq(media.kind, kind), eq(media.tmdbId, tmdbId))).get();
    if (!m) return null;
    row = { id: 0, kind, tmdbId, title: m.title, year: m.year, rootId: null, path: null, filePath: null, fileQuality: null } as MonitoredRow;
  }
  if (row.path && fs.existsSync(row.path)) return row;
  const found = locateFolder(ctx, row);
  return found ? { ...row, path: found.folder, rootId: found.rootId === 'default' ? null : found.rootId } : null;
}

/**
 * Finds video files already in the title's folder and links them to the movie or episodes,
 * so existing libraries can be managed without re-downloading. Tracked files that vanished
 * from disk are forgotten.
 */
export function scanFolder(ctx: AppContext, row: MonitoredRow): { found: number; missing: number; folder: string } {
  const located = row.path ? null : locateFolder(ctx, row);
  if (located && (located.rootId ?? 'default') !== (row.rootId ?? 'default')) {
    ctx.db.update(monitored).set({ rootId: located.rootId === 'default' ? null : located.rootId }).where(eq(monitored.id, row.id)).run();
    row = { ...row, rootId: located.rootId === 'default' ? null : located.rootId };
  }
  const root = rootFor(ctx, row);
  const folder = row.path ?? located?.folder ?? expectedFolder(ctx, row);
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
    const movies = videos.filter((f) => !isExtra(folder, f));
    if (!current && movies.length) {
      const file = movies.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0]!;
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
