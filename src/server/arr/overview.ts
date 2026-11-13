import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { libraryEpisodes, libraryItems, media, monitored, monitoredEpisodes, type MediaKind } from '../db/schema.js';
import { listProfiles } from './profiles.js';
import { episodesOnServerFor } from '../library/service.js';
import { localDay } from '../lib/dates.js';

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
  /** The quality profile's name. */
  profile: string | null;
  /** TMDB says the show has ended (or was cancelled). */
  ended: boolean;
  /** Shows: when the next episode airs. Movies without a file: the next release date. */
  nextAir: string | null;
}

const today = () => localDay();
const ENDED = new Set(['Ended', 'Canceled', 'Cancelled']);

/**
 * Every title Cinemask follows, whether it is monitored, and what is missing. A file counts when
 * Cinemask has one or Plex/Jellyfin lists it. Specials (season 0) and episodes that haven't aired
 * don't count as missing, and neither do unmonitored episodes.
 */
export function monitoredOverview(ctx: AppContext): OverviewRow[] {
  const day = today();
  const profiles = new Map(listProfiles(ctx).map((p) => [p.id, p.name]));
  // Only the columns the grid needs: file details (ffprobe JSON) on every row made this slow on big libraries.
  const titles = ctx.db
    .select({
      id: monitored.id,
      kind: monitored.kind,
      tmdbId: monitored.tmdbId,
      title: monitored.title,
      year: monitored.year,
      monitored: monitored.monitored,
      profileId: monitored.profileId,
      hasFile: sql<number>`${monitored.filePath} IS NOT NULL`,
      posterPath: media.posterPath,
      releaseDate: media.releaseDate,
      digitalRelease: media.digitalRelease,
      physicalRelease: media.physicalRelease,
      tmdbStatus: media.tmdbStatus,
    })
    .from(monitored)
    .leftJoin(media, and(eq(media.kind, monitored.kind), eq(media.tmdbId, monitored.tmdbId)))
    .all();
  const moviesOnServer = new Set(
    ctx.db
      .selectDistinct({ tmdbId: libraryItems.tmdbId })
      .from(libraryItems)
      .where(eq(libraryItems.kind, 'movie'))
      .all()
      .map((i) => i.tmdbId),
  );
  // Per show, counted in SQLite: aired monitored episodes, how many have no file here or on a media server, and the next air date.
  // Specials (season 0) never count. Doing this in JS meant loading every episode of every server first.
  const aired = sql`${monitoredEpisodes.season} > 0 AND ${monitoredEpisodes.airDate} <= ${day} AND ${monitoredEpisodes.monitored}`;
  const episodes = new Map(
    ctx.db
      .select({
        id: monitoredEpisodes.monitoredId,
        aired: sql<number>`coalesce(sum(${aired}), 0)`,
        missing: sql<number>`coalesce(sum(${aired} AND ${monitoredEpisodes.filePath} IS NULL AND NOT EXISTS (
          SELECT 1 FROM ${libraryItems} JOIN ${libraryEpisodes} ON ${libraryEpisodes.libraryItemId} = ${libraryItems.id}
          WHERE ${libraryItems.kind} = 'show' AND ${libraryItems.tmdbId} = ${monitored.tmdbId}
            AND ${libraryEpisodes.season} = ${monitoredEpisodes.season} AND ${libraryEpisodes.episode} = ${monitoredEpisodes.episode})), 0)`,
        next: sql<string | null>`min(CASE WHEN ${monitoredEpisodes.season} > 0 AND ${monitoredEpisodes.airDate} > ${day} THEN ${monitoredEpisodes.airDate} END)`,
      })
      .from(monitoredEpisodes)
      .innerJoin(monitored, eq(monitored.id, monitoredEpisodes.monitoredId))
      .groupBy(monitoredEpisodes.monitoredId)
      .all()
      .map((r) => [r.id, r]),
  );

  return titles
    .map((row) => {
      let status: OverviewStatus;
      let eps: OverviewRow['episodes'] = null;
      let nextAir: string | null = null;
      if (row.kind === 'movie') {
        const dates = [row.releaseDate, row.digitalRelease, row.physicalRelease].filter((d): d is string => Boolean(d));
        const released = dates.some((d) => d <= day);
        status = row.hasFile || moviesOnServer.has(row.tmdbId) ? 'downloaded' : released ? 'missing' : 'upcoming';
        if (status !== 'downloaded') nextAir = dates.filter((d) => d > day).sort()[0] ?? null;
      } else {
        const c = episodes.get(row.id);
        const aired = c?.aired ?? 0;
        const missing = c?.missing ?? 0;
        eps = { aired, missing };
        status = !aired ? 'upcoming' : missing === 0 ? 'downloaded' : missing === aired ? 'missing' : 'partial';
        nextAir = c?.next ?? null;
      }
      return {
        id: row.id,
        kind: row.kind,
        tmdbId: row.tmdbId,
        title: row.title,
        year: row.year,
        posterPath: row.posterPath ?? null,
        monitored: row.monitored,
        status,
        episodes: eps,
        profile: profiles.get(row.profileId) ?? null,
        ended: ENDED.has(row.tmdbStatus ?? ''),
        nextAir,
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

export interface AiringEpisode {
  tmdbId: number;
  title: string;
  posterPath: string | null;
  season: number;
  episode: number;
  episodeTitle: string | null;
  airDate: string;
  hasFile: boolean;
}

const shift = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);

/**
 * What's on: each followed show's next episode (today included) within `days`, soonest first, and
 * its latest episode from the past `days`, newest first. Unmonitored shows are left out.
 */
export function airing(ctx: AppContext, days: number): { next: AiringEpisode[]; recent: AiringEpisode[] } {
  const day = today();
  const rows = ctx.db
    .select({
      tmdbId: monitored.tmdbId,
      title: monitored.title,
      posterPath: media.posterPath,
      season: monitoredEpisodes.season,
      episode: monitoredEpisodes.episode,
      episodeTitle: monitoredEpisodes.title,
      airDate: monitoredEpisodes.airDate,
      filePath: monitoredEpisodes.filePath,
    })
    .from(monitoredEpisodes)
    .innerJoin(monitored, eq(monitored.id, monitoredEpisodes.monitoredId))
    .leftJoin(media, and(eq(media.kind, 'show'), eq(media.tmdbId, monitored.tmdbId)))
    .where(and(eq(monitored.monitored, true), gte(monitoredEpisodes.airDate, shift(day, -days)), lte(monitoredEpisodes.airDate, shift(day, days))))
    .all();
  const onServer = new Set<string>();
  for (const [tmdbId, eps] of episodesOnServerFor(ctx, rows.map((r) => r.tmdbId))) for (const k of eps.keys()) onServer.add(`${tmdbId}:${k}`);
  const toEpisode = (r: (typeof rows)[number]): AiringEpisode => ({
    tmdbId: r.tmdbId,
    title: r.title,
    posterPath: r.posterPath ?? null,
    season: r.season,
    episode: r.episode,
    episodeTitle: r.episodeTitle,
    airDate: r.airDate!,
    hasFile: Boolean(r.filePath) || onServer.has(`${r.tmdbId}:${r.season}:${r.episode}`),
  });
  // One per show: its first upcoming episode, and its latest aired one.
  const order = (a: (typeof rows)[number], b: (typeof rows)[number]) => a.airDate!.localeCompare(b.airDate!) || a.season - b.season || a.episode - b.episode;
  const next = new Map<number, AiringEpisode>();
  for (const r of rows.filter((r) => r.airDate! >= day).sort(order)) if (!next.has(r.tmdbId)) next.set(r.tmdbId, toEpisode(r));
  const recent = new Map<number, AiringEpisode>();
  for (const r of rows.filter((r) => r.airDate! < day).sort((a, b) => order(b, a))) if (!recent.has(r.tmdbId)) recent.set(r.tmdbId, toEpisode(r));
  return { next: [...next.values()], recent: [...recent.values()] };
}
