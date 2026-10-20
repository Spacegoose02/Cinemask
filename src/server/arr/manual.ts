import { and, eq, inArray } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { downloads, monitored, type MediaKind } from '../db/schema.js';
import { insideRoot } from '../lib/paths.js';
import { findVideos, importDownload, type ImportResult } from './importer.js';
import { monitorTitle } from './monitor.js';
import { parseRelease } from './parser.js';
import { defaultProfileId } from './profiles.js';

const MAX_FILES = 500;

/** Folders manual import may read from: the downloads folder and the watch folder. */
export function importFolders(ctx: AppContext): { name: string; path: string }[] {
  const m = ctx.settings.get('media');
  return [
    { name: 'Downloads', path: m.downloadsPath },
    ...(m.watchFolder ? [{ name: 'Watch folder', path: m.watchFolder }] : []),
  ].filter((f) => f.path && fs.existsSync(f.path));
}

export interface ImportableFile {
  path: string;
  folder: string;
  name: string;
  size: number;
  modifiedAt: number;
  guess: { kind: MediaKind; title: string; year: number | null; season: number | null; episodes: number[]; quality: string };
  /** Already brought into the library by an earlier import (the download keeps a hardlinked copy). */
  imported: boolean;
}

/** Video files waiting in the downloads and watch folders, newest first, with what their names suggest. */
export function listImportable(ctx: AppContext): ImportableFile[] {
  const done = ctx.db
    .select({ outputPath: downloads.outputPath })
    .from(downloads)
    .where(inArray(downloads.status, ['imported']))
    .all()
    .map((d) => d.outputPath)
    .filter((p): p is string => Boolean(p));
  const out: ImportableFile[] = [];
  for (const root of importFolders(ctx)) {
    for (const file of findVideos(root.path)) {
      if (!insideRoot(root.path, file)) continue;
      const st = fs.statSync(file);
      const rel = path.relative(root.path, file);
      // The folder name usually carries the title and year better than the file name.
      const top = rel.split(path.sep).length > 1 ? rel.split(path.sep)[0]! : path.basename(file);
      const fromFile = parseRelease(path.basename(file));
      const fromTop = parseRelease(top);
      const season = fromFile.season ?? fromTop.season;
      out.push({
        path: file,
        folder: root.name,
        name: rel,
        size: st.size,
        modifiedAt: st.mtimeMs,
        guess: {
          kind: season !== null ? 'show' : 'movie',
          title: fromTop.title || fromFile.title,
          year: fromTop.year ?? fromFile.year,
          season,
          episodes: fromFile.episodes.length ? fromFile.episodes : fromTop.episodes,
          quality: fromFile.quality !== 'Unknown' ? fromFile.quality : fromTop.quality,
        },
        imported: done.some((p) => file === p || file.startsWith(`${p.replace(/\/+$/, '')}${path.sep}`)),
      });
    }
  }
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, MAX_FILES);
}

/** Imports one file as the movie or episode picked by hand, monitoring the title if it isn't yet. */
export async function manualImport(
  ctx: AppContext,
  input: { path: string; kind: MediaKind; tmdbId: number; season?: number; episodes?: number[]; mode?: 'hardlink' | 'copy' | 'move'; userId: number },
): Promise<ImportResult & { monitoredId: number }> {
  if (!importFolders(ctx).some((f) => insideRoot(f.path, input.path))) throw new Error('Only files in the downloads or watch folder can be imported');
  if (!findVideos(input.path).includes(input.path)) throw new Error('That file is gone or is not a video');
  if (input.kind === 'show' && (input.season === undefined || !input.episodes?.length)) throw new Error('Pick the season and episode');
  const existing = ctx.db.select().from(monitored).where(and(eq(monitored.kind, input.kind), eq(monitored.tmdbId, input.tmdbId))).get();
  const row = existing ?? (await monitorTitle(ctx, { kind: input.kind, tmdbId: input.tmdbId, profileId: defaultProfileId(ctx, input.kind), addedBy: input.userId }));
  const episode = input.kind === 'show' ? { season: input.season!, episodes: input.episodes! } : undefined;
  const dl = ctx.db
    .insert(downloads)
    .values({
      monitoredId: row.id,
      episodes: episode ? JSON.stringify(episode) : null,
      title: path.basename(input.path),
      protocol: 'direct',
      indexer: 'Manual import',
      status: 'importing',
      progress: 1,
      size: fs.statSync(input.path).size,
      addedBy: input.userId,
      addedAt: Date.now(),
      completedAt: Date.now(),
    })
    .returning()
    .get();
  let result: ImportResult;
  try {
    result = importDownload(ctx, dl.id, input.path, { mode: input.mode, episode, replace: true });
  } catch (err) {
    ctx.db.update(downloads).set({ status: 'failed', error: (err as Error).message }).where(eq(downloads.id, dl.id)).run();
    throw err;
  }
  if (!result.imported.length) throw new Error(result.skipped.join('; ') || 'Nothing was imported');
  return { ...result, monitoredId: row.id };
}
