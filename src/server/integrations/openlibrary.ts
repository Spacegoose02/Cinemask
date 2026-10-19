import { eq } from 'drizzle-orm';
import type { Orm } from '../db/database.js';
import { httpCache } from '../db/schema.js';
import { sha256 } from '../security/crypto.js';
import { fetchJson } from './http.js';

const BASE = 'https://openlibrary.org';

export interface OlWork {
  key: string; // /works/OL45804W
  title: string;
  author_name?: string[];
  first_publish_year?: number;
  cover_i?: number;
  isbn?: string[];
  edition_count?: number;
}

export interface BookCard {
  workKey: string;
  title: string;
  author: string | null;
  year: number | null;
  coverId: number | null;
  isbn: string | null;
}

export const toBookCard = (w: OlWork): BookCard => ({
  workKey: w.key,
  title: w.title,
  author: w.author_name?.[0] ?? null,
  year: w.first_publish_year ?? null,
  coverId: w.cover_i ?? null,
  isbn: w.isbn?.[0] ?? null,
});

/** Open Library: free book metadata and covers, no key needed. Responses are cached like TMDB's. */
export class OpenLibraryClient {
  constructor(private readonly db: () => Orm) {}

  private async get<T>(path: string, ttlMs: number): Promise<T> {
    const key = sha256(`ol:${path}`);
    const hit = this.db().select().from(httpCache).where(eq(httpCache.key, key)).get();
    if (hit && hit.expiresAt > Date.now()) return JSON.parse(hit.body) as T;
    const data = await fetchJson<T>('Open Library', `${BASE}${path}`, { headers: { 'User-Agent': 'Cinemask (self-hosted media manager)' } });
    const body = JSON.stringify(data);
    this.db()
      .insert(httpCache)
      .values({ key, body, expiresAt: Date.now() + ttlMs })
      .onConflictDoUpdate({ target: httpCache.key, set: { body, expiresAt: Date.now() + ttlMs } })
      .run();
    return data;
  }

  async search(q: string, page = 1): Promise<{ total: number; works: BookCard[] }> {
    const qs = new URLSearchParams({ q, page: String(page), limit: '24', fields: 'key,title,author_name,first_publish_year,cover_i,isbn,edition_count' });
    const r = await this.get<{ numFound: number; docs: OlWork[] }>(`/search.json?${qs.toString()}`, 24 * 60 * 60 * 1000);
    return { total: r.numFound, works: r.docs.map(toBookCard) };
  }

  async trending(): Promise<BookCard[]> {
    const r = await this.get<{ works: OlWork[] }>('/trending/weekly.json?limit=24', 6 * 60 * 60 * 1000);
    return r.works.map(toBookCard);
  }

  /** One work, for requests: title and first author from the work and its search entry. */
  async work(workKey: string): Promise<BookCard | null> {
    const id = workKey.replace('/works/', '');
    const r = await this.get<{ docs: OlWork[] }>(`/search.json?q=key:/works/${encodeURIComponent(id)}&fields=key,title,author_name,first_publish_year,cover_i,isbn`, 7 * 24 * 60 * 60 * 1000);
    return r.docs[0] ? toBookCard(r.docs[0]) : null;
  }
}

export const coverUrl = (coverId: number | null, size: 'S' | 'M' | 'L' = 'M') => (coverId ? `https://covers.openlibrary.org/b/id/${coverId}-${size}.jpg` : null);
