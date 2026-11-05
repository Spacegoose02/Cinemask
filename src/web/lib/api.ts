let csrfToken = '';
let onSignedOut: (() => void) | null = null;

export function setCsrfToken(token: string) {
  csrfToken = token;
}

/** Called when the server says this browser's session is gone (expired, revoked, signed out elsewhere). */
export function setSignedOutHandler(fn: (() => void) | null) {
  onSignedOut = fn;
}


export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/** Fetch wrapper: same-origin cookies, CSRF header on writes, JSON in and out. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; raw?: BodyInit } = {}, retried = false): Promise<T> {
  const method = init.method ?? (init.body !== undefined || init.raw ? 'POST' : 'GET');
  const headers: Record<string, string> = { 'x-requested-with': 'fetch', ...init.headers };
  if (csrfToken) headers['x-csrf-token'] = csrfToken;
  let body: BodyInit | undefined = init.raw;
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const res = await fetch(path, { method, headers, body, credentials: 'same-origin' });
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    // This tab's token is from an older session (signed in again in another tab, say): fetch the current one and try once more.
    if (res.status === 403 && data?.code === 'csrf' && !retried && (await refreshCsrfToken())) return api<T>(path, init, true);
    // The access guard's "not signed in" (a wrong password at sign-in has its own code).
    if (res.status === 401 && data?.code === 'unauthorized') onSignedOut?.();
    throw new ApiError(res.status, data?.error ?? res.statusText, data?.code);
  }
  return data as T;
}

async function refreshCsrfToken(): Promise<boolean> {
  const res = await fetch('/api/auth/me', { headers: { 'x-requested-with': 'fetch' }, credentials: 'same-origin' });
  if (!res.ok) {
    if (res.status === 401) {
      onSignedOut?.();
      throw new ApiError(401, 'You were signed out. Sign in again.', 'unauthorized');
    }
    return false;
  }
  const r = (await res.json()) as { csrfToken: string | null };
  if (!r.csrfToken) return false;
  csrfToken = r.csrfToken;
  return true;
}

export type Role = 'user' | 'manager' | 'admin';

export interface Me {
  id: number;
  username: string;
  displayName: string | null;
  email: string | null;
  role: Role;
  isOwner: boolean;
  hasPassword: boolean;
  theme: string | null;
  language: string | null;
}

export interface AuthStatus {
  needsSetup: boolean;
  signedIn: boolean;
  methods: { local: boolean; oidc: { label: string } | null; plex: boolean };
}

export const RANK: Record<Role, number> = { user: 1, manager: 2, admin: 3 };
export const hasRole = (me: Me | null | undefined, role: Role) => Boolean(me && RANK[me.role] >= RANK[role]);

/** A day as YYYY-MM-DD on this device's calendar, to compare with air and release dates (which are local days). */
export function localDay(d: Date | number = new Date()): string {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

export function formatDate(ms: number | null | undefined): string {
  return ms ? new Date(ms).toLocaleString() : 'Never';
}

/** How long ago, as indexers show a release's age: "45 min", "6 hours", "12 days". */
export function formatAge(ms: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - ms) / 60000));
  if (min < 60) return `${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}
