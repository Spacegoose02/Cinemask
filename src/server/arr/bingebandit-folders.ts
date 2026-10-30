import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.js';
import type { MediaKind } from '../db/schema.js';
import { BingeBanditClient } from '../integrations/bingebandit.js';
import { badRequest } from '../lib/errors.js';
import { listRoots } from './roots.js';

/** A BingeBandit library folder, and where Cinemask sees it (null when it can't find it). */
export interface LibraryFolder {
  id: string;
  name: string;
  kind: MediaKind;
  /** The folder as BingeBandit sees it. */
  bingePath: string;
  path: string | null;
  /** The name of the Cinemask folder already at that path, if any. */
  existing: string | null;
}

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const same = (a: string, b: string) => path.resolve(a) === path.resolve(b);

/** A folder id ("Kids Movies" → "kids-movies") no other folder uses. */
function folderId(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34) || 'folder';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/**
 * BingeBandit's movie and show library folders, found on Cinemask's side, so they can become root
 * folders (Kids Movies, 4K, …). The two apps usually see the media share at different paths, so
 * each folder is looked for as is, next to Cinemask's own folders ("/data/Kids Movies" beside
 * "/data/Movies"), and under the same parent as a BingeBandit folder that matches one of
 * Cinemask's by name.
 */
export async function bingeBanditFolders(ctx: AppContext): Promise<LibraryFolder[]> {
  const bb = ctx.settings.get('bingebandit');
  if (!bb.enabled || !bb.url || !bb.apiKey) throw badRequest('Connect BingeBandit in Settings → Media servers first');
  const libs = await new BingeBanditClient(bb.url, bb.apiKey).libraries();
  if (libs.length && libs.every((l) => !l.paths?.length)) throw badRequest("BingeBandit didn't share its library folders: the API key must belong to a BingeBandit admin");
  const roots = listRoots(ctx);
  const allPaths = libs.flatMap((l) => l.paths ?? []);
  const taken = new Set(['default', ...roots.map((r) => r.id)]);
  const out: LibraryFolder[] = [];
  for (const lib of libs) {
    const kind: MediaKind = lib.kind === 'movies' ? 'movie' : 'show';
    const paths = lib.paths ?? [];
    for (const bingePath of paths) {
      const candidates = [bingePath];
      for (const r of roots) {
        candidates.push(path.join(path.dirname(r.path), path.basename(bingePath)));
        // A BingeBandit folder named like this Cinemask folder gives the two apps' paths to the share.
        for (const p of allPaths) {
          const parent = path.posix.dirname(p);
          if (path.basename(p) === path.basename(r.path) && bingePath.startsWith(`${parent}/`)) {
            candidates.push(path.join(path.dirname(r.path), path.posix.relative(parent, bingePath)));
          }
        }
      }
      const found = candidates.find(isDir) ?? null;
      const existing = found ? (roots.find((r) => same(r.path, found))?.name ?? null) : null;
      const name = paths.length > 1 ? `${lib.name} (${path.basename(bingePath)})` : lib.name;
      out.push({ id: existing ? '' : folderId(name, taken), name, kind, bingePath, path: found, existing });
    }
  }
  return out;
}
