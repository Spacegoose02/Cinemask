import { and, eq, gte } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { downloads, monitored } from '../db/schema.js';
import { insideRoot } from '../lib/paths.js';
import { tmdbClient } from '../library/service.js';
import { notify } from '../notify/service.js';
import { findVideos, importDownload } from './importer.js';
import { monitorTitle } from './monitor.js';
import { parseRelease } from './parser.js';
import { defaultProfileId } from './profiles.js';
import { refreshMediaServers } from './tracker.js';
import { listRoots } from './roots.js';

/** A drop is left alone until nothing in it has changed for this long, so half-copied files aren't moved. */
const SETTLE_MS = 2 * 60 * 1000;

/** Drops that couldn't be imported, by name and last change, so they aren't retried until something changes. */
const failed = new Map<string, number>();

/** For tests: what a restart does to the memory above. */
export function forgetWatchFailures() {
  failed.clear();
}

function lastChange(p: string): number {
  // Only the videos count: a folder's own time changes whenever anything inside it does.
  let latest = 0;
  for (const f of findVideos(p)) latest = Math.max(latest, fs.statSync(f).mtimeMs);
  return latest;
}

/** Finds the movie or show a drop is, from its folder or file name; episodes (S01E02) mean a show. */
async function identify(ctx: AppContext, name: string, videos: string[]) {
  const parsed = parseRelease(name);
  const isShow = parsed.season !== null || videos.some((v) => parseRelease(path.basename(v)).season !== null);
  const fromFile = parseRelease(path.basename(videos[0]!));
  const title = parsed.title || fromFile.title;
  const year = parsed.year ?? fromFile.year;
  if (!title) return null;
  const kind = isShow ? 'show' : 'movie';
  const tmdb = tmdbClient(ctx);
  let results = (await tmdb.searchKind(isShow ? 'tv' : 'movie', title, year)).results;
  // A wrong year in the name shouldn't hide the title.
  if (!results.length && year) results = (await tmdb.searchKind(isShow ? 'tv' : 'movie', title)).results;
  const hit = results[0];
  return hit ? { kind: kind as 'movie' | 'show', tmdbId: hit.id } : null;
}

/**
 * Imports movies and shows dropped in the watch folder (Settings → Media management): each file or
 * folder is matched on TMDB, monitored, and moved into its library folder with the naming format.
 * Anything that can't be matched stays where it is and shows as a failed import on Downloads.
 */
export async function scanWatchFolder(ctx: AppContext): Promise<number> {
  const watch = ctx.settings.get('media').watchFolder;
  if (!watch || !fs.existsSync(watch) || !tmdbClient(ctx).configured) return 0;
  // A watch folder that is (or holds) a library folder would import the library into itself.
  const same = (a: string, b: string) => path.resolve(a) === path.resolve(b) || insideRoot(a, b) || insideRoot(b, a);
  if (listRoots(ctx).some((r) => same(watch, r.path))) return 0;
  let imported = 0;
  for (const entry of fs.readdirSync(watch, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
    const full = path.join(watch, entry.name);
    if (!insideRoot(watch, full)) continue;
    const videos = findVideos(full);
    if (!videos.length) continue;
    const changed = lastChange(full);
    if (Date.now() - changed < SETTLE_MS || failed.get(entry.name) === changed) continue;
    // Failed already and unchanged since (the memory above is lost on restart): don't add the same failure again.
    const before = ctx.db
      .select({ id: downloads.id })
      .from(downloads)
      .where(and(eq(downloads.indexer, 'Watch folder'), eq(downloads.title, entry.name), eq(downloads.status, 'failed'), gte(downloads.addedAt, Math.floor(changed))))
      .get();
    if (before) {
      failed.set(entry.name, changed);
      continue;
    }
    const dl = ctx.db
      .insert(downloads)
      .values({ title: entry.name, protocol: 'direct', indexer: 'Watch folder', status: 'importing', progress: 1, size: videos.reduce((n, v) => n + fs.statSync(v).size, 0), addedAt: Date.now(), completedAt: Date.now() })
      .returning()
      .get();
    try {
      const match = await identify(ctx, entry.isDirectory() ? entry.name : path.parse(entry.name).name, videos);
      if (!match) throw new Error('Could not find this on TMDB. Rename it like "Title (Year)" or "Show S01E02".');
      const existing = ctx.db.select().from(monitored).where(and(eq(monitored.kind, match.kind), eq(monitored.tmdbId, match.tmdbId))).get();
      const row = existing ?? (await monitorTitle(ctx, { kind: match.kind, tmdbId: match.tmdbId, profileId: defaultProfileId(ctx, match.kind) }));
      ctx.db.update(downloads).set({ monitoredId: row.id }).where(eq(downloads.id, dl.id)).run();
      const result = importDownload(ctx, dl.id, full, { mode: 'move' });
      if (!result.imported.length) {
        if (result.skipped.length && result.skipped.every((r) => r.endsWith('existing file is as good or better'))) {
          throw new Error(`${row.title} is already in the library at this quality or better. Delete this copy from Downloads → Import, or import it there to replace the library file.`);
        }
        throw new Error(result.skipped.join('; ') || 'Nothing to import');
      }
      imported += result.imported.length;
      // A folder whose videos all moved only holds leftovers (samples, .nfo, artwork) now.
      if (entry.isDirectory() && !findVideos(full).length) fs.rmSync(full, { recursive: true, force: true });
      // Episodes it couldn't place stay put; they're looked at again once something in the folder changes.
      if (fs.existsSync(full)) failed.set(entry.name, lastChange(full));
      else failed.delete(entry.name);
    } catch (err) {
      failed.set(entry.name, changed);
      ctx.db.update(downloads).set({ status: 'failed', error: (err as Error).message }).where(eq(downloads.id, dl.id)).run();
      notify(ctx, { event: 'download.failed', title: 'Watch folder import failed', message: `${entry.name}: ${(err as Error).message}`, data: { release: entry.name } });
    }
  }
  if (imported) await refreshMediaServers(ctx);
  return imported;
}
