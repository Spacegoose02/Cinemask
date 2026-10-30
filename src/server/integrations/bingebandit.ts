import { connectError, fetchJson, IntegrationError, normalizeResolution } from './http.js';
import { rollUpViews, type MediaServerClient, type ServerItem } from './mediaserver.js';

interface BbLibrary {
  id: number;
  name: string;
  kind: string;
  /** The library's folders as BingeBandit sees them; only an admin's key gets them. */
  paths?: string[] | null;
}

interface BbItem {
  id: number;
  kind: string;
  title: string;
  year?: number;
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
  labels?: string[];
  seasonNumber?: number;
  episodeNumber?: number;
  /** Unix seconds. */
  addedAt: number;
  watch?: { watched: boolean; updatedAt: number };
}

/** A collection; smart ones pick their titles by rules, and list ones follow a list. */
export interface BbCollection {
  id: number;
  libraryId: number;
  name: string;
  overview?: string;
  poster?: string;
  mode: string;
  listUrl?: string;
  labelRule?: string;
  genreRule?: string;
  studioRule?: string;
  yearFrom?: number;
  yearTo?: number;
  itemCount: number;
}

/** Hand-picked: Cinemask can only set the members of a collection with no rules and no list. */
export const handPicked = (c: BbCollection) => !c.listUrl && !c.labelRule && !c.genreRule && !c.studioRule && !c.yearFrom && !c.yearTo;

interface BbDetail {
  item: BbItem;
  files?: { height: number }[];
  children?: BbItem[];
}

const plays = (i: BbItem) => ({
  viewCount: i.watch ? (i.watch.watched ? 1 : 0) : null,
  lastViewedAt: i.watch?.watched && i.watch.updatedAt ? i.watch.updatedAt * 1000 : null,
});

/**
 * Resolutions already read, by server and item id, for BingeBandit versions without
 * /api/admin/files: each movie and episode costs a request the first time; after that only new ones do.
 */
const resolutions = new Map<string, { addedAt: number; resolution: string | null }>();

/** Runs fn over items, a few at a time. */
async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

/** BingeBandit (github.com/Spacegoose02/BingeBandit), with an API key from Settings → API keys. */
export class BingeBanditClient implements MediaServerClient {
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
  ) {}

  private get base() {
    return this.url.replace(/\/+$/, '');
  }

  private get<T>(path: string) {
    return fetchJson<T>('BingeBandit', `${this.base}${path}`, { headers: { Authorization: `Bearer ${this.apiKey}` } }, 60_000);
  }

  private async send(method: string, path: string, body?: string | FormData, contentType?: string): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        body,
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json', ...(contentType ? { 'Content-Type': contentType } : {}) },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new IntegrationError('BingeBandit', connectError(err));
    }
    if (res.status === 401) throw new IntegrationError('BingeBandit', 'the API key was rejected', res.status);
    if (res.status === 403) throw new IntegrationError('BingeBandit', 'the API key must belong to an admin', res.status);
    if (!res.ok) throw new IntegrationError('BingeBandit', `responded with HTTP ${res.status}`, res.status);
    return res;
  }

  async test() {
    const health = await this.get<{ name?: string; version?: string }>('/api/health');
    // /api/health answers anyone; /api/me proves the key works.
    const me = await this.get<{ username: string; isAdmin: boolean }>('/api/me');
    return { name: health.name || 'BingeBandit', version: health.version ?? '', user: me.username, admin: me.isAdmin };
  }

  /** Scans every library for new files. Needs an admin's key. */
  async refresh() {
    await this.send('POST', '/api/admin/scan');
  }

  /**
   * The tallest file of every movie and episode, by item id, from /api/admin/files. Null when this
   * BingeBandit is older than that endpoint or the key isn't an admin's.
   */
  private async heights(): Promise<Map<number, number> | null> {
    const out = new Map<number, number>();
    try {
      for (let offset = 0; ; offset += 1000) {
        const page = await this.get<{ files: { itemId: number; height: number }[] | null; total: number }>(`/api/admin/files?offset=${offset}&limit=1000`);
        for (const f of page.files ?? []) out.set(f.itemId, Math.max(out.get(f.itemId) ?? 0, f.height ?? 0));
        if (!page.files?.length || offset + 1000 >= page.total) break;
      }
    } catch (err) {
      if (err instanceof IntegrationError && (err.status === 403 || err.status === 404 || err.status === 405)) return null;
      throw err;
    }
    return out;
  }

  private async resolution(item: BbItem, heights: Map<number, number> | null): Promise<string | null> {
    if (heights) return normalizeResolution(heights.get(item.id) || null);
    const key = `${this.base}|${item.id}`;
    const hit = resolutions.get(key);
    if (hit && hit.addedAt === item.addedAt) return hit.resolution;
    const d = await this.get<BbDetail>(`/api/items/${item.id}`);
    const resolution = normalizeResolution(Math.max(0, ...(d.files ?? []).map((f) => f.height ?? 0)) || null);
    resolutions.set(key, { addedAt: item.addedAt, resolution });
    return resolution;
  }

  /** Every episode of a show: its seasons, then each season's episodes. */
  private async episodes(show: BbItem): Promise<BbItem[]> {
    const top = (await this.get<BbDetail>(`/api/items/${show.id}`)).children ?? [];
    const out = top.filter((c) => c.kind === 'episode');
    for (const season of top.filter((c) => c.kind === 'season')) out.push(...((await this.get<BbDetail>(`/api/items/${season.id}`)).children ?? []));
    return out;
  }

  /** Movie and show libraries. */
  async libraries(): Promise<BbLibrary[]> {
    return (await this.get<BbLibrary[]>('/api/libraries')).filter((l) => l.kind === 'movies' || l.kind === 'shows');
  }

  async fetchLibrary(): Promise<ServerItem[]> {
    const libs = await this.libraries();
    const heights = await this.heights();
    const items: ServerItem[] = [];
    for (const lib of libs) {
      const found: BbItem[] = [];
      for (let offset = 0; ; ) {
        const page = await this.get<{ items: BbItem[] | null; total: number }>(`/api/libraries/${lib.id}/items?sort=title&offset=${offset}&limit=500`);
        found.push(...(page.items ?? []));
        offset += 500;
        if (!page.items?.length || offset >= page.total) break;
      }
      await eachLimited(
        found.filter((i) => i.kind === 'movie' || i.kind === 'show'),
        6,
        async (i) => {
          const item: ServerItem = {
            externalKey: String(i.id),
            kind: i.kind === 'movie' ? 'movie' : 'show',
            title: i.title,
            year: i.year || null,
            tmdbId: i.tmdbId || null,
            tvdbId: i.tvdbId || null,
            imdbId: i.imdbId || null,
            resolution: i.kind === 'movie' ? await this.resolution(i, heights) : null,
            addedAt: i.addedAt ? i.addedAt * 1000 : null,
            ...plays(i),
            labels: i.labels ?? [],
            library: lib.name,
          };
          if (i.kind === 'show') {
            const eps = (await this.episodes(i)).filter((e) => e.seasonNumber !== undefined && e.episodeNumber !== undefined);
            item.episodes = [];
            await eachLimited(eps, 4, async (e) => {
              // A show counts as added when its newest episode was, so new episodes reach Recently added.
              if (e.addedAt) item.addedAt = Math.max(item.addedAt ?? 0, e.addedAt * 1000);
              item.episodes!.push({ season: e.seasonNumber!, episode: e.episodeNumber!, title: e.title, resolution: await this.resolution(e, heights), ...plays(e) });
            });
            rollUpViews(item);
          }
          items.push(item);
        },
      );
    }
    return items;
  }

  // ---------------- Collections ----------------

  async collections(libraryId: number): Promise<BbCollection[]> {
    return (await this.get<BbCollection[] | null>(`/api/libraries/${libraryId}/collections`)) ?? [];
  }

  /** A collection, or null once it's been deleted on the server. */
  async collection(id: number): Promise<BbCollection | null> {
    try {
      return (await this.get<{ collection: BbCollection }>(`/api/collections/${id}?limit=1`)).collection;
    } catch (err) {
      if (err instanceof IntegrationError && err.status === 404) return null;
      throw err;
    }
  }

  /** Item ids of every title in a collection. */
  async collectionItems(id: number): Promise<string[]> {
    const r = await this.get<{ items: { id: number }[] | null }>(`/api/collections/${id}`);
    return (r.items ?? []).map((i) => String(i.id));
  }

  /** Renames a collection or changes its description, keeping everything else BingeBandit stores with it. */
  async updateCollection(c: BbCollection, name: string, overview: string) {
    const body = { name, overview, mode: c.mode ?? '', listUrl: c.listUrl ?? '', labelRule: c.labelRule ?? '', genreRule: c.genreRule ?? '', studioRule: c.studioRule ?? '', yearFrom: c.yearFrom ?? 0, yearTo: c.yearTo ?? 0 };
    await this.send('PUT', `/api/admin/collections/${c.id}`, JSON.stringify(body), 'application/json');
  }

  /**
   * Adds a title to (or takes it out of) a hand-picked collection by name. BingeBandit sets a title's
   * collections as one list of names, making a missing collection in the title's library.
   */
  async setInCollection(itemId: string, name: string, member: boolean) {
    const path = `/api/admin/items/${encodeURIComponent(itemId)}/collections`;
    const now = (await this.get<{ collections: string[] | null }>(path)).collections ?? [];
    const others = now.filter((n) => n.toLowerCase() !== name.toLowerCase());
    await this.send('PUT', path, JSON.stringify({ collections: member ? [...others, name] : others }), 'application/json');
  }

  async setCollectionPosterUrl(id: number, url: string) {
    await this.send('PUT', `/api/admin/collections/${id}/artwork`, JSON.stringify({ type: 'poster', url }), 'application/json');
  }

  /** An image the server holds (a path like /api/images/tmdb/abc.jpg), for the image proxy. */
  async image(path: string): Promise<{ type: string; body: Buffer }> {
    const res = await this.send('GET', path);
    return { type: res.headers.get('content-type') ?? 'image/jpeg', body: Buffer.from(await res.arrayBuffer()) };
  }

  // ---------------- Writes: posters ----------------

  async setPosterUrl(id: string, url: string) {
    await this.send('PUT', `/api/admin/items/${encodeURIComponent(id)}/artwork`, JSON.stringify({ type: 'poster', url }), 'application/json');
  }

  async uploadPoster(id: string, data: Buffer, contentType: string) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(data)], { type: contentType }), 'poster');
    await this.send('POST', `/api/admin/items/${encodeURIComponent(id)}/artwork/upload?type=poster`, form);
  }
}
