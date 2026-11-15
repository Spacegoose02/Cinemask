import { z } from 'zod';
import { connectError, IntegrationError } from './http.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One book from BookBandit's catalog, as Cinemask keeps it. Anything else BookBandit sends is dropped. */
const BbBook = z.object({
  id: z.string().regex(UUID),
  title: z.string().min(1).max(1000),
  publishedYear: z.number().int().nullish(),
  coverPath: z.string().nullish(),
  kindleOnly: z.boolean().nullish(),
  authors: z.array(z.object({ name: z.string().max(500) })).max(50).nullish(),
});

export interface BookBanditBook {
  id: string;
  title: string;
  author: string | null;
  year: number | null;
  hasCover: boolean;
}

const BbLogin = z.object({ token: z.string().startsWith('bbs_').max(4000), expiresAt: z.number(), user: z.object({ role: z.string(), displayName: z.string().nullish() }) });

/**
 * Session tokens by address and account. BookBandit has no API keys: Cinemask signs in like an app does
 * (password sign-in, which hands back a 30-day bearer token), keeps the token in memory only, and signs
 * in again when it expires or is refused. A session remembers the password it was made with (it's in
 * memory as a setting anyway), so changing it in Settings starts a new session instead of reusing the old one.
 */
const sessions = new Map<string, { token: string; expiresAt: number; role: string; password: string }>();

/** BookBandit (github.com/Spacegoose02/bookbandit): the family's ebook library and reader. */
export class BookBanditClient {
  constructor(
    private readonly url: string,
    private readonly username: string,
    private readonly password: string,
  ) {}

  private get base() {
    return this.url.replace(/\/+$/, '');
  }

  private get key() {
    return `${this.base}|${this.username.toLowerCase()}`;
  }

  private async call(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
    try {
      return await fetch(`${this.base}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new IntegrationError('BookBandit', connectError(err));
    }
  }

  private async login(): Promise<{ token: string; role: string }> {
    const cached = sessions.get(this.key);
    // A day's margin so a token never runs out mid-sync.
    if (cached && cached.password === this.password && cached.expiresAt - Date.now() > 24 * 3600_000) return cached;
    if (!this.username || !this.password) throw new IntegrationError('BookBandit', 'enter the username and password Cinemask should sign in with');
    const res = await this.call('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: this.username.toLowerCase(), password: this.password }),
    });
    if (res.status === 401) throw new IntegrationError('BookBandit', 'the username or password was rejected', 401);
    if (res.status === 429) throw new IntegrationError('BookBandit', 'too many sign-in attempts; BookBandit has paused sign-in for a while', 429);
    if (!res.ok) throw new IntegrationError('BookBandit', `sign-in failed with HTTP ${res.status}`, res.status);
    const parsed = BbLogin.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new IntegrationError('BookBandit', "sign-in didn't return a session (is that address really BookBandit?)");
    const s = { token: parsed.data.token, expiresAt: parsed.data.expiresAt, role: parsed.data.user.role, password: this.password };
    sessions.set(this.key, s);
    return s;
  }

  /** Calls BookBandit as the signed-in account, signing in again once if the session was refused. */
  private async send(method: string, path: string, retried = false): Promise<Response> {
    const { token } = await this.login();
    const res = await this.call(path, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (res.status === 401 && !retried) {
      sessions.delete(this.key);
      return this.send(method, path, true);
    }
    if (res.status === 401) throw new IntegrationError('BookBandit', 'the session was refused (is the account disabled?)', 401);
    if (res.status === 403) throw new IntegrationError('BookBandit', 'that needs a BookBandit admin account', 403);
    if (!res.ok) throw new IntegrationError('BookBandit', `responded with HTTP ${res.status}`, res.status);
    return res;
  }

  private async json<T>(path: string): Promise<T> {
    const res = await this.send('GET', path);
    try {
      return (await res.json()) as T;
    } catch {
      throw new IntegrationError('BookBandit', 'returned something that is not JSON');
    }
  }

  async test(): Promise<{ role: string; admin: boolean }> {
    const res = await this.call('/api/health', { headers: { Accept: 'application/json' } }, 15_000);
    const health = res.ok ? ((await res.json().catch(() => null)) as { name?: string } | null) : null;
    if (health?.name !== 'bookbandit') throw new IntegrationError('BookBandit', res.ok ? "that address doesn't look like BookBandit" : `responded with HTTP ${res.status}`, res.status);
    sessions.delete(this.key);
    const { role } = await this.login();
    if (role === 'kid') throw new IntegrationError('BookBandit', 'use a grown-up account, not a kid profile');
    return { role, admin: role === 'admin' };
  }

  /** Every book the account can see, newest first. Kindle-only entries (no file) are left out. */
  async books(): Promise<BookBanditBook[]> {
    const out: BookBanditBook[] = [];
    // 200 a page (BookBandit's limit); stop at 100 pages so a misbehaving server can't loop forever.
    for (let page = 0; page < 100; page++) {
      const r = await this.json<{ items?: unknown[]; total?: number }>(`/api/books?sort=added&limit=200&offset=${page * 200}`);
      const items = Array.isArray(r.items) ? r.items : [];
      for (const raw of items) {
        const b = BbBook.safeParse(raw);
        if (!b.success || b.data.kindleOnly) continue;
        out.push({
          id: b.data.id.toLowerCase(),
          title: b.data.title.slice(0, 500),
          author: b.data.authors?.map((a) => a.name).join(', ').slice(0, 300) || null,
          year: b.data.publishedYear ?? null,
          hasCover: Boolean(b.data.coverPath),
        });
      }
      if (items.length < 200 || (page + 1) * 200 >= (r.total ?? 0)) break;
    }
    return out;
  }

  /** Asks BookBandit to look for new files. Needs an admin account. */
  async scan(): Promise<void> {
    await this.send('POST', '/api/admin/library/scan');
  }

  /** A book's cover. Only ids that look like BookBandit's are ever asked for. */
  async cover(id: string): Promise<{ type: string; body: Buffer }> {
    if (!UUID.test(id)) throw new IntegrationError('BookBandit', 'not a book id');
    const res = await this.send('GET', `/api/books/${id}/cover`);
    return { type: res.headers.get('content-type') ?? 'image/jpeg', body: Buffer.from(await res.arrayBuffer()) };
  }
}

/** Forgets signed-in sessions (tests, and after settings change). */
export function forgetBookBanditSessions() {
  sessions.clear();
}
