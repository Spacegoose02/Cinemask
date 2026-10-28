import { vi } from 'vitest';

type Handler = (url: URL, init?: RequestInit) => unknown;

/** Replaces global fetch with canned JSON responses, matched by URL prefix. Unmatched URLs fail. */
export function fakeFetch(routes: Record<string, Handler>) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    const key = Object.keys(routes)
      .filter((k) => url.toString().startsWith(k) || `${url.origin}${url.pathname}` === k)
      .sort((a, b) => b.length - a.length)[0];
    if (!key) return new Response('not found', { status: 404 });
    const body = routes[key]!(url, init);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

export const PLEX = 'http://plex.local:32400';
export const JELLYFIN = 'http://jellyfin.local:8096';

export const plexRoutes = {
  [`${PLEX}/library/sections/1/all`]: () => ({
    MediaContainer: {
      Metadata: [
        { ratingKey: '10', type: 'movie', title: 'Paddington', year: 2014, addedAt: 1700000000, Guid: [{ id: 'tmdb://116149' }, { id: 'imdb://tt1109624' }], Media: [{ videoResolution: '1080' }], viewCount: 3, lastViewedAt: 1720000000, Label: [{ tag: 'Kids' }] },
        { ratingKey: '11', type: 'movie', title: 'Old Agent Movie', year: 1999, Guid: [{ id: 'imdb://tt0000001' }], Media: [{ videoResolution: 'sd' }] },
      ],
    },
  }),
  [`${PLEX}/library/sections/2/all`]: (url: URL) =>
    url.searchParams.get('type') === '4'
      ? {
          MediaContainer: {
            Metadata: [
              { ratingKey: '201', grandparentRatingKey: '20', parentIndex: 1, index: 1, title: 'Pilot', Media: [{ videoResolution: '4k' }], viewCount: 1, lastViewedAt: 1715000000 },
              { ratingKey: '202', grandparentRatingKey: '20', parentIndex: 1, index: 2, title: 'Two', addedAt: 1730000000, Media: [{ videoResolution: '1080' }] },
            ],
          },
        }
      : { MediaContainer: { Metadata: [{ ratingKey: '20', type: 'show', title: 'Bluey', year: 2018, addedAt: 1710000000, Guid: [{ id: 'tmdb://82728' }, { id: 'tvdb://353546' }] }] } },
  [`${PLEX}/library/sections`]: () => ({ MediaContainer: { Directory: [{ key: '1', type: 'movie', title: 'Movies' }, { key: '2', type: 'show', title: 'TV Shows' }, { key: '3', type: 'artist' }] } }),
  [`${PLEX}/`]: () => ({ MediaContainer: { friendlyName: 'Home Plex', version: '1.41.0', machineIdentifier: 'abc123' } }),
};

export const tmdbRoutes = {
  'https://api.themoviedb.org/3/find/tt0000001': () => ({ movie_results: [{ id: 999, title: 'Old Agent Movie' }], tv_results: [] }),
  'https://api.themoviedb.org/3/movie/116149': () => ({
    id: 116149,
    title: 'Paddington',
    overview: 'A bear in London.',
    release_date: '2014-11-28',
    runtime: 95,
    status: 'Released',
    poster_path: '/p.jpg',
    backdrop_path: '/b.jpg',
    vote_average: 7.2,
    genres: [{ id: 1, name: 'Family' }],
    imdb_id: 'tt1109624',
    credits: {
      cast: [
        { id: 2, name: 'Hugh Bonneville', character: 'Henry Brown', profile_path: null, order: 1 },
        { id: 1, name: 'Ben Whishaw', character: 'Paddington (voice)', profile_path: '/ben.jpg', order: 0 },
      ],
    },
    videos: { results: [{ key: 'teaser12345', site: 'YouTube', type: 'Teaser' }, { key: 'trailer1234', site: 'YouTube', type: 'Trailer', official: true }] },
    release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ type: 3, release_date: '2015-01-16T00:00:00Z' }, { type: 4, release_date: '2015-04-28T00:00:00Z' }] }] },
    belongs_to_collection: { id: 1, name: 'Paddington Collection', poster_path: null },
  }),
  'https://api.themoviedb.org/3/movie/555': () => ({
    id: 555,
    title: 'Future Film',
    overview: '',
    release_date: '2099-01-01',
    runtime: null,
    status: 'In Production',
    poster_path: null,
    backdrop_path: null,
    vote_average: 0,
    genres: [],
    imdb_id: null,
    videos: { results: [] },
    release_dates: { results: [] },
    belongs_to_collection: null,
  }),
  'https://api.themoviedb.org/3/tv/82728/season/1': () => ({
    season_number: 1,
    episodes: [1, 2, 3].map((n) => ({ episode_number: n, name: `Ep ${n}`, air_date: '2018-10-01', overview: '', still_path: null, runtime: 7, episode_type: n === 3 ? 'finale' : 'standard' })),
  }),
  'https://api.themoviedb.org/3/tv/82728': () => ({
    id: 82728,
    name: 'Bluey',
    overview: 'Dogs.',
    first_air_date: '2018-10-01',
    status: 'Returning Series',
    poster_path: '/bluey.jpg',
    backdrop_path: null,
    vote_average: 8.6,
    genres: [{ id: 2, name: 'Kids' }],
    networks: [{ id: 3, name: 'ABC Kids' }],
    aggregate_credits: { cast: [{ id: 5, name: 'Dave McCormack', roles: [{ character: 'Bandit (voice)', episode_count: 150 }], total_episode_count: 150, profile_path: '/dave.jpg', order: 0 }] },
    episode_run_time: [7],
    next_episode_to_air: null,
    seasons: [{ season_number: 1, name: 'Season 1', episode_count: 3, air_date: '2018-10-01', poster_path: null }],
    external_ids: { imdb_id: 'tt7678620', tvdb_id: 353546 },
    videos: { results: [] },
  }),
  'https://api.themoviedb.org/3/search/multi': () => ({
    page: 1,
    total_pages: 1,
    total_results: 3,
    results: [
      { id: 116149, media_type: 'movie', title: 'Paddington', release_date: '2014-11-28' },
      { id: 555, media_type: 'movie', title: 'Future Film', release_date: '2099-01-01' },
      { id: 777, media_type: 'movie', title: 'Not Here', release_date: '2001-01-01' },
      { id: 1, media_type: 'person', name: 'Someone' },
    ],
  }),
};

export const jellyfinRoutes = {
  [`${JELLYFIN}/System/Info`]: () => ({ ServerName: 'Family Jellyfin', Version: '10.10.0', Id: 'jf1' }),
  [`${JELLYFIN}/Items`]: (url: URL) =>
    url.searchParams.get('IncludeItemTypes') === 'Episode'
      ? { Items: [{ Id: 'e1', Type: 'Episode', Name: 'Pilot', SeriesId: 's1', ParentIndexNumber: 1, IndexNumber: 3, MediaStreams: [{ Type: 'Video', Height: 720 }] }] }
      : {
          Items: [
            { Id: 'm1', Type: 'Movie', Name: 'Paddington', ProductionYear: 2014, ProviderIds: { Tmdb: '116149' }, MediaStreams: [{ Type: 'Video', Height: 2160 }], DateCreated: '2024-01-01T00:00:00Z' },
            { Id: 's1', Type: 'Series', Name: 'Bluey', ProductionYear: 2018, ProviderIds: { Tmdb: '82728' } },
          ],
        },
};

export const BINGEBANDIT = 'http://bingebandit.local:8080';

const bbItems: Record<number, unknown> = {
  100: { item: { id: 100, kind: 'movie', title: 'Paddington', year: 2014, tmdbId: 116149, addedAt: 1700000000, labels: ['Kids'], watch: { watched: true, updatedAt: 1720000000 } }, files: [{ height: 1080 }] },
  200: { item: { id: 200, kind: 'show', title: 'Bluey' }, children: [{ id: 201, kind: 'season', title: 'Season 1', seasonNumber: 1, addedAt: 1710000000 }] },
  201: {
    item: { id: 201, kind: 'season' },
    children: [
      { id: 202, kind: 'episode', title: 'Magic Xylophone', seasonNumber: 1, episodeNumber: 1, addedAt: 1710000000, watch: { watched: true, updatedAt: 1715000000 } },
      { id: 203, kind: 'episode', title: 'Hospital', seasonNumber: 1, episodeNumber: 2, addedAt: 1730000000, watch: { watched: false, updatedAt: 0 } },
    ],
  },
  202: { item: { id: 202, kind: 'episode' }, files: [{ height: 2160 }] },
  203: { item: { id: 203, kind: 'episode' }, files: [{ height: 720 }] },
};

export const bingeBanditRoutes = {
  [`${BINGEBANDIT}/api/health`]: () => ({ status: 'ok', version: '1.8.0', product: 'BingeBandit', name: 'Den' }),
  [`${BINGEBANDIT}/api/me`]: () => ({ id: 1, username: 'goose', isAdmin: true }),
  [`${BINGEBANDIT}/api/libraries`]: () => [
    { id: 1, name: 'Movies', kind: 'movies' },
    { id: 2, name: 'Kids TV', kind: 'shows' },
    { id: 3, name: 'Music', kind: 'music' },
  ],
  [`${BINGEBANDIT}/api/libraries/1/items`]: () => ({ items: [{ id: 100, kind: 'movie', title: 'Paddington', year: 2014, tmdbId: 116149, addedAt: 1700000000, labels: ['Kids'], watch: { watched: true, updatedAt: 1720000000 } }], total: 1 }),
  [`${BINGEBANDIT}/api/libraries/2/items`]: () => ({ items: [{ id: 200, kind: 'show', title: 'Bluey', year: 2018, tmdbId: 82728, tvdbId: 353546, addedAt: 1710000000, watch: { watched: false, updatedAt: 0 } }], total: 1 }),
  [`${BINGEBANDIT}/api/items/`]: (url: URL) => bbItems[Number(url.pathname.split('/').pop())] ?? new Response('not found', { status: 404 }),
  [`${BINGEBANDIT}/api/admin/`]: () => new Response(null, { status: 202 }),
  // Older BingeBandit: no file list, so quality comes from each title's page.
  [`${BINGEBANDIT}/api/admin/files`]: () => new Response('404 page not found', { status: 404 }),
};

/** BingeBandit's file list (GET /api/admin/files), the same quality as bbItems in one request. */
export const bingeBanditFiles = {
  [`${BINGEBANDIT}/api/admin/files`]: () => ({
    files: [
      { fileId: 1, itemId: 100, kind: 'movie', height: 1080 },
      { fileId: 2, itemId: 202, kind: 'episode', height: 2160 },
      { fileId: 3, itemId: 203, kind: 'episode', height: 720 },
    ],
    total: 3,
  }),
};

interface FakeCollection {
  id: number;
  libraryId: number;
  name: string;
  overview: string;
  mode: string;
  poster?: string;
  labelRule?: string;
  members: Set<number>;
}

/**
 * BingeBandit's collections, kept like the server does: a title's collections are set as a list of
 * names, which makes a missing collection in the title's library.
 */
export function bingeBanditCollections(initial: Omit<FakeCollection, 'members'>[] = [], members: Record<number, number[]> = {}) {
  const libraryOf: Record<number, number> = { 100: 1, 200: 2 };
  const cols: FakeCollection[] = initial.map((c) => ({ ...c, members: new Set(members[c.id] ?? []) }));
  let next = 50;
  const view = ({ members, ...c }: FakeCollection) => ({ ...c, itemCount: members.size });
  const json = (init?: RequestInit) => JSON.parse(String(init?.body)) as Record<string, unknown>;
  const routes = {
    [`${BINGEBANDIT}/api/libraries/1/collections`]: () => cols.filter((c) => c.libraryId === 1).map(view),
    [`${BINGEBANDIT}/api/libraries/2/collections`]: () => cols.filter((c) => c.libraryId === 2).map(view),
    [`${BINGEBANDIT}/api/collections/`]: (url: URL) => {
      const c = cols.find((x) => x.id === Number(url.pathname.split('/').pop()));
      return c ? { collection: view(c), items: [...c.members].map((id) => ({ id })), total: c.members.size } : new Response('not found', { status: 404 });
    },
    [`${BINGEBANDIT}/api/admin/items/`]: (url: URL, init?: RequestInit) => {
      const [, , , , id, what] = url.pathname.split('/');
      const item = Number(id);
      if (what !== 'collections') return new Response(null, { status: 204 });
      if (init?.method === 'PUT') {
        const names = json(init).collections as string[];
        for (const c of cols) if (c.libraryId === libraryOf[item]) c.members.delete(item);
        for (const n of names) {
          let c = cols.find((x) => x.libraryId === libraryOf[item] && x.name.toLowerCase() === n.toLowerCase());
          if (!c) cols.push((c = { id: next++, libraryId: libraryOf[item]!, name: n, overview: '', mode: '', members: new Set() }));
          c.members.add(item);
        }
        return new Response(null, { status: 204 });
      }
      return { collections: cols.filter((c) => c.members.has(item)).map((c) => c.name) };
    },
    [`${BINGEBANDIT}/api/admin/collections/`]: (url: URL, init?: RequestInit) => {
      const [, , , , id, what] = url.pathname.split('/');
      const c = cols.find((x) => x.id === Number(id))!;
      if (what === 'artwork') c.poster = String(json(init).url);
      else Object.assign(c, { name: json(init).name, overview: json(init).overview });
      return view(c);
    },
    [`${BINGEBANDIT}/api/images/`]: () => new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } }),
  };
  return { routes, cols };
}

/** A request body as text; form uploads read like a query string, with files shown by name. */
export function bodyText(body: unknown): string {
  if (!(body instanceof FormData)) return String(body);
  const p = new URLSearchParams();
  for (const [k, v] of body.entries()) p.append(k, typeof v === 'string' ? v : v.name);
  return p.toString();
}

/** A tiny .torrent file, as an indexer would serve it. */
export const torrentFile = () => new Response('d4:infod4:name4:testee', { headers: { 'content-type': 'application/x-bittorrent' } });
