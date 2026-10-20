import type { MediaKind } from '../db/schema.js';

export interface ServerItem {
  externalKey: string;
  kind: MediaKind;
  title: string;
  year: number | null;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
  resolution: string | null;
  addedAt: number | null;
  /** Times played and when last, as the server's own account sees it. Shows add up their episodes. */
  viewCount?: number | null;
  lastViewedAt?: number | null;
  /** Plex labels or Jellyfin tags. */
  labels?: string[];
  episodes?: { season: number; episode: number; title: string | null; resolution: string | null; viewCount?: number | null; lastViewedAt?: number | null }[];
}

/** Rolls episode plays up to the show: the fewest plays of any episode is how often the whole show was watched. */
export function rollUpViews(item: ServerItem) {
  if (item.kind !== 'show' || !item.episodes?.length) return;
  item.viewCount = Math.min(...item.episodes.map((e) => e.viewCount ?? 0));
  const last = Math.max(...item.episodes.map((e) => e.lastViewedAt ?? 0));
  item.lastViewedAt = last || null;
}

export interface MediaServerClient {
  test(): Promise<{ name: string; version: string; machineId?: string }>;
  /** Every movie and show (with episodes) on the server. */
  fetchLibrary(): Promise<ServerItem[]>;
}
