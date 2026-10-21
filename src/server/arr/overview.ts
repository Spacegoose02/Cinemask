import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { libraryEpisodes, libraryItems, media, monitored, monitoredEpisodes, type MediaKind } from '../db/schema.js';

export type OverviewStatus = 'downloaded' | 'missing' | 'partial' | 'upcoming';

export interface OverviewRow {
  id: number;
  kind: MediaKind;
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  monitored: boolean;
  status: OverviewStatus;
  /** Shows: aired episodes that are monitored, and how many of them have no file. */
  episodes: { aired: number; missing: number } | null;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Every title Cinemask follows, whether it is monitored, and what is missing. A file counts when
 * Cinemask has one or Plex/Jellyfin lists it. Specials (season 0) and episodes that haven't aired
 * don't count as missing, and neither do unmonitored episodes.
 */
export function monitoredOverview(ctx: AppContext): OverviewRow[] {
  const day = today();
  const meta = new Map(ctx.db.select({ kind: media.kind, tmdbId: media.tmdbId, posterPath: media.posterPath, releaseDate: media.releaseDate, digitalRelease: media.digitalRelease }).from(media).all().map((m) => [`${m.kind}:${m.tmdbId}`, m]));
  const onServer = new Set(ctx.db.select({ kind: libraryItems.kind, tmdbId: libraryItems.tmdbId }).from(libraryItems).all().map((i) => `${i.kind}:${i.tmdbId}`));
  const serverEpisodes = new Set(
    ctx.db
      .select({ tmdbId: libraryItems.tmdbId, season: libraryEpisodes.season, episode: libraryEpisodes.episode })
      .from(libraryEpisodes)
      .innerJoin(libraryItems, eq(libraryItems.id, libraryEpisodes.libraryItemId))
      .all()
      .map((e) => `${e.tmdbId}:${e.season}:${e.episode}`),
  );
  // Per show: aired monitored episodes, and the ones Cinemask has no file for ("season:episode").
  const episodes = new Map<number, { aired: number; noFile: string[] }>();
  for (const e of ctx.db.select().from(monitoredEpisodes).all()) {
    if (!e.monitored || e.season === 0 || !e.airDate || e.airDate > day) continue;
    const c = episodes.get(e.monitoredId) ?? { aired: 0, noFile: [] };
    c.aired++;
    if (!e.filePath) c.noFile.push(`${e.season}:${e.episode}`);
    episodes.set(e.monitoredId, c);
  }

  return ctx.db
    .select()
    .from(monitored)
    .all()
    .map((row) => {
      const m = meta.get(`${row.kind}:${row.tmdbId}`);
      let status: OverviewStatus;
      let eps: OverviewRow['episodes'] = null;
      if (row.kind === 'movie') {
        const released = [m?.digitalRelease, m?.releaseDate].some((d) => d && d <= day);
        status = row.filePath || onServer.has(`movie:${row.tmdbId}`) ? 'downloaded' : released ? 'missing' : 'upcoming';
      } else {
        const c = episodes.get(row.id) ?? { aired: 0, noFile: [] };
        const missing = c.noFile.filter((k) => !serverEpisodes.has(`${row.tmdbId}:${k}`)).length;
        eps = { aired: c.aired, missing };
        status = !c.aired ? 'upcoming' : missing === 0 ? 'downloaded' : missing === c.aired ? 'missing' : 'partial';
      }
      return { id: row.id, kind: row.kind, tmdbId: row.tmdbId, title: row.title, year: row.year, posterPath: m?.posterPath ?? null, monitored: row.monitored, status, episodes: eps };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}
