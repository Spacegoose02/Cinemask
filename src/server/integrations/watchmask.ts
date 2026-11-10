import type { MediaKind } from '../db/schema.js';
import { connectError, IntegrationError } from './http.js';

/** A Watchmask list, as Cinemask shows it. */
export interface WatchmaskList {
  id: number;
  name: string;
  itemsCount: number;
  isPublic: boolean;
  publicSlug: string | null;
  owner: string | null;
}

/** A movie or show on a Watchmask list, keyed by TMDB id like every other list source. */
export interface WatchmaskListEntry {
  kind: MediaKind;
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
}

interface WmPage<T> {
  pagination?: { total?: number; next?: string | null };
  results?: T[];
}

interface WmListRow {
  id: number;
  name: string;
  items_count?: number;
  is_public?: boolean;
  public_slug?: string | null;
  owner?: { username?: string } | null;
}

interface WmItem {
  media_id?: string | number | null;
  source?: string;
  media_type?: string;
  title?: string;
  image?: string | null;
  release_datetime?: string | null;
  ids?: { tmdb?: string };
}

/** Watchmask calls a show "tv". Only movies and shows travel between the two apps. */
const WM_TYPE: Record<MediaKind, string> = { movie: 'movie', show: 'tv' };
const PAGE = 200;
const MAX_ITEMS = 1000;
const MAX_LISTS = 1000;

/** TMDB image URLs carry the poster path Cinemask stores (/abc.jpg); anything else is dropped. */
const tmdbPoster = (image: string | null | undefined) => image?.match(/^https:\/\/image\.tmdb\.org\/t\/p\/[^/]+(\/[\w.-]+)$/)?.[1] ?? null;

/** Turns one Watchmask list entry into a TMDB movie or show, or null for anything else (books, games, anime from MAL…). */
export function entryFromWatchmask(row: { item?: WmItem } | WmItem): WatchmaskListEntry | null {
  const item: WmItem = 'item' in row && row.item ? row.item : (row as WmItem);
  const kind: MediaKind | null = item.media_type === 'movie' ? 'movie' : item.media_type === 'tv' ? 'show' : null;
  if (!kind) return null;
  const raw = item.source === 'tmdb' ? item.media_id : item.ids?.tmdb;
  const tmdbId = Number(raw);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return null;
  const year = item.release_datetime ? Number(item.release_datetime.slice(0, 4)) || null : null;
  return { kind, tmdbId, title: item.title || `TMDB ${tmdbId}`, year, posterPath: tmdbPoster(item.image) };
}

/**
 * Watchmask's REST API (/api/v1), signed in with an app token from Watchmask Settings →
 * Integrations → App tokens. Cinemask needs only the lists:read and lists:write permissions, and the
 * token can be locked to the lists Cinemask may change. Errors never include the address or token.
 */
export class WatchmaskClient {
  private readonly base: string;

  constructor(
    url: string,
    private readonly token: string,
  ) {
    this.base = `${url.replace(/\/+$/, '')}/api/v1`;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T | null }> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      });
    } catch (err) {
      throw new IntegrationError('Watchmask', connectError(err));
    }
    if (res.status === 401) throw new IntegrationError('Watchmask', 'the app token was rejected (revoked, expired, or mistyped)', 401);
    if (res.status === 403) {
      throw new IntegrationError('Watchmask', "the app token isn't allowed to do that. Give it the lists:read and lists:write permissions, and if it is locked to some lists, include this one", 403);
    }
    let body: T | null = null;
    if (res.status !== 204) {
      try {
        body = (await res.json()) as T;
      } catch {
        if (res.ok) throw new IntegrationError('Watchmask', 'returned something that is not JSON (is the address right?)');
      }
    }
    return { status: res.status, body };
  }

  private async get<T>(path: string): Promise<T> {
    const r = await this.call<T>(path);
    if (r.status === 404) throw new IntegrationError('Watchmask', 'not found (is the address right, and does the list still exist?)', 404);
    if (r.status < 200 || r.status >= 300 || r.body === null) throw new IntegrationError('Watchmask', `responded with HTTP ${r.status}`, r.status);
    return r.body;
  }

  /** Checks the address and token by reading the lists the token can see. */
  async test(): Promise<string> {
    const page = await this.get<WmPage<WmListRow>>('/lists?limit=1');
    const n = page.pagination?.total ?? page.results?.length ?? 0;
    return `Connected to Watchmask (${n} list${n === 1 ? '' : 's'} visible to this token)`;
  }

  /** Every list the token's account owns or collaborates on. */
  async lists(): Promise<WatchmaskList[]> {
    const out: WatchmaskList[] = [];
    for (let offset = 0; offset < MAX_LISTS; offset += PAGE) {
      const page = await this.get<WmPage<WmListRow>>(`/lists?limit=${PAGE}&offset=${offset}`);
      for (const l of page.results ?? []) {
        out.push({ id: l.id, name: l.name, itemsCount: l.items_count ?? 0, isPublic: Boolean(l.is_public), publicSlug: l.public_slug ?? null, owner: l.owner?.username ?? null });
      }
      if (!page.pagination?.next || !page.results?.length) break;
    }
    return out;
  }

  /** Finds a list by its id or public link name, as in track.example.com/list/68. */
  async resolveList(ref: string): Promise<number> {
    if (/^\d+$/.test(ref)) return Number(ref);
    const hit = (await this.lists()).find((l) => l.publicSlug === ref);
    if (!hit) throw new IntegrationError('Watchmask', 'no list with that link is visible to the app token');
    return hit.id;
  }

  /** The movies and shows on a list (up to 1000), skipping other media types. */
  async listItems(listId: number): Promise<WatchmaskListEntry[]> {
    const out: WatchmaskListEntry[] = [];
    for (let offset = 0; offset < MAX_ITEMS; offset += PAGE) {
      const page = await this.get<WmPage<{ item?: WmItem }>>(`/lists/${listId}/items?limit=${PAGE}&offset=${offset}`);
      for (const r of page.results ?? []) {
        const e = entryFromWatchmask(r);
        if (e) out.push(e);
      }
      if (!page.pagination?.next || !page.results?.length) break;
    }
    return out;
  }

  /** Ids of the token account's lists that already have this title. */
  async memberships(kind: MediaKind, tmdbId: number): Promise<number[]> {
    const page = await this.get<WmPage<{ list_id: number }>>(`/media/${WM_TYPE[kind]}/tmdb/${tmdbId}/lists?limit=${PAGE}`);
    return (page.results ?? []).map((r) => r.list_id);
  }

  /** Adds a title to a list. Returns false when it was already there. */
  async add(kind: MediaKind, tmdbId: number, listId: number): Promise<boolean> {
    const r = await this.call<{ detail?: string }>(`/media/${WM_TYPE[kind]}/tmdb/${tmdbId}/lists/${listId}`, { method: 'PUT', body: '{}' });
    if (r.status === 409) return false;
    if (r.status === 404) throw new IntegrationError('Watchmask', 'that list or title was not found', 404);
    if (r.status < 200 || r.status >= 300) throw new IntegrationError('Watchmask', `could not add it (HTTP ${r.status})`, r.status);
    return true;
  }

  /** Takes a title off a list. Returns false when it wasn't there. */
  async remove(kind: MediaKind, tmdbId: number, listId: number): Promise<boolean> {
    const r = await this.call<{ detail?: string }>(`/media/${WM_TYPE[kind]}/tmdb/${tmdbId}/lists/${listId}`, { method: 'DELETE' });
    if (r.status === 404) return false;
    if (r.status < 200 || r.status >= 300) throw new IntegrationError('Watchmask', `could not remove it (HTTP ${r.status})`, r.status);
    return true;
  }
}
