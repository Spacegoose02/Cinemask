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
  episodes?: { season: number; episode: number; title: string | null; resolution: string | null }[];
}

export interface MediaServerClient {
  test(): Promise<{ name: string; version: string; machineId?: string }>;
  /** Every movie and show (with episodes) on the server. */
  fetchLibrary(): Promise<ServerItem[]>;
}
