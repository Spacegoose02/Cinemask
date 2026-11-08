import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApp, setupOwner, type Client } from './helpers.js';
import { fakeFetch, tmdbRoutes } from './fakes.js';

/** Bluey with a season of specials, as TMDB lists them. */
const withSpecials = {
  ...tmdbRoutes,
  'https://api.themoviedb.org/3/tv/82728': (url: URL) => ({
    ...(tmdbRoutes['https://api.themoviedb.org/3/tv/82728'] as (u: URL) => Record<string, unknown>)(url),
    seasons: [
      { season_number: 0, name: 'Specials', episode_count: 2, air_date: '2019-01-01', poster_path: null },
      { season_number: 1, name: 'Season 1', episode_count: 3, air_date: '2018-10-01', poster_path: null },
    ],
  }),
  'https://api.themoviedb.org/3/tv/82728/season/0': () => ({
    season_number: 0,
    episodes: [1, 2].map((n) => ({ episode_number: n, name: `Special ${n}`, air_date: '2019-01-01', overview: '', still_path: null, runtime: 30, episode_type: 'standard' })),
  }),
};

type Episode = { season: number; episode: number; monitored: boolean; absoluteNumber: number | null };

describe('specials (season 0)', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let owner: Client;
  beforeEach(async () => {
    t = await makeApp();
    owner = await setupOwner(t.app);
    fakeFetch(withSpecials);
    await owner.req('PUT', '/api/settings/metadata', { tmdbApiKey: 'k' });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  it('adds specials unmonitored, out of the absolute order, and monitors them when season 0 is picked', async () => {
    const res = await owner.req('POST', '/api/monitored', { kind: 'show', tmdbId: 82728, search: false });
    expect(res.statusCode).toBe(200);
    const row = res.json() as { id: number; wanted: number; episodes: Episode[] };
    const specials = row.episodes.filter((e) => e.season === 0);
    expect(specials).toHaveLength(2);
    expect(specials.every((e) => !e.monitored && e.absoluteNumber === null)).toBe(true);
    expect(row.episodes.filter((e) => e.season === 1).map((e) => e.absoluteNumber)).toEqual([1, 2, 3]);
    // Only the three regular episodes are wanted.
    expect(row.wanted).toBe(3);

    const picked = (await owner.req('PATCH', `/api/monitored/${row.id}`, { seasons: [0, 1] })).json() as { wanted: number; episodes: Episode[] };
    expect(picked.episodes.filter((e) => e.season === 0).every((e) => e.monitored)).toBe(true);
    expect(picked.wanted).toBe(5);

    const all = (await owner.req('PATCH', `/api/monitored/${row.id}`, { seasons: null })).json() as { wanted: number; episodes: Episode[] };
    expect(all.episodes.filter((e) => e.season === 0).some((e) => e.monitored)).toBe(false);
  });
});
