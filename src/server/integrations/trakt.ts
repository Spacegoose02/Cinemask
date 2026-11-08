import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { users, type MediaKind } from '../db/schema.js';
import { openSecret, sealSecret } from '../arr/secrets.js';
import { connectError, IntegrationError } from './http.js';

/**
 * Trakt (trakt.tv): people link their account with a device code (no redirect URL needed), then
 * their Trakt watchlist feeds watchlist sync, and Trakt lists (anyone's public lists, or the
 * trending, popular and anticipated charts) can be added on Lists. The admin registers a Trakt
 * app once and puts its client id and secret in Settings → Metadata.
 */
export const TRAKT_API = 'https://api.trakt.tv';
const SERVICE = 'Trakt';

export function traktConfigured(ctx: AppContext): boolean {
  const s = ctx.settings.get('trakt');
  return Boolean(s.clientId && s.clientSecret);
}

async function call<T>(ctx: AppContext, path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<{ status: number; body: T | null }> {
  const s = ctx.settings.get('trakt');
  let res: Response;
  try {
    res = await fetch(`${TRAKT_API}${path}`, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: {
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
        'trakt-api-key': s.clientId,
        'User-Agent': 'Cinemask',
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new IntegrationError(SERVICE, connectError(err));
  }
  const text = await res.text();
  try {
    return { status: res.status, body: text ? (JSON.parse(text) as T) : null };
  } catch {
    return { status: res.status, body: null };
  }
}

async function get<T>(ctx: AppContext, path: string, token?: string): Promise<T> {
  const r = await call<T>(ctx, path, { token });
  if (r.status === 401 || r.status === 403) throw new IntegrationError(SERVICE, token ? 'link your Trakt account again' : 'the client id was rejected', r.status);
  if (r.status === 404) throw new IntegrationError(SERVICE, 'that list was not found (is it private?)', 404);
  if (r.status >= 400 || r.body === null) throw new IntegrationError(SERVICE, `responded with HTTP ${r.status}`, r.status);
  return r.body;
}

// ---------------------------------------------------------------- device linking

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

export async function startDeviceLink(ctx: AppContext): Promise<DeviceCode> {
  if (!traktConfigured(ctx)) throw new IntegrationError(SERVICE, 'an admin needs to add a Trakt app in Settings → Metadata first');
  const r = await call<DeviceCode>(ctx, '/oauth/device/code', { body: { client_id: ctx.settings.get('trakt').clientId } });
  if (r.status !== 200 || !r.body) throw new IntegrationError(SERVICE, `responded with HTTP ${r.status}`, r.status);
  return r.body;
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  created_at: number;
}

const seal = (ctx: AppContext, t: Tokens) => sealSecret(ctx, JSON.stringify({ access: t.access_token, refresh: t.refresh_token, expiresAt: (t.created_at + t.expires_in) * 1000 }));

/** Checks whether the person has entered the code yet. */
export async function pollDeviceLink(ctx: AppContext, userId: number, deviceCode: string): Promise<'linked' | 'pending' | 'expired' | 'denied' | 'slow_down'> {
  const s = ctx.settings.get('trakt');
  const r = await call<Tokens>(ctx, '/oauth/device/token', { body: { code: deviceCode, client_id: s.clientId, client_secret: s.clientSecret } });
  if (r.status === 400) return 'pending';
  if (r.status === 429) return 'slow_down';
  if (r.status === 418) return 'denied';
  if (r.status === 404 || r.status === 409 || r.status === 410) return 'expired';
  if (r.status !== 200 || !r.body?.access_token) throw new IntegrationError(SERVICE, `responded with HTTP ${r.status}`, r.status);
  const settings = await get<{ user?: { username?: string; ids?: { slug?: string } } }>(ctx, '/users/settings', r.body.access_token).catch(() => null);
  ctx.db
    .update(users)
    .set({ traktToken: seal(ctx, r.body), traktUser: settings?.user?.ids?.slug ?? settings?.user?.username ?? null })
    .where(eq(users.id, userId))
    .run();
  return 'linked';
}

/** The person's access token, refreshed when it's about to run out. */
async function tokenFor(ctx: AppContext, userId: number): Promise<string> {
  const u = ctx.db.select({ t: users.traktToken }).from(users).where(eq(users.id, userId)).get();
  if (!u?.t) throw new IntegrationError(SERVICE, 'not linked');
  const t = JSON.parse(openSecret(ctx, u.t)) as { access: string; refresh: string; expiresAt: number };
  if (t.expiresAt - Date.now() > 24 * 60 * 60 * 1000) return t.access;
  const s = ctx.settings.get('trakt');
  const r = await call<Tokens>(ctx, '/oauth/token', { body: { refresh_token: t.refresh, client_id: s.clientId, client_secret: s.clientSecret, redirect_uri: 'urn:ietf:wg:oauth:2.0:oob', grant_type: 'refresh_token' } });
  if (r.status !== 200 || !r.body?.access_token) throw new IntegrationError(SERVICE, 'link your Trakt account again', r.status);
  ctx.db.update(users).set({ traktToken: seal(ctx, r.body) }).where(eq(users.id, userId)).run();
  return r.body.access_token;
}

// ---------------------------------------------------------------- items

interface TraktMedia {
  title?: string;
  year?: number | null;
  ids?: { tmdb?: number | null };
}
type TraktEntry = { type?: string; movie?: TraktMedia; show?: TraktMedia } & TraktMedia;

export interface TraktItem {
  kind: MediaKind;
  tmdbId: number | null;
  title: string;
  year: number | null;
}

/** List entries come wrapped ({ movie }, { show }) or bare (popular charts); `kind` says which for bare ones. */
export function toItems(entries: TraktEntry[], kind?: MediaKind): TraktItem[] {
  const out: TraktItem[] = [];
  for (const e of entries) {
    const m = e.movie ?? e.show ?? (kind ? e : null);
    const k: MediaKind | null = e.movie ? 'movie' : e.show ? 'show' : (kind ?? null);
    if (!m || !k) continue;
    out.push({ kind: k, tmdbId: m.ids?.tmdb ?? null, title: m.title ?? '', year: m.year ?? null });
  }
  return out;
}

export async function traktWatchlist(ctx: AppContext, userId: number): Promise<TraktItem[]> {
  const token = await tokenFor(ctx, userId);
  const [movies, shows] = await Promise.all([get<TraktEntry[]>(ctx, '/sync/watchlist/movies', token), get<TraktEntry[]>(ctx, '/sync/watchlist/shows', token)]);
  return [...toItems(movies), ...toItems(shows)];
}

/** Charts Lists can follow: movies or shows, trending, popular, anticipated… */
const CHARTS = /^(movies|shows)\/(trending|popular|anticipated|watched\/weekly|collected\/weekly|boxoffice)$/;

/** A Trakt address as the API path to read: a user's list, their watchlist, or a chart. Null when it isn't one. */
export function traktPath(url: URL): string | null {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (!/(^|\.)trakt\.tv$/.test(url.hostname)) return null;
  const safe = (s: string) => /^[\w.~-]{1,100}$/.test(s);
  if (parts[0] === 'users' && parts[1] && safe(parts[1])) {
    if (parts[2] === 'lists' && parts[3] && safe(parts[3])) return `/users/${parts[1]}/lists/${parts[3]}/items`;
    if (parts[2] === 'watchlist') return `/users/${parts[1]}/watchlist`;
  }
  const chart = parts.join('/');
  if (CHARTS.test(chart)) return `/${chart}`;
  return null;
}

/** Items of a public list or chart (path from traktPath). */
export async function traktList(ctx: AppContext, path: string): Promise<TraktItem[]> {
  if (!ctx.settings.get('trakt').clientId) throw new IntegrationError(SERVICE, 'add a Trakt client id in Settings → Metadata');
  const kind: MediaKind | undefined = path.startsWith('/movies/') ? 'movie' : path.startsWith('/shows/') ? 'show' : undefined;
  const sep = path.includes('?') ? '&' : '?';
  return toItems(await get<TraktEntry[]>(ctx, `${path}${sep}limit=100`), kind);
}
