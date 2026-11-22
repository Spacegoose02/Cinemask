import { and, eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { monitored, type MediaKind } from '../db/schema.js';
import type { MonitoredRow } from '../arr/monitor.js';
import { listRoots, type RootFolder } from '../arr/roots.js';
import { insideRoot } from '../lib/paths.js';
import { folderKey, locateFolder, scanFolder } from './service.js';

/**
 * Pointing titles at folders by hand: a folder browser limited to the configured root folders,
 * setting one title's folder, and the Library Import list of root-folder entries no title uses
 * yet, each with a suggested title. Nothing here reads or lists anything outside a root folder.
 */

export interface BrowseResult {
  roots: { id: string; name: string; path: string }[];
  /** The folder being listed; null when listing the root folders themselves. */
  current: string | null;
  /** One level up, or null at a root folder. */
  parent: string | null;
  rootId: string | null;
  dirs: { name: string; path: string }[];
}

const MAX_DIRS = 2000;

/**
 * The root folder of this kind that holds p (or is p), if any. Lexical only: callers check the
 * resolved path with startsWith before touching the disk, then insideRoot for symlinks.
 */
function rootFor(ctx: AppContext, kind: MediaKind, resolved: string): RootFolder | null {
  return listRoots(ctx, kind).find((r) => r.path && (resolved === path.resolve(r.path) || resolved.startsWith(path.resolve(r.path) + path.sep))) ?? null;
}

const subdirs = (dir: string) => {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('@'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
};

/** Lists the folders inside a root folder (or the root folders themselves when at is empty). */
export function browse(ctx: AppContext, kind: MediaKind, at?: string): BrowseResult {
  const roots = listRoots(ctx, kind).filter((r) => r.path);
  const rootList = roots.map((r) => ({ id: r.id, name: r.name, path: r.path }));
  if (!at)
    return {
      roots: rootList,
      current: null,
      parent: null,
      rootId: null,
      dirs: rootList.map((r) => ({ name: r.name, path: r.path })),
    };
  const current = path.resolve(at);
  const root = rootFor(ctx, kind, current);
  const base = root ? path.resolve(root.path) : '';
  // Checked here, next to the reads below: the resolved path must be the root or under it, and
  // still be once symlinks are followed.
  if (!root || !(current === base || current.startsWith(base + path.sep))) throw new Error('That folder is outside the media folders');
  if (current !== base && !insideRoot(root.path, current)) throw new Error('That folder is outside the media folders');
  if (!fs.existsSync(current) || !fs.statSync(current).isDirectory()) throw new Error('That folder does not exist');
  const atRoot = current === path.resolve(root.path);
  const dirs = subdirs(current)
    .map((name) => ({ name, path: path.join(current, name) }))
    // A symlink inside a root pointing elsewhere is left out.
    .filter((d) => insideRoot(root.path, d.path))
    .slice(0, MAX_DIRS);
  return {
    roots: rootList,
    current,
    parent: atRoot ? null : path.dirname(current),
    rootId: root.id,
    dirs,
  };
}

/**
 * Points a title at a folder chosen by hand and adopts the files in it. The folder must be an
 * existing folder strictly inside one of the root folders for the title's kind, and not one
 * another title already uses. The title moves to that root folder too.
 */
export function setFolder(ctx: AppContext, row: MonitoredRow, folder: string): ReturnType<typeof scanFolder> {
  const target = path.resolve(folder);
  const root = rootFor(ctx, row.kind, target);
  const base = root ? path.resolve(root.path) : '';
  // Strictly under the root, lexically and once symlinks are followed.
  if (!root || !target.startsWith(base + path.sep) || !insideRoot(root.path, target)) throw new Error('Pick a folder inside one of the media folders, not the media folder itself');
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error('That folder does not exist');
  const taken = ctx.db
    .select({ id: monitored.id, title: monitored.title })
    .from(monitored)
    .where(and(eq(monitored.kind, row.kind), eq(monitored.path, target)))
    .all()
    .find((r) => r.id !== row.id);
  if (taken) throw new Error(`${taken.title} already uses that folder`);
  const rootId = root.id === 'default' ? null : root.id;
  const updated = ctx.db.update(monitored).set({ path: target, rootId }).where(eq(monitored.id, row.id)).returning().get()!;
  return scanFolder(ctx, updated);
}

export interface ImportCandidate {
  folder: string;
  name: string;
  rootId: string;
  rootName: string;
  /** The best guess among monitored titles without a folder, or null. */
  suggestion: {
    id: number;
    title: string;
    year: number | null;
    score: number;
  } | null;
}

/** "Show Name (2019) [1080p] {tmdb-123}" → its title words and year. */
function folderParts(name: string): {
  key: string;
  year: number | null;
  tmdbId: number | null;
} {
  const tmdb = /tmdb(?:id)?[-= ]?(\d+)/i.exec(name);
  const year = /(?:^|[^0-9])((?:19|20)\d{2})(?![0-9])/.exec(name);
  // Title words: everything before the year or the first bracket.
  const cut = name.search(/[([{]|(?:^|[\s._-])(?:19|20)\d{2}(?![0-9])/);
  const title = cut > 0 ? name.slice(0, cut) : name;
  return {
    key: folderKey(title),
    year: year ? Number(year[1]) : null,
    tmdbId: tmdb ? Number(tmdb[1]) : null,
  };
}

/** 0–1: how alike two keys are, on shared words (Dice), with a boost when one contains the other. */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const wa = a.split(' ');
  const wb = b.split(' ');
  const sb = new Set(wb);
  const shared = wa.filter((w) => sb.has(w)).length;
  let score = (2 * shared) / (wa.length + wb.length);
  if (` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `)) score = Math.max(score, 0.8);
  return score;
}

/** How well a folder fits a title: 0 for no match, up to 1.2 with a matching year, 2 for a TMDB id tag. */
export function matchScore(folderName: string, row: Pick<MonitoredRow, 'title' | 'year' | 'tmdbId'>): number {
  const f = folderParts(folderName);
  if (f.tmdbId) return f.tmdbId === row.tmdbId ? 2 : 0;
  let s = similarity(f.key, folderKey(row.title));
  if (s < 0.5) return 0;
  if (f.year && row.year) s += Math.abs(f.year - row.year) <= 1 ? 0.2 : -0.3;
  return Math.max(0, s);
}

/**
 * Folders in the root folders of this kind that no title uses, each with the monitored title
 * (without a folder of its own) it most likely holds. A title is suggested for one folder only.
 */
export function importCandidates(ctx: AppContext, kind: MediaKind): ImportCandidate[] {
  const rows = ctx.db.select().from(monitored).where(eq(monitored.kind, kind)).all();
  const used = new Set(rows.filter((r) => r.path).map((r) => path.resolve(r.path!)));
  // A title counts as having a folder when its saved one exists or one is found automatically.
  const stillHomeless: MonitoredRow[] = [];
  for (const r of rows) {
    if (r.path && fs.existsSync(r.path)) continue;
    const found = locateFolder(ctx, r);
    if (found) used.add(path.resolve(found.folder));
    else stillHomeless.push(r);
  }
  const out: ImportCandidate[] = [];
  const nested = new Set<string>();
  for (const r of listRoots(ctx, kind)) {
    if (!r.path) continue;
    // A root folder inside another one (Kids TV inside TV) isn't a title folder of the outer one.
    for (const other of listRoots(ctx, kind)) if (other !== r && other.path && insideRoot(r.path, other.path)) nested.add(path.resolve(other.path));
    for (const name of subdirs(r.path)) {
      const folder = path.join(r.path, name);
      if (used.has(path.resolve(folder)) || nested.has(path.resolve(folder)) || !insideRoot(r.path, folder)) continue;
      out.push({
        folder,
        name,
        rootId: r.id,
        rootName: r.name,
        suggestion: null,
      });
    }
  }
  // Best pairs first, so each title goes to the folder it fits best.
  const pairs: { c: ImportCandidate; row: MonitoredRow; score: number }[] = [];
  for (const c of out) {
    for (const row of stillHomeless) {
      const score = matchScore(c.name, row);
      if (score >= 0.6) pairs.push({ c, row, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const taken = new Set<number>();
  for (const p of pairs) {
    if (p.c.suggestion || taken.has(p.row.id)) continue;
    p.c.suggestion = {
      id: p.row.id,
      title: p.row.title,
      year: p.row.year,
      score: Math.round(Math.min(p.score, 2) * 100) / 100,
    };
    taken.add(p.row.id);
  }
  return out.sort(
    (a, b) =>
      Number(Boolean(b.suggestion)) - Number(Boolean(a.suggestion)) ||
      a.name.localeCompare(b.name, undefined, {
        sensitivity: 'base',
        numeric: true,
      }),
  );
}

/** Monitored titles of this kind with no folder on disk, for picking a match by hand. */
export function titlesWithoutFolder(ctx: AppContext, kind: MediaKind): { id: number; title: string; year: number | null }[] {
  return ctx.db
    .select()
    .from(monitored)
    .where(eq(monitored.kind, kind))
    .all()
    .filter((r) => !(r.path && fs.existsSync(r.path)) && !locateFolder(ctx, r))
    .map((r) => ({ id: r.id, title: r.title, year: r.year }))
    .sort((a, b) => a.title.localeCompare(b.title));
}
