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
  /** The library (Plex section) the item is in. */
  library?: string | null;
  episodes?: { season: number; episode: number; title: string | null; resolution: string | null; viewCount?: number | null; lastViewedAt?: number | null }[];
}

/** Rolls episode plays up to the show: the fewest plays of any episode is how often the whole show was watched. */
export function rollUpViews(item: ServerItem) {
  if (item.kind !== 'show' || !item.episodes?.length) return;
  item.viewCount = Math.min(...item.episodes.map((e) => e.viewCount ?? 0));
  const last = Math.max(...item.episodes.map((e) => e.lastViewedAt ?? 0));
  item.lastViewedAt = last || null;
}

/** Something being played right now, from the server's own list of sessions. */
export interface LiveSession {
  /** Stable for one play of one item on one device. */
  id: string;
  /** What to pass to stopSession. */
  controlId: string;
  user: string;
  kind: 'movie' | 'episode' | 'other';
  title: string;
  show: string | null;
  season: number | null;
  episode: number | null;
  year: number | null;
  /** The movie's or show's key on the server (library_items.external_key), to find its TMDB id. */
  itemKey: string | null;
  state: 'playing' | 'paused' | 'buffering';
  positionMs: number;
  durationMs: number;
  player: string | null;
  platform: string | null;
  /** How the server sends it: as it is, remuxed, or converted. */
  decision: 'direct' | 'copy' | 'transcode';
  quality: string | null;
  bandwidthKbps: number | null;
  local: boolean | null;
}

export interface MediaServerClient {
  test(): Promise<{ name: string; version: string; machineId?: string }>;
  /** Every movie and show (with episodes) on the server. */
  fetchLibrary(): Promise<ServerItem[]>;
  /** What's playing now (Now playing). */
  sessions?(): Promise<LiveSession[]>;
  /** Stops a stream, with a message for the viewer where the server can show one. */
  stopSession?(controlId: string, reason: string): Promise<void>;
}
