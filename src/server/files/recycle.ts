import fs from 'node:fs';
import path from 'node:path';
import { eq, lt } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { recycleBin, type MediaKind } from '../db/schema.js';
import { insideRoot } from '../lib/paths.js';

/**
 * The recycle bin: deleted files go to a hidden ".cinemask-recycle" folder in the same media
 * folder (so it's a quick rename on the same disk) and are deleted for good after the number of
 * days in Settings → Storage. Plex and Jellyfin skip folders whose name starts with a dot.
 */
export const BIN_DIR = '.cinemask-recycle';

function sizeOf(p: string): number {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    return fs.readdirSync(p).reduce((n, f) => n + sizeOf(path.join(p, f)), 0);
  } catch {
    return 0;
  }
}

function move(from: string, to: string) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true });
  }
}

export interface DiscardInfo {
  kind: MediaKind;
  tmdbId: number | null;
  title: string;
  reason?: string;
  by?: string | null;
}

/**
 * Deletes a file or folder inside a media folder: into the recycle bin when that's on, for good
 * otherwise. Returns the bytes freed (or moved to the bin).
 */
export function discard(ctx: AppContext, root: string, target: string, info: DiscardInfo): number {
  if (!insideRoot(root, target)) throw new Error(`Refusing to touch ${target}: it is outside ${root}`);
  if (!fs.existsSync(target)) return 0;
  const size = sizeOf(target);
  const bin = path.join(root, BIN_DIR);
  // Something already in the bin is deleted for good.
  if (!ctx.settings.get('storage').recycleBin || insideRoot(bin, target)) {
    fs.rmSync(target, { recursive: true });
    return size;
  }
  const dest = path.join(bin, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, path.relative(root, target));
  if (!insideRoot(root, dest)) throw new Error('Refusing to move outside the media folder');
  move(target, dest);
  ctx.db
    .insert(recycleBin)
    .values({ kind: info.kind, tmdbId: info.tmdbId, title: info.title, originalPath: target, binPath: dest, size, reason: info.reason ?? null, deletedByName: info.by ?? null, deletedAt: Date.now() })
    .run();
  return size;
}

/** Puts a file or folder back where it was. */
export function restore(ctx: AppContext, id: number, roots: string[]): { path: string } {
  const r = ctx.db.select().from(recycleBin).where(eq(recycleBin.id, id)).get();
  if (!r) throw new Error('Not in the recycle bin');
  const root = roots.find((x) => insideRoot(x, r.originalPath) && insideRoot(path.join(x, BIN_DIR), r.binPath));
  if (!root) throw new Error("Its media folder isn't set up any more");
  if (!fs.existsSync(r.binPath)) {
    ctx.db.delete(recycleBin).where(eq(recycleBin.id, id)).run();
    throw new Error('The files are no longer in the recycle bin');
  }
  if (fs.existsSync(r.originalPath)) throw new Error('Something else is already where it was');
  move(r.binPath, r.originalPath);
  removeEmptyBinFolder(root, r.binPath);
  ctx.db.delete(recycleBin).where(eq(recycleBin.id, id)).run();
  return { path: r.originalPath };
}

/** Deletes one item from the recycle bin for good. */
export function purge(ctx: AppContext, id: number, roots: string[]): number {
  const r = ctx.db.select().from(recycleBin).where(eq(recycleBin.id, id)).get();
  if (!r) return 0;
  const root = roots.find((x) => insideRoot(path.join(x, BIN_DIR), r.binPath));
  if (root && fs.existsSync(r.binPath)) {
    fs.rmSync(r.binPath, { recursive: true });
    removeEmptyBinFolder(root, r.binPath);
  }
  ctx.db.delete(recycleBin).where(eq(recycleBin.id, id)).run();
  return r.size;
}

/** The per-deletion folder ("<time>-<random>") goes once it's empty. */
function removeEmptyBinFolder(root: string, binPath: string) {
  const bin = path.join(root, BIN_DIR);
  let cur = path.dirname(binPath);
  while (insideRoot(bin, cur) && path.resolve(cur) !== path.resolve(bin) && fs.existsSync(cur) && !fs.readdirSync(cur).length) {
    fs.rmdirSync(cur);
    cur = path.dirname(cur);
  }
}

/** Background job: empties what's been in the bin longer than the setting allows. */
export function emptyOldRecycled(ctx: AppContext, roots: string[]): number {
  const days = ctx.settings.get('storage').recycleDays;
  const old = ctx.db.select().from(recycleBin).where(lt(recycleBin.deletedAt, Date.now() - days * 24 * 60 * 60 * 1000)).all();
  for (const r of old) purge(ctx, r.id, roots);
  return old.length;
}
