import { and, eq, gte, lte, or } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { media, monitored, monitoredEpisodes } from '../db/schema.js';
import { refreshEpisodes } from '../arr/monitor.js';
import { refreshMetadata } from '../library/service.js';
import { episodesOnServer } from '../library/service.js';

export type ReleaseType = 'cinema' | 'digital' | 'physical';

export interface CalendarEpisode {
  season: number;
  episode: number;
  title: string | null;
  hasFile: boolean;
}

export interface CalendarEntry {
  date: string;
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
  hasFile: boolean;
  /** Shows only: every episode of the show airing that day, so the UI can show "Title +5". */
  episodes?: CalendarEpisode[];
}

/** Movies and episodes of monitored titles released between start and end (inclusive, YYYY-MM-DD). */
export function calendar(ctx: AppContext, start: string, end: string): CalendarEntry[] {
  const entries: CalendarEntry[] = [];
  const metaFor = (kind: 'movie' | 'show', tmdbId: number) => ctx.db.select().from(media).where(and(eq(media.kind, kind), eq(media.tmdbId, tmdbId))).get();

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
    for (const [releaseType, date] of dates) {
      if (!date || date < start || date > end) continue;
      entries.push({ date, kind: 'movie', tmdbId: m.tmdbId, title: m.title, year: m.year, posterPath: meta.posterPath, overview: meta.overview, trailerKey: meta.trailerKey, monitored: m.monitored, releaseType, hasFile: Boolean(m.filePath) });
    }
  }

  const eps = ctx.db
    .select({ e: monitoredEpisodes, m: monitored })
    .from(monitoredEpisodes)
    .innerJoin(monitored, eq(monitored.id, monitoredEpisodes.monitoredId))
    .where(and(gte(monitoredEpisodes.airDate, start), lte(monitoredEpisodes.airDate, end)))
    .orderBy(monitoredEpisodes.airDate, monitoredEpisodes.season, monitoredEpisodes.episode)
    .all();
  const grouped = new Map<string, CalendarEntry>();
  const onServer = new Map<number, ReturnType<typeof episodesOnServer>>();
  for (const { e, m } of eps) {
    const key = `${e.airDate}:${m.id}`;
    if (!onServer.has(m.tmdbId)) onServer.set(m.tmdbId, episodesOnServer(ctx, m.tmdbId));
    const hasFile = Boolean(e.filePath) || onServer.get(m.tmdbId)!.has(`${e.season}:${e.episode}`);
    let entry = grouped.get(key);
    if (!entry) {
      const meta = metaFor('show', m.tmdbId);
      entry = { date: e.airDate!, kind: 'show', tmdbId: m.tmdbId, title: m.title, year: m.year, posterPath: meta?.posterPath ?? null, overview: meta?.overview ?? null, trailerKey: meta?.trailerKey ?? null, monitored: m.monitored && e.monitored, hasFile: true, episodes: [] };
      grouped.set(key, entry);
    }
    entry.episodes!.push({ season: e.season, episode: e.episode, title: e.title, hasFile });
    entry.hasFile = entry.hasFile && hasFile;
    entry.monitored = entry.monitored || (m.monitored && e.monitored);
  }
  entries.push(...grouped.values());
  return entries.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

/** Keeps release dates and episode lists of monitored titles current, so the calendar picks up new episodes. */
export async function refreshMonitored(ctx: AppContext): Promise<void> {
  for (const row of ctx.db.select().from(monitored).all()) {
    try {
      await refreshMetadata(ctx, row.kind, row.tmdbId);
      if (row.kind === 'show' && row.monitored) await refreshEpisodes(ctx, row);
    } catch {
      // TMDB hiccup: try again next run
    }
  }
}
