import { and, eq, isNotNull, sql } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { libraryItems, monitored, monitoredEpisodes, type MediaKind } from '../db/schema.js';
import { findVideos } from '../arr/importer.js';
import { parseRelease } from '../arr/parser.js';
import { isExtra, rootFor, scanFolder } from './service.js';
import { insideRoot } from '../lib/paths.js';
import { discard } from './recycle.js';

export interface DuplicateFile {
  path: string;
  size: number;
  quality: string;
  /** The file Cinemask counts as the title's (or episode's) copy. */
  tracked: boolean;
}

export interface DuplicateGroup {
  monitoredId: number;
  kind: MediaKind;
  tmdbId: number;
  title: string;
  year: number | null;
  /** "S01E02" for an episode, null for a movie. */
  episode: string | null;
  files: DuplicateFile[];
}

/**
 * More than one video for the same movie or episode in the folders Cinemask manages, plus titles
 * Plex or Jellyfin list more than once (two copies in different libraries, or a split item).
 */
export function findDuplicates(ctx: AppContext): { files: DuplicateGroup[]; servers: { server: string; kind: MediaKind; tmdbId: number; title: string; year: number | null; count: number }[] } {
  const groups: DuplicateGroup[] = [];
  for (const row of ctx.db.select().from(monitored).where(isNotNull(monitored.path)).all()) {
    if (!row.path || !fs.existsSync(row.path) || !insideRoot(rootFor(ctx, row), row.path)) continue;
    const videos = findVideos(row.path).filter((f) => !isExtra(row.path!, f));
    const tracked = new Set<string>(row.filePath ? [row.filePath] : []);
    const entry = (f: string): DuplicateFile => ({ path: f, size: fs.statSync(f).size, quality: parseRelease(path.basename(f)).quality, tracked: tracked.has(f) });
    const base = { monitoredId: row.id, kind: row.kind, tmdbId: row.tmdbId, title: row.title, year: row.year };
    if (row.kind === 'movie') {
      if (videos.length > 1) groups.push({ ...base, episode: null, files: videos.map(entry) });
      continue;
    }
    for (const e of ctx.db.select({ filePath: monitoredEpisodes.filePath }).from(monitoredEpisodes).where(and(eq(monitoredEpisodes.monitoredId, row.id), isNotNull(monitoredEpisodes.filePath))).all()) tracked.add(e.filePath!);
    const byEpisode = new Map<string, string[]>();
    for (const f of videos) {
      const p = parseRelease(path.basename(f));
      if (p.season === null || !p.episodes.length) continue;
      for (const ep of p.episodes) {
        const key = `S${String(p.season).padStart(2, '0')}E${String(ep).padStart(2, '0')}`;
        byEpisode.set(key, [...(byEpisode.get(key) ?? []), f]);
      }
    }
    for (const [key, files] of [...byEpisode].sort(([a], [b]) => a.localeCompare(b))) {
      if (files.length > 1) groups.push({ ...base, episode: key, files: files.map(entry) });
    }
  }
  const servers = ctx.db
    .select({ server: libraryItems.server, kind: libraryItems.kind, tmdbId: libraryItems.tmdbId, title: sql<string>`min(${libraryItems.title})`, year: sql<number | null>`min(${libraryItems.year})`, count: sql<number>`count(*)` })
    .from(libraryItems)
    .where(isNotNull(libraryItems.tmdbId))
    .groupBy(libraryItems.server, libraryItems.kind, libraryItems.tmdbId)
    .having(sql`count(*) > 1`)
    .all()
    .map((r) => ({ ...r, tmdbId: r.tmdbId! }));
  return { files: groups, servers };
}

/** Deletes one copy of a duplicated movie or episode. The last copy can't be deleted from here. */
export function deleteDuplicate(ctx: AppContext, monitoredId: number, file: string): { freed: number } {
  const row = ctx.db.select().from(monitored).where(eq(monitored.id, monitoredId)).get();
  if (!row?.path) throw new Error('That title has no folder');
  if (!insideRoot(rootFor(ctx, row), file) || !insideRoot(row.path, file)) throw new Error('That file is not in this title’s folder');
  const group = findDuplicates(ctx).files.find((g) => g.monitoredId === row.id && g.files.some((f) => f.path === file));
  if (!group) throw new Error('That file is not one of several copies');
  const freed = discard(ctx, rootFor(ctx, row), file, { kind: row.kind, tmdbId: row.tmdbId, title: row.title, reason: 'Duplicate copy' });
  // If it was the tracked copy, the scan picks up the one that's left.
  if (row.filePath === file) ctx.db.update(monitored).set({ filePath: null, fileQuality: null }).where(eq(monitored.id, row.id)).run();
  ctx.db.update(monitoredEpisodes).set({ filePath: null, fileQuality: null }).where(and(eq(monitoredEpisodes.monitoredId, row.id), eq(monitoredEpisodes.filePath, file))).run();
  scanFolder(ctx, ctx.db.select().from(monitored).where(eq(monitored.id, row.id)).get()!);
  return { freed };
}
