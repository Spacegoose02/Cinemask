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

const DISCOVER = 'https://discover.provider.plex.tv';

interface DiscoverItem {
  ratingKey: string;
  type: string;
  title: string;
  year?: number;
  Guid?: { id: string }[];
}

const tmdbOf = (guids: { id: string }[] | undefined) => {
  const g = guids?.find((x) => x.id.startsWith('tmdb://'));
  const n = g ? Number(g.id.slice(7)) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** The account's Plex watchlist (movies and shows), with TMDB ids. At most `max` items. */
export async function getWatchlist(h: PlexHeaders, token: string, max = 300): Promise<{ kind: 'movie' | 'show'; title: string; tmdbId: number | null }[]> {
  const out: { kind: 'movie' | 'show'; title: string; tmdbId: number | null }[] = [];
  for (let start = 0; start < max; start += 100) {
    const page = await plexFetch<{ MediaContainer: { totalSize?: number; Metadata?: DiscoverItem[] } }>(
      `${DISCOVER}/library/sections/watchlist/all?includeGuids=1&X-Plex-Container-Start=${start}&X-Plex-Container-Size=100`,
      { headers: headers(h, token) },
    );
    const items = page.MediaContainer.Metadata ?? [];
    for (const i of items) {
      if (i.type !== 'movie' && i.type !== 'show') continue;
      let tmdbId = tmdbOf(i.Guid);
      if (tmdbId === null) {
        // Older answers leave the ids out of the list; the item's own page has them.
        const one = await plexFetch<{ MediaContainer: { Metadata?: DiscoverItem[] } }>(`${DISCOVER}/library/metadata/${encodeURIComponent(i.ratingKey)}`, { headers: headers(h, token) }).catch(() => null);
        tmdbId = tmdbOf(one?.MediaContainer.Metadata?.[0]?.Guid);
      }
      out.push({ kind: i.type, title: i.title, tmdbId });
    }
    if (items.length < 100 || start + 100 >= (page.MediaContainer.totalSize ?? 0)) break;
  }
  return out;
}
