import { IntegrationError } from './http.js';

export interface ShelfmarkBook {
  id: string;
  title: string;
  author?: string;
  year?: string | number;
  language?: string;
  format?: string;
  size?: string;
  preview?: string;
}

export type ShelfmarkState = 'queued' | 'downloading' | 'done' | 'available' | 'error' | 'unknown';

/**
 * Shelfmark (the book search and download service) over its HTTP API: search, queue a download,
 * and read the queue status. Shelfmark saves finished books into its own ingest folder.
 */
export class ShelfmarkClient {
  constructor(
    private readonly url: string,
    private readonly username: string,
    private readonly password: string,
  ) {}

  private async get<T>(path: string): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.username) headers.Authorization = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`;
    let res: Response;
    try {
      res = await fetch(`${this.url.replace(/\/+$/, '')}${path}`, { headers, signal: AbortSignal.timeout(60_000) });
    } catch {
      throw new IntegrationError('Shelfmark', 'could not connect');
    }
    if (res.status === 401 || res.status === 403) throw new IntegrationError('Shelfmark', 'the username or password was rejected', res.status);
    if (!res.ok) throw new IntegrationError('Shelfmark', `responded with HTTP ${res.status}`, res.status);
    try {
      return (await res.json()) as T;
    } catch {
      throw new IntegrationError('Shelfmark', 'returned something that is not JSON');
    }
  }

  async test(): Promise<string> {
    await this.status();
    return 'Connected';
  }

  async search(query: string, format?: string): Promise<ShelfmarkBook[]> {
    const qs = new URLSearchParams({ query });
    if (format) qs.set('format', format);
    const r = await this.get<ShelfmarkBook[] | { results?: ShelfmarkBook[] }>(`/api/search?${qs.toString()}`);
    return Array.isArray(r) ? r : (r.results ?? []);
  }

  async download(id: string): Promise<void> {
    await this.get(`/api/download?id=${encodeURIComponent(id)}`);
  }

  /** The queue, grouped by state, keyed by book id. */
  async status(): Promise<Record<string, Record<string, unknown>>> {
    return this.get<Record<string, Record<string, unknown>>>('/api/status');
  }

  static stateOf(status: Record<string, Record<string, unknown>>, id: string): ShelfmarkState {
    for (const [state, items] of Object.entries(status)) {
      if (items && typeof items === 'object' && id in items) {
        if (['queued', 'downloading', 'done', 'available', 'error'].includes(state)) return state as ShelfmarkState;
      }
    }
    return 'unknown';
  }
}
