import type { MediaKind } from '../db/schema.js';
import { fetchJson } from './http.js';

export interface MdblistRating {
  source: string;
  value: number | null;
  score: number | null;
}

export interface MdblistList {
  id: number;
  name: string;
  slug: string;
  items: number;
  user_name?: string;
}

export interface MdblistItem {
  id: number;
  title: string;
  release_year?: number;
  mediatype: 'movie' | 'show';
  ids?: { tmdb?: number; imdb?: string; tvdb?: number };
}

export class MdblistClient {
  constructor(private readonly key: string) {}

  get configured() {
    return Boolean(this.key);
  }

  private get<T>(path: string) {
    return fetchJson<T>('mdblist', `https://api.mdblist.com${path}${path.includes('?') ? '&' : '?'}apikey=${encodeURIComponent(this.key)}`);
  }

  async ratings(kind: MediaKind, tmdbId: number): Promise<MdblistRating[]> {
    const r = await this.get<{ ratings?: MdblistRating[] }>(`/tmdb/${kind}/${tmdbId}`);
    return (r.ratings ?? []).filter((x) => x.value !== null);
  }

  /** Items of a public mdblist list, by owner username and list slug. */
  listItems(user: string, slug: string) {
    return this.get<{ movies?: MdblistItem[]; shows?: MdblistItem[] } | MdblistItem[]>(`/lists/${encodeURIComponent(user)}/${encodeURIComponent(slug)}/items`);
  }

  test() {
    return this.get<{ limits?: unknown }>('/user');
  }
}
