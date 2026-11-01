import fs from 'node:fs';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { issues, libraryItems, media, monitored, monitoredEpisodes, recycleBin, requests } from '../db/schema.js';
import { listRoots } from '../arr/roots.js';
import { audit } from '../audit/log.js';
import { deleteFolder } from '../files/service.js';
import { emptyOldRecycled } from '../files/recycle.js';

/**
 * The storage manager: how full each media folder's disk is, which titles take the most room,
 * and which ones nobody is watching any more (never the ones marked Keep, with an open request
 * or a problem report).
 */

const DAY = 24 * 60 * 60 * 1000;

export const rootPaths = (ctx: AppContext) => [...new Set(listRoots(ctx).map((r) => r.path).filter(Boolean))];

function fileSize(p: string | null): number {
  if (!p) return 0;
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

export interface TitleUse {
  id: number;
  kind: 'movie' | 'show';
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  size: number;
  keep: boolean;
  addedAt: number;
  viewCount: number | null;
  lastViewedAt: number | null;
}

let cache: { at: number; titles: TitleUse[] } | null = null;

/** Every monitored title with files, and how much room they take. Cached for a few minutes. */
export function titleSizes(ctx: AppContext, fresh = false): TitleUse[] {
  if (!fresh && cache && Date.now() - cache.at < 5 * 60 * 1000) return cache.titles;
  const rows = ctx.db.select().from(monitored).all();
  const posters = new Map(ctx.db.select({ kind: media.kind, tmdbId: media.tmdbId, poster: media.posterPath, override: media.posterOverride }).from(media).all().map((m) => [`${m.kind}:${m.tmdbId}`, m.override ?? m.poster]));
  const episodeFiles = new Map<number, Set<string>>();
  for (const e of ctx.db.select({ id: monitoredEpisodes.monitoredId, file: monitoredEpisodes.filePath }).from(monitoredEpisodes).where(isNotNull(monitoredEpisodes.filePath)).all()) {
    if (!episodeFiles.has(e.id)) episodeFiles.set(e.id, new Set());
    episodeFiles.get(e.id)!.add(e.file!);
  }
  const watched = new Map<string, { v: number | null; l: number | null }>();
  for (const i of ctx.db.select({ kind: libraryItems.kind, tmdbId: libraryItems.tmdbId, v: libraryItems.viewCount, l: libraryItems.lastViewedAt }).from(libraryItems).where(isNotNull(libraryItems.tmdbId)).all()) {
    const k = `${i.kind}:${i.tmdbId}`;
    const w = watched.get(k) ?? { v: null, l: null };
    if (i.v !== null) w.v = (w.v ?? 0) + i.v;
    if (i.l !== null) w.l = Math.max(w.l ?? 0, i.l);
    watched.set(k, w);
  }
  const titles = rows
    .map((r): TitleUse => {
      const files = r.kind === 'movie' ? [r.filePath] : [...(episodeFiles.get(r.id) ?? [])];
      const w = watched.get(`${r.kind}:${r.tmdbId}`);
      return {
        id: r.id,
        kind: r.kind,
        tmdbId: r.tmdbId,
        title: r.title,
        year: r.year,
        posterPath: posters.get(`${r.kind}:${r.tmdbId}`) ?? null,
        size: files.reduce((n, f) => n + fileSize(f), 0),
        keep: r.keep,
        addedAt: r.addedAt,
        viewCount: w?.v ?? null,
        lastViewedAt: w?.l ?? null,
      };
    })
    .filter((t) => t.size > 0);
  cache = { at: Date.now(), titles };
  return titles;
}

export const forgetSizes = () => {
  cache = null;
};

export interface Suggestion extends TitleUse {
  why: string;
}

/** Titles worth removing to free up room, biggest first. */
export function suggestions(ctx: AppContext, titles = titleSizes(ctx)): Suggestion[] {
  const s = ctx.settings.get('storage');
  const now = Date.now();
  const wanted = new Set(
    ctx.db
      .select({ kind: requests.kind, tmdbId: requests.tmdbId })
      .from(requests)
      .where(and(inArray(requests.status, ['pending', 'approved'])))
      .all()
      .map((r) => `${r.kind}:${r.tmdbId}`),
  );
  // Something requested recently is still wanted even once it's arrived.
  const recent = new Set(
    ctx.db
      .select({ kind: requests.kind, tmdbId: requests.tmdbId, at: requests.createdAt })
      .from(requests)
      .all()
      .filter((r) => now - r.at < 60 * DAY)
      .map((r) => `${r.kind}:${r.tmdbId}`),
  );
  const reported = new Set(ctx.db.select({ kind: issues.kind, tmdbId: issues.tmdbId }).from(issues).where(inArray(issues.status, ['open', 'fixing'])).all().map((r) => `${r.kind}:${r.tmdbId}`));
  const out: Suggestion[] = [];
  for (const t of titles) {
    const k = `${t.kind}:${t.tmdbId}`;
    if (t.keep || wanted.has(k) || recent.has(k) || reported.has(k)) continue;
    const days = (ms: number) => Math.floor((now - ms) / DAY);
    if (s.watchedDays && t.viewCount && t.lastViewedAt && now - t.lastViewedAt > s.watchedDays * DAY) out.push({ ...t, why: `Last watched ${days(t.lastViewedAt)} days ago` });
    // Only when a media server reports plays at all; otherwise "never watched" can't be known.
    else if (s.unwatchedDays && t.viewCount === 0 && now - t.addedAt > s.unwatchedDays * DAY) out.push({ ...t, why: `Not watched in the ${days(t.addedAt)} days since it arrived` });
  }
  return out.sort((a, b) => b.size - a.size);
}

export function diskUse(ctx: AppContext) {
  return listRoots(ctx)
    .filter((r) => r.path)
    .map((r) => {
      let total: number | null = null;
      let free: number | null = null;
      try {
        const st = fs.statfsSync(r.path);
        total = st.blocks * st.bsize;
        free = st.bavail * st.bsize;
      } catch {
        // folder missing or not mounted
      }
      return { id: r.id, name: r.name, kind: r.kind, path: r.path, total, free };
    });
}

export function recycled(ctx: AppContext) {
  return ctx.db.select().from(recycleBin).orderBy(desc(recycleBin.deletedAt)).limit(500).all();
}

/**
 * Removes titles' files into the recycle bin and stops monitoring them, so they aren't
 * downloaded again. Titles marked Keep are skipped.
 */
export function freeUp(ctx: AppContext, ids: number[], by: string, reason: string): { removed: number; freed: number; skipped: string[] } {
  let removed = 0;
  let freed = 0;
  const skipped: string[] = [];
  for (const id of ids) {
    const row = ctx.db.select().from(monitored).where(eq(monitored.id, id)).get();
    if (!row) continue;
    if (row.keep) {
      skipped.push(`${row.title}: marked Keep`);
      continue;
    }
    if (!row.path) {
      skipped.push(`${row.title}: no folder on disk`);
      continue;
    }
    try {
      freed += deleteFolder(ctx, row, by, reason);
    } catch (err) {
      skipped.push(`${row.title}: ${(err as Error).message}`);
      continue;
    }
    ctx.db.update(monitored).set({ monitored: false, filePath: null, fileQuality: null, fileInfo: null, path: null }).where(eq(monitored.id, row.id)).run();
    ctx.db.update(monitoredEpisodes).set({ filePath: null, fileQuality: null, fileInfo: null, monitored: false }).where(eq(monitoredEpisodes.monitoredId, row.id)).run();
    removed++;
  }
  forgetSizes();
  return { removed, freed, skipped };
}

/** Nightly: empties the old part of the recycle bin, and applies the delete rules when they're on. */
export function storageJob(ctx: AppContext): { purged: number; removed: number } {
  const purged = emptyOldRecycled(ctx, rootPaths(ctx));
  const s = ctx.settings.get('storage');
  let removed = 0;
  // Only with the recycle bin on, so an automatic delete can always be undone.
  if (s.autoDelete && s.recycleBin) {
    const picks = suggestions(ctx, titleSizes(ctx, true));
    if (picks.length) {
      const r = freeUp(ctx, picks.map((p) => p.id), 'Delete rules', 'Delete rules (Settings → Storage)');
      removed = r.removed;
      audit(ctx.db, null, 'storage.auto_deleted', { user: null, details: { titles: picks.map((p) => p.title).slice(0, 50), freed: r.freed } });
      ctx.onMediaChanged?.();
    }
  }
  return { purged, removed };
}
