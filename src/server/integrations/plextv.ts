/** Minimal plex.tv account API client, used for "Sign in with Plex" and server discovery. */
const PLEX_TV = 'https://plex.tv/api/v2';
const CLIENTS = 'https://clients.plex.tv/api/v2';

export interface PlexHeaders {
  clientId: string;
  product: string;
}

function headers(h: PlexHeaders, token?: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'X-Plex-Product': h.product,
    'X-Plex-Client-Identifier': h.clientId,
    ...(token ? { 'X-Plex-Token': token } : {}),
  };
}

async function plexFetch<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`plex.tv responded ${res.status}`);
  return (await res.json()) as T;
}

export async function createPin(h: PlexHeaders): Promise<{ id: number; code: string }> {
  return plexFetch(`${PLEX_TV}/pins?strong=true`, { method: 'POST', headers: headers(h) });
}

export async function checkPin(h: PlexHeaders, id: number): Promise<string | null> {
  const pin = await plexFetch<{ authToken: string | null }>(`${PLEX_TV}/pins/${id}`, { headers: headers(h) });
  return pin.authToken || null;
}

export function authAppUrl(h: PlexHeaders, code: string): string {
  const params = new URLSearchParams({ clientID: h.clientId, code, 'context[device][product]': h.product });
  return `https://app.plex.tv/auth#?${params.toString()}`;
}

export interface PlexAccount {
  id: number;
  uuid: string;
  username: string;
  title: string;
  email: string;
}

export async function getAccount(h: PlexHeaders, token: string): Promise<PlexAccount> {
  return plexFetch(`${PLEX_TV}/user`, { headers: headers(h, token) });
}

export interface PlexResource {
  name: string;
  clientIdentifier: string;
  provides: string;
  owned: boolean;
  connections: { uri: string; local: boolean; relay: boolean }[];
}

export async function getResources(h: PlexHeaders, token: string): Promise<PlexResource[]> {
  return plexFetch(`${CLIENTS}/resources?includeHttps=1`, { headers: headers(h, token) });
}
