import { z } from 'zod';
import type { AppContext } from '../context.js';
import { cards, tmdbClient, type Card } from '../library/service.js';

/**
 * Channels and networks people filter by. TMDB has no endpoint listing networks, so the common ones
 * are listed here. `also` are sibling network ids shown under the same chip (Lifetime Movies, Hallmark+).
 * Movies have no network on TMDB, so on the Movies tab a chip matches the production companies named in
 * `companies`, looked up by exact name. `provider` matches the streaming service whose originals it makes.
 */
export interface Network {
  id: number;
  name: string;
  also?: number[];
  companies?: string[];
  provider?: RegExp;
}

export const NETWORKS: Network[] = [
  { id: 213, name: 'Netflix', companies: ['Netflix'], provider: /^netflix/ },
  { id: 49, name: 'HBO', companies: ['HBO Films', 'HBO'], provider: /^(hbo )?max\b|^hbo/ },
  { id: 3186, name: 'Max', companies: ['Max', 'HBO Max'], provider: /^(hbo )?max\b/ },
  { id: 2739, name: 'Disney+', companies: ['Disney+'], provider: /^disney (plus|\+)/ },
  { id: 2552, name: 'Apple TV+', companies: ['Apple Studios', 'Apple Original Films'], provider: /^apple tv( plus|\+)?$/ },
  { id: 1024, name: 'Prime Video', companies: ['Amazon MGM Studios', 'Amazon Studios'], provider: /^(amazon )?prime video/ },
  { id: 453, name: 'Hulu', companies: ['Hulu'], provider: /^hulu/ },
  { id: 4330, name: 'Paramount+', companies: ['Paramount+'], provider: /^paramount (plus|\+)/ },
  { id: 3353, name: 'Peacock', companies: ['Peacock'], provider: /^peacock/ },
  { id: 5187, name: 'Tubi', companies: ['Tubi'], provider: /^tubi/ },
  { id: 4692, name: 'The Roku Channel', companies: ['The Roku Channel', 'Roku'], provider: /roku channel/ },
  { id: 3245, name: 'Pluto TV', companies: ['Pluto TV'], provider: /^pluto/ },
  { id: 5865, name: 'Amazon Freevee', companies: ['Amazon Freevee', 'IMDb TV'], provider: /freevee/ },
  { id: 6219, name: 'MGM+', companies: ['MGM+', 'Epix'], provider: /^mgm( plus|\+)/ },
  { id: 3343, name: 'BET+', companies: ['BET+'], provider: /^bet (plus|\+)/ },
  { id: 34, name: 'Lifetime', also: [1072, 7103], companies: ['Lifetime', 'Lifetime Television', 'Lifetime Movie Network', 'Lifetime Films'], provider: /lifetime/ },
  { id: 384, name: 'Hallmark', also: [7635, 2853], companies: ['Hallmark Channel', 'Hallmark Media', 'Crown Media Productions', 'Hallmark Movies & Mysteries', 'Hallmark Entertainment', 'Hallmark Hall of Fame Productions'], provider: /^hallmark/ },
  { id: 7282, name: 'Great American Family', companies: ['Great American Media', 'Great American Family'] },
  { id: 2, name: 'ABC' },
  { id: 6, name: 'NBC' },
  { id: 16, name: 'CBS' },
  { id: 19, name: 'FOX' },
  { id: 71, name: 'The CW' },
  { id: 174, name: 'AMC', companies: ['AMC Studios'], provider: /^amc\+/ },
  { id: 88, name: 'FX', companies: ['FX Productions'] },
  { id: 30, name: 'USA Network', companies: ['USA Network'] },
  { id: 41, name: 'TNT' },
  { id: 68, name: 'TBS' },
  { id: 129, name: 'A&E' },
  { id: 77, name: 'Syfy' },
  { id: 74, name: 'Bravo' },
  { id: 1267, name: 'Freeform' },
  { id: 2076, name: 'Paramount Network' },
  { id: 47, name: 'Comedy Central' },
  { id: 80, name: 'Adult Swim' },
  { id: 84, name: 'TLC' },
  { id: 210, name: 'HGTV' },
  { id: 143, name: 'Food Network' },
  { id: 67, name: 'Showtime', companies: ['Showtime Networks'], provider: /^showtime/ },
  { id: 318, name: 'Starz', companies: ['Starz'], provider: /^starz/ },
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

/** Provider names as TMDB writes them ("Disney Plus", "Amazon Prime Video") in a form the patterns match. */
export const providerKey = (name: string) => name.toLowerCase().replace(/\s+/g, ' ').trim();

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
  /** Only titles a picked streaming service made itself, instead of everything it streams. */
  originals: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((v) => v === true || v === 'true' || v === '1')
    .optional(),
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

/** Networks (TV) or production company ids (movies) for the picked channels, and for the originals of picked services. */
async function channelIds(ctx: AppContext, f: DiscoverFilter): Promise<{ networks: number[]; companies: number[]; providers: number[] }> {
  const picked = new Set(f.networks ?? []);
  let providers = f.providers ?? [];
  if (f.originals && providers.length) {
    const tmdb = tmdbClient(ctx);
    const names = tmdb.configured ? (await tmdb.watchProviders(f.kind)).results : [];
    const chosen = names.filter((p) => providers.includes(p.provider_id)).map((p) => providerKey(p.provider_name));
    const matched = NETWORKS.filter((n) => n.provider && chosen.some((c) => n.provider!.test(c)));
    // A service with no known network keeps filtering by what it streams.
    if (matched.length) {
      matched.forEach((n) => picked.add(n.id));
      providers = [];
    }
  }
  const chips = NETWORKS.filter((n) => picked.has(n.id));
  if (f.kind === 'tv') {
    const networks = new Set(picked);
    chips.forEach((n) => n.also?.forEach((a) => networks.add(a)));
    return { networks: [...networks], companies: [], providers };
  }
  const companies = new Set<number>();
  const tmdb = tmdbClient(ctx);
  if (tmdb.configured) {
    const lookups = chips.flatMap((n) => n.companies ?? []);
    const found = await Promise.all(lookups.map((name) => tmdb.searchCompanies(name).then((r) => ({ name, r }))));
    for (const { name, r } of found) {
      for (const c of r.results) if (c.name.toLowerCase() === name.toLowerCase()) companies.add(c.id);
    }
  }
  // A channel was picked but no company matched: return nothing rather than every movie.
  if (chips.length && !companies.size) companies.add(0);
  return { networks: [], companies: [...companies], providers };
}

/** Translates our filter into TMDB /discover parameters. Genres, networks and companies are OR-ed ("|"). */
export async function discoverParams(ctx: AppContext, f: DiscoverFilter): Promise<Record<string, string | number | undefined>> {
  const movie = f.kind === 'movie';
  const ch = await channelIds(ctx, f);
  const date = movie ? 'primary_release_date' : 'first_air_date';
  const region = ctx.settings.get('metadata').region;
  return {
    sort_by: SORTS[f.sort][f.kind],
    with_genres: f.genres?.join('|'),
    with_networks: ch.networks.join('|') || undefined,
    with_companies: ch.companies.join('|') || undefined,
    with_watch_providers: ch.providers.join('|') || undefined,
    watch_region: ch.providers.length ? region : undefined,
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
  const r = await tmdb.discover(f.kind, { ...(await discoverParams(ctx, f)), page });
  return { results: cards(ctx, r.results, f.kind === 'movie' ? 'movie' : 'show'), totalPages: Math.min(r.total_pages, 500), totalResults: r.total_results };
}
