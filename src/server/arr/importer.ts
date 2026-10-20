import { and, eq } from 'drizzle-orm';
import { requestAvailable } from '../notify/events.js';
import { notify } from '../notify/service.js';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { downloads, monitored, monitoredEpisodes, requests } from '../db/schema.js';
import { renderName } from './naming.js';
import { parseRelease, VIDEO_EXTENSIONS } from './parser.js';
import { insideRoot } from '../lib/paths.js';
import { qualityRank } from './quality.js';

const SAMPLE_MAX = 80 * 1024 * 1024;

/** Converts a path reported by a download client (its own container) to the path inside this one. */
export function mapRemotePath(ctx: AppContext, remote: string): string {
  const mappings = ctx.settings.get('media').remotePathMappings;
  const norm = remote.replace(/\\/g, '/');
  for (const m of [...mappings].sort((a, b) => b.remote.length - a.remote.length)) {
    const from = m.remote.replace(/\\/g, '/').replace(/\/+$/, '');
    if (norm === from || norm.startsWith(`${from}/`)) return path.join(m.local, norm.slice(from.length));
  }
  return norm;
}

/** Video files in a download, skipping samples and extras. */
export function findVideos(p: string): string[] {
  if (!fs.existsSync(p)) return [];
  const st = fs.statSync(p);
  if (st.isFile()) return VIDEO_EXTENSIONS.includes(path.extname(p).toLowerCase()) ? [p] : [];
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue; // never follow links out of the download folder
      if (e.isDirectory()) walk(full, depth + 1);
      else if (VIDEO_EXTENSIONS.includes(path.extname(e.name).toLowerCase())) out.push(full);
    }
  };
  walk(p, 0);
  const real = out.filter((f) => !/\bsample\b/i.test(path.basename(f)) || fs.statSync(f).size > SAMPLE_MAX);
  return real.length ? real : out;
}

/** Places a file at dest using the configured import mode. Hardlinks fall back to copying across disks. */
export function placeFile(src: string, dest: string, mode: 'hardlink' | 'copy' | 'move') {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.rmSync(dest);
  if (mode === 'move') {
    try {
      fs.renameSync(src, dest);
    } catch {
      fs.copyFileSync(src, dest);
      fs.rmSync(src);
    }
    return;
  }
  if (mode === 'hardlink') {
    try {
      fs.linkSync(src, dest);
      return;
    } catch {
      // different filesystem: copy instead
    }
  }
  fs.copyFileSync(src, dest);
}

/** Refuses any destination outside the media root, whatever the naming template produced. */
const inside = insideRoot;

export interface ImportResult {
  imported: string[];
  skipped: string[];
}

export function importDownload(ctx: AppContext, downloadId: number, sourcePath: string): ImportResult {
  const dl = ctx.db.select().from(downloads).where(eq(downloads.id, downloadId)).get();
  if (!dl?.monitoredId) throw new Error('This download is not linked to a movie or show');
  const row = ctx.db.select().from(monitored).where(eq(monitored.id, dl.monitoredId)).get();
  if (!row) throw new Error('The movie or show was removed');
  const mediaSettings = ctx.settings.get('media');
  const naming = ctx.settings.get('naming');
  const files = findVideos(mapRemotePath(ctx, sourcePath));
  if (!files.length) throw new Error(`No video files found at ${sourcePath}`);
  const result: ImportResult = { imported: [], skipped: [] };

  if (row.kind === 'movie') {
    const root = mediaSettings.moviesPath;
    const file = files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0]!;
    const quality = dl.quality ?? parseRelease(path.basename(file)).quality;
    const folder = row.path ?? path.join(root, renderName(naming.movieFolder, { movieTitle: row.title, year: row.year, tmdbId: row.tmdbId }));
    const name = naming.renameFiles ? renderName(naming.movieFile, { movieTitle: row.title, year: row.year, quality, tmdbId: row.tmdbId }) : path.parse(file).name;
    const dest = path.join(folder, `${name}${path.extname(file).toLowerCase()}`);
    if (!inside(root, dest)) throw new Error('Refusing to write outside the movies folder');
    if (row.filePath && row.fileQuality && qualityRank(row.fileQuality) >= qualityRank(quality)) {
      result.skipped.push(`${path.basename(file)}: existing file is as good or better`);
    } else {
      placeFile(file, dest, mediaSettings.importMode);
      if (row.filePath && row.filePath !== dest && inside(root, row.filePath) && fs.existsSync(row.filePath)) fs.rmSync(row.filePath);
      ctx.db.update(monitored).set({ path: folder, filePath: dest, fileQuality: quality }).where(eq(monitored.id, row.id)).run();
      result.imported.push(dest);
    }
  } else {
    const root = mediaSettings.tvPath;
    const seriesFolder = row.path ?? path.join(root, renderName(naming.seriesFolder, { seriesTitle: row.title, year: row.year, tmdbId: row.tmdbId }));
    const grabbed = dl.episodes ? (JSON.parse(dl.episodes) as { season: number; episodes: number[] }) : null;
    for (const file of files) {
      const parsed = parseRelease(path.basename(file));
      const season = parsed.season ?? grabbed?.season ?? null;
      const eps = parsed.episodes.length ? parsed.episodes : grabbed?.episodes.length === 1 ? grabbed.episodes : [];
      if (season === null || !eps.length) {
        result.skipped.push(`${path.basename(file)}: could not tell which episode it is`);
        continue;
      }
      const epRows = eps
        .map((n) => ctx.db.select().from(monitoredEpisodes).where(and(eq(monitoredEpisodes.monitoredId, row.id), eq(monitoredEpisodes.season, season), eq(monitoredEpisodes.episode, n))).get())
        .filter((e): e is NonNullable<typeof e> => Boolean(e));
      if (!epRows.length) {
        result.skipped.push(`${path.basename(file)}: S${season}E${eps.join('E')} is not a known episode`);
        continue;
      }
      const quality = parsed.quality !== 'Unknown' ? parsed.quality : (dl.quality ?? 'Unknown');
      if (epRows.every((e) => e.fileQuality && qualityRank(e.fileQuality) >= qualityRank(quality))) {
        result.skipped.push(`${path.basename(file)}: existing file is as good or better`);
        continue;
      }
      const values = { seriesTitle: row.title, year: row.year, season, episodes: eps, episodeTitle: epRows.length === 1 ? epRows[0]!.title : epRows.map((e) => e.title).join(' + '), quality, tmdbId: row.tmdbId };
      const dir = path.join(seriesFolder, renderName(naming.seasonFolder, values));
      const name = naming.renameFiles ? renderName(naming.episodeFile, values) : path.parse(file).name;
      const dest = path.join(dir, `${name}${path.extname(file).toLowerCase()}`);
      if (!inside(root, dest)) throw new Error('Refusing to write outside the TV folder');
      placeFile(file, dest, mediaSettings.importMode);
      for (const e of epRows) {
        if (e.filePath && e.filePath !== dest && inside(root, e.filePath) && fs.existsSync(e.filePath)) fs.rmSync(e.filePath);
        ctx.db.update(monitoredEpisodes).set({ filePath: dest, fileQuality: quality }).where(eq(monitoredEpisodes.id, e.id)).run();
      }
      result.imported.push(dest);
    }
    ctx.db.update(monitored).set({ path: seriesFolder }).where(eq(monitored.id, row.id)).run();
  }

  if (result.imported.length) {
    ctx.db.update(downloads).set({ status: 'imported', importedAt: Date.now(), outputPath: sourcePath, error: null }).where(eq(downloads.id, dl.id)).run();
    if (row.kind === 'movie') {
      const open = ctx.db.select().from(requests).where(and(eq(requests.monitoredId, row.id), eq(requests.status, 'approved'))).all();
      ctx.db.update(requests).set({ status: 'available' }).where(and(eq(requests.monitoredId, row.id), eq(requests.status, 'approved'))).run();
      for (const r of open) requestAvailable(ctx, r);
    }
    notify(ctx, { event: 'download.imported', title: 'Download imported', message: `${row.title}${row.year ? ` (${row.year})` : ''} is ready to watch`, data: { kind: row.kind, tmdbId: row.tmdbId, release: dl.title } });
  } else {
    ctx.db.update(downloads).set({ status: 'failed', error: result.skipped.join('; ') || 'Nothing to import' }).where(eq(downloads.id, dl.id)).run();
  }
  return result;
}
