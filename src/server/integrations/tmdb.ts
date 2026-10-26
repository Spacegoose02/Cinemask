import { eq, lt } from 'drizzle-orm';
import type { Orm } from '../db/database.js';
import { httpCache, type MediaKind } from '../db/schema.js';
import { sha256 } from '../security/crypto.js';
import { fetchJson, IntegrationError } from './http.js';

const BASE = 'https://api.themoviedb.org/3';
export const TMDB_IMAGE = 'https://image.tmdb.org/t/p';

export interface TmdbSearchResult {
  id: number;
  media_type?: 'movie' | 'tv' | 'person';
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  popularity?: number;
  genre_ids?: number[];
  original_language?: string;
}

export interface TmdbVideo {
  key: string;
  site: string;
  type: string;
  name?: string;
  official?: boolean;
  size?: number;
  published_at?: string;
}

export interface TmdbMovie {
  id: number;
  title: string;
  overview: string;
  release_date: string;
  runtime: number | null;
  status: string;
  poster_path: string | null;
  backdrop_path: string | null;
  vote_average: number;
  genres: { id: number; name: string }[];
  imdb_id: string | null;
  videos?: { results: TmdbVideo[] };
  release_dates?: { results: { iso_3166_1: string; release_dates: { type: number; release_date: string }[] }[] };
  belongs_to_collection?: { id: number; name: string; poster_path: string | null } | null;
  credits?: { cast: { id: number; name: string; character: string; profile_path: string | null; order: number }[] };
}

export interface TmdbShow {
  id: number;
  name: string;
  overview: string;
  first_air_date: string;
  status: string;
  poster_path: string | null;
  backdrop_path: string | null;
  vote_average: number;
  genres: { id: number; name: string }[];
  networks: { id: number; name: string }[];
  episode_run_time: number[];
  next_episode_to_air: { air_date: string; season_number: number; episode_number: number; name: string } | null;
  seasons: { season_number: number; name: string; episode_count: number; air_date: string | null; poster_path: string | null }[];
  external_ids?: { imdb_id: string | null; tvdb_id: number | null };
  videos?: { results: TmdbVideo[] };
  /** Cast across every season, with the episodes each person is in. */
  aggregate_credits?: { cast: { id: number; name: string; roles: { character: string; episode_count: number }[]; total_episode_count: number; profile_path: string | null; order: number }[] };
}

export interface TmdbSeason {
  season_number: number;
  episodes: { episode_number: number; name: string; air_date: string | null; overview: string; still_path: string | null; runtime: number | null; episode_type?: string | null }[];
}

interface Paged<T> {
  page: number;
  total_pages: number;
  total_results: number;
  results: T[];
}

/** TMDB API client. Responses are cached in the database so browsing stays fast and within rate limits. */
export class TmdbClient {
  constructor(
    private readonly db: () => Orm,
    private readonly key: string,
    private readonly language: string,
    private readonly region: string,
  ) {}

  get configured() {
    return Boolean(this.key);
  }

  private async get<T>(path: string, params: Record<string, string | number | undefined> = {}, ttlMs = 6 * 60 * 60 * 1000): Promise<T> {
    if (!this.key) throw new IntegrationError('TMDB', 'no API key is set (Settings → Metadata)');
    const qs = new URLSearchParams({ language: this.language });
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
    // v4 read tokens are JWTs and go in a header; v3 keys go in the query string.
    const bearer = this.key.startsWith('eyJ');
    if (!bearer) qs.set('api_key', this.key);
    const url = `${BASE}${path}?${qs.toString()}`;
    const cacheKey = sha256(`tmdb:${path}?${qs.toString()}`);
    const hit = this.db().select().from(httpCache).where(eq(httpCache.key, cacheKey)).get();
    if (hit && hit.expiresAt > Date.now()) return JSON.parse(hit.body) as T;
    const data = await fetchJson<T>('TMDB', url, bearer ? { headers: { Authorization: `Bearer ${this.key}` } } : {});
    const body = JSON.stringify(data);
    this.db()
      .insert(httpCache)
      .values({ key: cacheKey, body, expiresAt: Date.now() + ttlMs })
      .onConflictDoUpdate({ target: httpCache.key, set: { body, expiresAt: Date.now() + ttlMs } })
      .run();
    return data;
  }

  test() {
    return this.get<{ images: unknown }>('/configuration', {}, 60_000);
  }

  searchMulti(query: string, page = 1) {
    return this.get<Paged<TmdbSearchResult>>('/search/multi', { query, page, include_adult: 'false' }, 30 * 60 * 1000);
  }

  trending(kind: 'all' | 'movie' | 'tv' = 'all', window: 'day' | 'week' = 'week') {
    return this.get<Paged<TmdbSearchResult>>(`/trending/${kind}/${window}`);
  }

  popular(kind: 'movie' | 'tv', page = 1) {
    return this.get<Paged<TmdbSearchResult>>(`/${kind}/popular`, { page, region: this.region });
  }

  upcomingMovies(page = 1) {
    return this.get<Paged<TmdbSearchResult>>('/movie/upcoming', { page, region: this.region });
  }

  discover(kind: 'movie' | 'tv', params: Record<string, string | number | undefined>) {
    return this.get<Paged<TmdbSearchResult>>(`/discover/${kind}`, params, 60 * 60 * 1000);
  }

  genres(kind: 'movie' | 'tv') {
    return this.get<{ genres: { id: number; name: string }[] }>(`/genre/${kind}/list`, {}, 7 * 24 * 60 * 60 * 1000);
  }

  watchProviders(kind: 'movie' | 'tv') {
    return this.get<{ results: { provider_id: number; provider_name: string; logo_path: string; display_priority: number }[] }>(
      `/watch/providers/${kind}`,
      { watch_region: this.region },
      7 * 24 * 60 * 60 * 1000,
    );
  }

  movie(id: number) {
    return this.get<TmdbMovie>(`/movie/${id}`, { append_to_response: 'videos,release_dates,credits' });
  }

  show(id: number) {
    return this.get<TmdbShow>(`/tv/${id}`, { append_to_response: 'videos,external_ids,aggregate_credits' });
  }

  season(id: number, season: number) {
    return this.get<TmdbSeason>(`/tv/${id}/season/${season}`);
  }

  collection(id: number) {
    return this.get<{ id: number; name: string; overview: string; poster_path: string | null; parts: TmdbSearchResult[] }>(`/collection/${id}`);
  }

  searchCompanies(query: string) {
    return this.get<Paged<{ id: number; name: string }>>('/search/company', { query }, 7 * 24 * 60 * 60 * 1000);
  }

  searchCollections(query: string) {
    return this.get<Paged<{ id: number; name: string; poster_path: string | null }>>('/search/collection', { query }, 24 * 60 * 60 * 1000);
  }

  /** A public TMDB list (v3 lists API). */
  list(id: number, page = 1) {
    return this.get<{ id: number; name: string; total_pages?: number; items: TmdbSearchResult[] }>(`/list/${id}`, { page }, 60 * 60 * 1000);
  }

  searchKind(kind: 'movie' | 'tv', query: string, year?: number | null) {
    return this.get<Paged<TmdbSearchResult>>(`/search/${kind}`, { query, include_adult: 'false', ...(year ? (kind === 'movie' ? { year } : { first_air_date_year: year }) : {}) }, 24 * 60 * 60 * 1000);
  }

  images(kind: 'movie' | 'tv', id: number) {
    return this.get<{ posters: { file_path: string; width: number; height: number; iso_639_1: string | null; vote_average: number; vote_count: number }[] }>(
      `/${kind}/${id}/images`,
      { include_image_language: 'en,null' },
      24 * 60 * 60 * 1000,
    );
  }

  videos(kind: 'movie' | 'tv', id: number) {
    return this.get<{ results: TmdbVideo[] }>(`/${kind}/${id}/videos`, { include_video_language: 'en,null' }, 24 * 60 * 60 * 1000);
  }

  findByExternal(id: string, source: 'imdb_id' | 'tvdb_id') {
    return this.get<{ movie_results: TmdbSearchResult[]; tv_results: TmdbSearchResult[] }>(`/find/${id}`, { external_source: source }, 7 * 24 * 60 * 60 * 1000);
  }
}

export function purgeHttpCache(db: Orm) {
  db.delete(httpCache).where(lt(httpCache.expiresAt, Date.now())).run();
}

/** Picks the best YouTube trailer: official trailers first, then teasers, larger first. */
export function pickTrailer(videos: TmdbVideo[] | undefined): string | null {
  const yt = (videos ?? []).filter((v) => v.site === 'YouTube' && /^[\w-]{6,20}$/.test(v.key));
  const score = (v: TmdbVideo) => (v.type === 'Trailer' ? 100 : v.type === 'Teaser' ? 50 : 0) + (v.official ? 20 : 0) + (v.size ?? 0) / 1000;
  return yt.sort((a, b) => score(b) - score(a))[0]?.key ?? null;
}

/** TMDB release types: 3 theatrical, 4 digital, 5 physical. Uses the region first, then the earliest anywhere. */
export function releaseDates(movie: TmdbMovie, region: string): { digital: string | null; physical: string | null } {
  const all = movie.release_dates?.results ?? [];
  const pick = (type: number) => {
    const inRegion = all.find((r) => r.iso_3166_1 === region)?.release_dates.filter((d) => d.type === type) ?? [];
    const pool = inRegion.length ? inRegion : all.flatMap((r) => r.release_dates.filter((d) => d.type === type));
    const sorted = pool.map((d) => d.release_date.slice(0, 10)).sort();
    return sorted[0] ?? null;
  };
  return { digital: pick(4), physical: pick(5) };
}

export const tmdbKind = (k: MediaKind) => (k === 'movie' ? 'movie' : 'tv');
