import { and, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { media, monitored, monitoredEpisodes } from '../db/schema.js';
import { refreshEpisodes } from '../arr/monitor.js';
import { scanFolder } from '../files/service.js';
import { refreshMetadata } from '../library/service.js';
import { episodesOnServerFor } from '../library/service.js';

export type ReleaseType = 'cinema' | 'digital' | 'physical';

export type EpisodeMarker = 'series_premiere' | 'season_premiere' | 'season_finale' | 'series_finale';

export interface CalendarEpisode {
  season: number;
  episode: number;
  title: string | null;
  hasFile: boolean;
  /** A premiere or finale, for the calendar's badges and its premieres view. */
  marker: EpisodeMarker | null;
}

export interface CalendarEntry {
  date: string;
  /** The monitored title, for searching from the calendar. */
  monitoredId: number;
  kind: 'movie' | 'show';
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  overview: string | null;
  trailerKey: string | null;
  monitored: boolean;
  /** Movies only. */
  releaseType?: ReleaseType;
  /** Movies only: this is the movie's first release (theaters, or digital/disc when it skips them). */
  premiere?: boolean;
  hasFile: boolean;
  /** Shows only: every episode of the show airing that day, so the UI can show "Title +5". */
  episodes?: CalendarEpisode[];
}

/** Movies and episodes of monitored titles released between start and end (inclusive, YYYY-MM-DD). */
export function calendar(ctx: AppContext, start: string, end: string): CalendarEntry[] {
  const entries: CalendarEntry[] = [];

  const movies = ctx.db
    .select({ m: monitored, meta: media })
    .from(monitored)
    .innerJoin(media, and(eq(media.kind, 'movie'), eq(media.tmdbId, monitored.tmdbId)))
    .where(
      and(
        eq(monitored.kind, 'movie'),
        or(and(gte(media.releaseDate, start), lte(media.releaseDate, end)), and(gte(media.digitalRelease, start), lte(media.digitalRelease, end)), and(gte(media.physicalRelease, start), lte(media.physicalRelease, end))),
      ),
    )
    .all();
  for (const { m, meta } of movies) {
    const dates: [ReleaseType, string | null][] = [
      ['cinema', meta.releaseDate],
      ['digital', meta.digitalRelease],
      ['physical', meta.physicalRelease],
    ];
    const first = dates.map(([, d]) => d).filter((d): d is string => Boolean(d)).sort()[0];
    for (const [releaseType, date] of dates) {
      if (!date || date < start || date > end) continue;
      entries.push({ date, monitoredId: m.id, kind: 'movie', tmdbId: m.tmdbId, title: m.title, year: m.year, posterPath: meta.posterPath, overview: meta.overview, trailerKey: meta.trailerKey, monitored: m.monitored, releaseType, premiere: date === first, hasFile: Boolean(m.filePath) });
    }
  }

  const eps = ctx.db
    .select({ e: monitoredEpisodes, m: monitored })
    .from(monitoredEpisodes)
    .innerJoin(monitored, eq(monitored.id, monitoredEpisodes.monitoredId))
    .where(and(gte(monitoredEpisodes.airDate, start), lte(monitoredEpisodes.airDate, end)))
    .orderBy(monitoredEpisodes.airDate, monitoredEpisodes.season, monitoredEpisodes.episode)
    .all();
  // Last known episode of each season, and the show's last season, for finales TMDB hasn't flagged.
  const lastEp = new Map<string, number>();
  const lastSeason = new Map<number, number>();
  const showIds = [...new Set(eps.map(({ m }) => m.id))];
  const showTmdbIds = [...new Set(eps.map(({ m }) => m.tmdbId))];
  for (let i = 0; i < showIds.length; i += 500) {
    const rows = ctx.db
      .select({ id: monitoredEpisodes.monitoredId, season: monitoredEpisodes.season, last: sql<number>`max(${monitoredEpisodes.episode})` })
      .from(monitoredEpisodes)
      .where(inArray(monitoredEpisodes.monitoredId, showIds.slice(i, i + 500)))
      .groupBy(monitoredEpisodes.monitoredId, monitoredEpisodes.season)
      .all();
    for (const r of rows) {
      lastEp.set(`${r.id}:${r.season}`, r.last);
      lastSeason.set(r.id, Math.max(lastSeason.get(r.id) ?? 0, r.season));
    }
  }
  const showMeta = new Map<number, typeof media.$inferSelect>();
  for (let i = 0; i < showTmdbIds.length; i += 500) {
    for (const row of ctx.db.select().from(media).where(and(eq(media.kind, 'show'), inArray(media.tmdbId, showTmdbIds.slice(i, i + 500)))).all()) showMeta.set(row.tmdbId, row);
  }
  const ended = (tmdbId: number) => /ended|canceled|cancelled/i.test(showMeta.get(tmdbId)?.tmdbStatus ?? '');
  const markerFor = (m: typeof monitored.$inferSelect, e: typeof monitoredEpisodes.$inferSelect): EpisodeMarker | null => {
    if (e.episode === 1) return e.season === 1 ? 'series_premiere' : 'season_premiere';
    const isLast = lastEp.get(`${m.id}:${e.season}`) === e.episode;
    const lastSeasonOfShow = lastSeason.get(m.id) === e.season;
    // Without TMDB's flag, the last listed episode is only known to be the finale once a later season exists or the show has ended.
    const finale = e.episodeType === 'finale' || (e.episodeType === null && isLast && (!lastSeasonOfShow || ended(m.tmdbId)));
    if (!finale) return null;
    return lastSeasonOfShow && ended(m.tmdbId) && isLast ? 'series_finale' : 'season_finale';
  };
  const grouped = new Map<string, CalendarEntry>();
  const onServer = episodesOnServerFor(ctx, showTmdbIds);
  for (const { e, m } of eps) {
    const key = `${e.airDate}:${m.id}`;
    const hasFile = Boolean(e.filePath) || Boolean(onServer.get(m.tmdbId)?.has(`${e.season}:${e.episode}`));
    let entry = grouped.get(key);
    if (!entry) {
      const meta = showMeta.get(m.tmdbId);
      entry = { date: e.airDate!, monitoredId: m.id, kind: 'show', tmdbId: m.tmdbId, title: m.title, year: m.year, posterPath: meta?.posterPath ?? null, overview: meta?.overview ?? null, trailerKey: meta?.trailerKey ?? null, monitored: m.monitored && e.monitored, hasFile: true, episodes: [] };
      grouped.set(key, entry);
    }
    entry.episodes!.push({ season: e.season, episode: e.episode, title: e.title, hasFile, marker: markerFor(m, e) });
    entry.hasFile = entry.hasFile && hasFile;
    entry.monitored = entry.monitored || (m.monitored && e.monitored);
  }
  entries.push(...grouped.values());
  return entries.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

/**
 * Keeps release dates and episode lists of managed titles current, so the calendar and Seasons pick up
 * new episodes and the missing search (hourly) can grab the ones a monitored show wants.
 */
export async function refreshMonitored(ctx: AppContext): Promise<void> {
  for (const row of ctx.db.select().from(monitored).all()) {
    try {
      await refreshMetadata(ctx, row.kind, row.tmdbId);
      // Every show, monitored or not: its Seasons section lists these episodes. An unmonitored show
      // never searches, so new episodes on it are only listed.
      if (row.kind !== 'show') continue;
      const count = () => ctx.db.select({ id: monitoredEpisodes.id }).from(monitoredEpisodes).where(eq(monitoredEpisodes.monitoredId, row.id)).all().length;
      const before = count();
      await refreshEpisodes(ctx, row);
      // New episodes whose files are already in the folder get matched now, so the hourly
      // missing search doesn't download them again.
      if (count() > before && row.path) scanFolder(ctx, row);
    } catch {
      // TMDB hiccup: try again next run
    }
  }
}
