let csrfToken = '';

export function setCsrfToken(token: string) {
  csrfToken = token;
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
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; raw?: BodyInit } = {}): Promise<T> {
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
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText, data?.code);
  return data as T;
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
}

export interface AuthStatus {
  needsSetup: boolean;
  signedIn: boolean;
  methods: { local: boolean; oidc: { label: string } | null; plex: boolean };
}

export const RANK: Record<Role, number> = { user: 1, manager: 2, admin: 3 };
export const hasRole = (me: Me | null | undefined, role: Role) => Boolean(me && RANK[me.role] >= RANK[role]);

export function formatDate(ms: number | null | undefined): string {
  return ms ? new Date(ms).toLocaleString() : 'Never';
}

export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}
