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
              { ratingKey: '202', grandparentRatingKey: '20', parentIndex: 1, index: 2, title: 'Two', Media: [{ videoResolution: '1080' }] },
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
    episodes: [1, 2, 3].map((n) => ({ episode_number: n, name: `Ep ${n}`, air_date: '2018-10-01', overview: '', still_path: null, runtime: 7 })),
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

/** A request body as text; form uploads read like a query string, with files shown by name. */
export function bodyText(body: unknown): string {
  if (!(body instanceof FormData)) return String(body);
  const p = new URLSearchParams();
  for (const [k, v] of body.entries()) p.append(k, typeof v === 'string' ? v : v.name);
  return p.toString();
}

/** A tiny .torrent file, as an indexer would serve it. */
export const torrentFile = () => new Response('d4:infod4:name4:testee', { headers: { 'content-type': 'application/x-bittorrent' } });
