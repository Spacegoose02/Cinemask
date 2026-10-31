import { and, eq, gte, lte } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { libraryEpisodes, libraryItems, media, monitored, monitoredEpisodes, type MediaKind } from '../db/schema.js';
import { listProfiles } from './profiles.js';
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
  const meta = new Map(
    ctx.db
      .select({ kind: media.kind, tmdbId: media.tmdbId, posterPath: media.posterPath, releaseDate: media.releaseDate, digitalRelease: media.digitalRelease, physicalRelease: media.physicalRelease, tmdbStatus: media.tmdbStatus })
      .from(media)
      .all()
      .map((m) => [`${m.kind}:${m.tmdbId}`, m]),
  );
  const profiles = new Map(listProfiles(ctx).map((p) => [p.id, p.name]));
  const onServer = new Set(ctx.db.select({ kind: libraryItems.kind, tmdbId: libraryItems.tmdbId }).from(libraryItems).all().map((i) => `${i.kind}:${i.tmdbId}`));
  const serverEpisodes = new Set(
    ctx.db
      .select({ tmdbId: libraryItems.tmdbId, season: libraryEpisodes.season, episode: libraryEpisodes.episode })
      .from(libraryEpisodes)
      .innerJoin(libraryItems, eq(libraryItems.id, libraryEpisodes.libraryItemId))
      .all()
      .map((e) => `${e.tmdbId}:${e.season}:${e.episode}`),
  );
  // Per show: aired monitored episodes, the ones Cinemask has no file for ("season:episode"), and the next air date.
  const episodes = new Map<number, { aired: number; noFile: string[]; next: string | null }>();
  for (const e of ctx.db.select().from(monitoredEpisodes).all()) {
    const c = episodes.get(e.monitoredId) ?? { aired: 0, noFile: [], next: null };
    episodes.set(e.monitoredId, c);
    if (e.season === 0 || !e.airDate) continue;
    if (e.airDate > day) {
      if (!c.next || e.airDate < c.next) c.next = e.airDate;
      continue;
    }
    if (!e.monitored) continue;
    c.aired++;
    if (!e.filePath) c.noFile.push(`${e.season}:${e.episode}`);
  }

  return ctx.db
    .select()
    .from(monitored)
    .all()
    .map((row) => {
      const m = meta.get(`${row.kind}:${row.tmdbId}`);
      let status: OverviewStatus;
      let eps: OverviewRow['episodes'] = null;
      let nextAir: string | null = null;
      if (row.kind === 'movie') {
        const dates = [m?.releaseDate, m?.digitalRelease, m?.physicalRelease].filter((d): d is string => Boolean(d));
        const released = dates.some((d) => d <= day);
        status = row.filePath || onServer.has(`movie:${row.tmdbId}`) ? 'downloaded' : released ? 'missing' : 'upcoming';
        if (status !== 'downloaded') nextAir = dates.filter((d) => d > day).sort()[0] ?? null;
      } else {
        const c = episodes.get(row.id) ?? { aired: 0, noFile: [], next: null };
        const missing = c.noFile.filter((k) => !serverEpisodes.has(`${row.tmdbId}:${k}`)).length;
        eps = { aired: c.aired, missing };
        status = !c.aired ? 'upcoming' : missing === 0 ? 'downloaded' : missing === c.aired ? 'missing' : 'partial';
        nextAir = c.next;
      }
      return {
        id: row.id,
        kind: row.kind,
        tmdbId: row.tmdbId,
        title: row.title,
        year: row.year,
        posterPath: m?.posterPath ?? null,
        monitored: row.monitored,
        status,
        episodes: eps,
        profile: profiles.get(row.profileId) ?? null,
        ended: ENDED.has(m?.tmdbStatus ?? ''),
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
  const onServer = new Set(
    ctx.db
      .select({ tmdbId: libraryItems.tmdbId, season: libraryEpisodes.season, episode: libraryEpisodes.episode })
      .from(libraryEpisodes)
      .innerJoin(libraryItems, eq(libraryItems.id, libraryEpisodes.libraryItemId))
      .all()
      .map((e) => `${e.tmdbId}:${e.season}:${e.episode}`),
  );
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
