import { z } from 'zod';
import type { AppContext } from '../context.js';
import { cards, tmdbClient, type Card } from '../library/service.js';

/** TV networks people filter by. TMDB has no endpoint listing networks, so the common ones are listed here. */
export const NETWORKS = [
  { id: 213, name: 'Netflix' },
  { id: 49, name: 'HBO' },
  { id: 3186, name: 'Max' },
  { id: 2739, name: 'Disney+' },
  { id: 2552, name: 'Apple TV+' },
  { id: 1024, name: 'Prime Video' },
  { id: 453, name: 'Hulu' },
  { id: 4330, name: 'Paramount+' },
  { id: 3353, name: 'Peacock' },
  { id: 2, name: 'ABC' },
  { id: 6, name: 'NBC' },
  { id: 16, name: 'CBS' },
  { id: 19, name: 'FOX' },
  { id: 71, name: 'The CW' },
  { id: 174, name: 'AMC' },
  { id: 88, name: 'FX' },
  { id: 67, name: 'Showtime' },
  { id: 318, name: 'Starz' },
  { id: 64, name: 'Discovery' },
  { id: 43, name: 'National Geographic' },
  { id: 65, name: 'History' },
  { id: 14, name: 'PBS' },
  { id: 4, name: 'BBC One' },
  { id: 332, name: 'BBC Two' },
  { id: 26, name: 'Channel 4' },
  { id: 9, name: 'ITV' },
  { id: 56, name: 'Cartoon Network' },
  { id: 13, name: 'Nickelodeon' },
  { id: 54, name: 'Disney Channel' },
  { id: 1, name: 'Fuji TV' },
  { id: 98, name: 'TV Tokyo' },
];

export const SORTS = {
  popular: { movie: 'popularity.desc', tv: 'popularity.desc' },
  rating: { movie: 'vote_average.desc', tv: 'vote_average.desc' },
  newest: { movie: 'primary_release_date.desc', tv: 'first_air_date.desc' },
  oldest: { movie: 'primary_release_date.asc', tv: 'first_air_date.asc' },
  title: { movie: 'title.asc', tv: 'name.asc' },
} as const;

const ids = z
  .union([z.string(), z.array(z.coerce.number().int().positive())])
  .transform((v) => (typeof v === 'string' ? v.split(',').filter(Boolean).map(Number) : v))
  .pipe(z.array(z.number().int().positive()).max(30))
  .optional();

export const discoverFilter = z.object({
  kind: z.enum(['movie', 'tv']).default('movie'),
  genres: ids,
  networks: ids,
  providers: ids,
  yearFrom: z.coerce.number().int().min(1870).max(2200).optional(),
  yearTo: z.coerce.number().int().min(1870).max(2200).optional(),
  ratingMin: z.coerce.number().min(0).max(10).optional(),
  votesMin: z.coerce.number().int().min(0).max(100000).optional(),
  language: z
    .string()
    .regex(/^[a-z]{2}$/)
    .optional(),
  sort: z.enum(Object.keys(SORTS) as [keyof typeof SORTS, ...(keyof typeof SORTS)[]]).default('popular'),
});
export type DiscoverFilter = z.infer<typeof discoverFilter>;

/** Translates our filter into TMDB /discover parameters. Genres and networks are OR-ed ("|"). */
export function discoverParams(ctx: AppContext, f: DiscoverFilter): Record<string, string | number | undefined> {
  const movie = f.kind === 'movie';
  const date = movie ? 'primary_release_date' : 'first_air_date';
  const region = ctx.settings.get('metadata').region;
  return {
    sort_by: SORTS[f.sort][f.kind],
    with_genres: f.genres?.join('|'),
    with_networks: movie ? undefined : f.networks?.join('|'),
    with_watch_providers: f.providers?.join('|'),
    watch_region: f.providers?.length ? region : undefined,
    [`${date}.gte`]: f.yearFrom ? `${f.yearFrom}-01-01` : undefined,
    [`${date}.lte`]: f.yearTo ? `${f.yearTo}-12-31` : undefined,
    'vote_average.gte': f.ratingMin,
    // Sorting by rating without a vote floor surfaces titles with one 10/10 vote.
    'vote_count.gte': f.votesMin ?? (f.sort === 'rating' ? 200 : undefined),
    with_original_language: f.language,
    include_adult: 'false',
  };
}

export async function discover(ctx: AppContext, f: DiscoverFilter, page = 1): Promise<{ results: Card[]; totalPages: number; totalResults: number }> {
  const tmdb = tmdbClient(ctx);
  if (!tmdb.configured) return { results: [], totalPages: 0, totalResults: 0 };
  const r = await tmdb.discover(f.kind, { ...discoverParams(ctx, f), page });
  return { results: cards(ctx, r.results, f.kind === 'movie' ? 'movie' : 'show'), totalPages: Math.min(r.total_pages, 500), totalResults: r.total_results };
}
