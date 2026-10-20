import { connectError, fetchJson, IntegrationError } from './http.js';

export interface AbsLibrary {
  id: string;
  name: string;
  mediaType: 'book' | 'podcast';
  folders: { id: string; fullPath: string }[];
}

export interface AbsItem {
  id: string;
  libraryId: string;
  mediaType: 'book' | 'podcast';
  addedAt?: number;
  media: { metadata: { title?: string; authorName?: string; author?: string; asin?: string | null; isbn?: string | null; feedUrl?: string } };
}

export interface AbsPodcastResult {
  id: number;
  title: string;
  artistName?: string;
  description?: string;
  cover?: string;
  feedUrl?: string;
  genres?: string[];
  trackCount?: number;
  explicit?: boolean;
}

/** Audiobookshelf API client (API token as a Bearer token). */
export class AudiobookshelfClient {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private base() {
    return this.url.replace(/\/+$/, '');
  }

  private get<T>(path: string) {
    return fetchJson<T>('Audiobookshelf', `${this.base()}${path}`, { headers: { Authorization: `Bearer ${this.token}` } }, 60_000);
  }

  private async send(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.base()}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new IntegrationError('Audiobookshelf', connectError(err));
    }
    if (res.status === 401 || res.status === 403) throw new IntegrationError('Audiobookshelf', 'the API token was rejected', res.status);
    if (!res.ok) throw new IntegrationError('Audiobookshelf', `responded with HTTP ${res.status}`, res.status);
    return res.headers.get('content-type')?.includes('json') ? res.json() : null;
  }

  async test(): Promise<string> {
    const libs = await this.libraries();
    return `Connected (${libs.length} ${libs.length === 1 ? 'library' : 'libraries'})`;
  }

  async libraries(): Promise<AbsLibrary[]> {
    return (await this.get<{ libraries: AbsLibrary[] }>('/api/libraries')).libraries;
  }

  async items(libraryId: string): Promise<AbsItem[]> {
    const out: AbsItem[] = [];
    for (let page = 0; page < 100; page++) {
      const r = await this.get<{ results: AbsItem[]; total: number }>(`/api/libraries/${encodeURIComponent(libraryId)}/items?limit=500&page=${page}&minified=1`);
      out.push(...r.results);
      if (out.length >= r.total || !r.results.length) break;
    }
    return out;
  }

  async scan(libraryId: string) {
    await this.send('POST', `/api/libraries/${encodeURIComponent(libraryId)}/scan`);
  }

  async searchPodcasts(term: string): Promise<AbsPodcastResult[]> {
    return this.get<AbsPodcastResult[]>(`/api/search/podcast?term=${encodeURIComponent(term)}`);
  }

  /** Subscribes the podcast library to a feed, downloading new episodes automatically. */
  async addPodcast(libraryId: string, p: { feedUrl: string; title: string; author?: string; imageUrl?: string; description?: string }) {
    const lib = (await this.libraries()).find((l) => l.id === libraryId);
    const folder = lib?.folders[0];
    if (!lib || !folder) throw new IntegrationError('Audiobookshelf', 'the podcast library was not found');
    const safe = p.title.replace(/[<>:"/\\|?*]/g, '').trim().slice(0, 150) || 'Podcast';
    await this.send('POST', '/api/podcasts', {
      path: `${folder.fullPath.replace(/\/+$/, '')}/${safe}`,
      folderId: folder.id,
      libraryId,
      media: { metadata: { title: p.title, author: p.author, feedUrl: p.feedUrl, imageUrl: p.imageUrl, description: p.description }, autoDownloadEpisodes: true },
    });
  }

  async image(path: string): Promise<{ type: string; body: Buffer }> {
    let res: Response;
    try {
      res = await fetch(`${this.base()}${path}`, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new IntegrationError('Audiobookshelf', connectError(err));
    }
    if (!res.ok) throw new IntegrationError('Audiobookshelf', `responded with HTTP ${res.status}`, res.status);
    return { type: res.headers.get('content-type') ?? 'image/jpeg', body: Buffer.from(await res.arrayBuffer()) };
  }
}
