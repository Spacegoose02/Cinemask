import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ageOf, certificationOf } from '../src/server/kids/ratings.js';
import { syncWatchlist } from '../src/server/watchlist/service.js';
import { sealSecret } from '../src/server/arr/secrets.js';
import { requests, users, watchlistItems } from '../src/server/db/schema.js';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { fakeFetch, JELLYFIN, tmdbRoutes } from './fakes.js';

const TMDB = 'https://api.themoviedb.org/3';
const paddington = tmdbRoutes[`${TMDB}/movie/116149`]!;
const rated = (cert: string) => () => {
  const m = paddington(new URL(`${TMDB}/movie/116149`)) as Record<string, unknown>;
  return { ...m, release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ type: 3, release_date: '2015-01-16T00:00:00Z', certification: cert }] }] } };
};
const scary = () => ({ ...rated('R')(), id: 777, title: 'Not Here', release_date: '2001-01-01' });

describe('age ratings', () => {
  it('reads the age of named and numbered ratings', () => {
    expect([ageOf('G'), ageOf('PG'), ageOf('PG-13'), ageOf('R'), ageOf('TV-Y7'), ageOf('TV-MA'), ageOf('12A'), ageOf('FSK 16'), ageOf('15'), ageOf('NR'), ageOf('')]).toEqual([0, 8, 13, 17, 7, 17, 12, 16, 15, null, null]);
  });

  it('prefers the metadata region, then the US', () => {
    const movie = {
      release_dates: {
        results: [
          { iso_3166_1: 'DE', release_dates: [{ type: 3, release_date: '', certification: '6' }] },
          { iso_3166_1: 'US', release_dates: [{ type: 3, release_date: '', certification: '' }, { type: 4, release_date: '', certification: 'PG' }] },
        ],
      },
    };
    expect(certificationOf('movie', movie as never, 'DE')).toBe('6');
    expect(certificationOf('movie', movie as never, 'GB')).toBe('PG');
    expect(certificationOf('show', { content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-Y' }] } } as never, 'US')).toBe('TV-Y');
    expect(certificationOf('show', {} as never, 'US')).toBe('');
  });
});

describe('kids profiles and watchlists', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let owner: Client;
  let kid: Client;
  let kidId: number;
  let favourites: { Name: string; Type: string; ProviderIds?: Record<string, string> }[] = [];
  let plexList: unknown[] = [];

  beforeEach(async () => {
    t = await makeApp();
    owner = await setupOwner(t.app);
    favourites = [];
    plexList = [];
    fakeFetch({
      ...tmdbRoutes,
      [`${TMDB}/movie/116149`]: rated('PG'),
      [`${TMDB}/movie/777`]: scary,
      [`${JELLYFIN}/Users`]: () => [{ Id: 'jf-kid', Name: 'Kid' }],
      [`${JELLYFIN}/Users/jf-kid/Items`]: () => ({ Items: favourites }),
      'https://discover.provider.plex.tv/library/sections/watchlist/all': () => ({ MediaContainer: { totalSize: plexList.length, Metadata: plexList } }),
      'https://discover.provider.plex.tv/library/metadata/': () => ({ MediaContainer: { Metadata: [{ Guid: [{ id: 'imdb://tt1' }, { id: 'tmdb://777' }] }] } }),
    });
    await owner.req('PUT', '/api/settings/metadata', { tmdbApiKey: 'k' });
    const u = await createUser(owner, 'kid', 'user');
    kidId = u.id;
    kid = new Client(t.app);
    await kid.login('kid', u.password);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  it('hides and refuses titles above a kids profile’s age', async () => {
    expect((await owner.req('PATCH', `/api/users/${kidId}`, { maxAge: 9 })).statusCode).toBe(200);
    expect((await owner.req('GET', '/api/users')).json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: kidId, maxAge: 9 })]));
    const search = (await kid.req('GET', '/api/search?q=pad')).json() as { results: { tmdbId: number }[] };
    // PG is fine; R and unrated (Future Film) are not.
    expect(search.results.map((r) => r.tmdbId)).toEqual([116149]);
    expect((await kid.req('GET', '/api/media/movie/116149')).statusCode).toBe(200);
    expect((await kid.req('GET', '/api/media/movie/777')).statusCode).toBe(403);
    expect((await kid.req('POST', '/api/requests', { kind: 'movie', tmdbId: 777 })).statusCode).toBe(403);
    expect((await kid.req('POST', '/api/requests', { kind: 'movie', tmdbId: 116149 })).statusCode).toBe(200);
    // Everyone else sees everything.
    expect(((await owner.req('GET', '/api/search?q=pad')).json() as { results: unknown[] }).results).toHaveLength(3);
  });

  it('only admins set ages and Jellyfin accounts, and a user can’t lift their own limit', async () => {
    const mgr = await createUser(owner, 'mgr', 'manager');
    const m = new Client(t.app);
    await m.login('mgr', mgr.password);
    expect((await m.req('PATCH', `/api/users/${kidId}`, { maxAge: null })).statusCode).toBe(403);
    expect((await kid.req('PATCH', `/api/users/${kidId}`, { maxAge: null })).statusCode).toBe(403);
    expect((await kid.req('GET', '/api/watchlist/jellyfin-users')).statusCode).toBe(403);
    expect((await m.req('GET', '/api/watchlist/jellyfin-users')).statusCode).toBe(403);
  });

  it('turns Jellyfin favourites into requests once each, under the usual rules', async () => {
    expect((await kid.req('PUT', '/api/watchlist/me', { sync: true })).statusCode).toBe(400);
    await owner.req('PUT', '/api/settings/jellyfin', { enabled: true, url: JELLYFIN, apiKey: 'jf' });
    expect(((await owner.req('GET', '/api/watchlist/jellyfin-users')).json() as { users: unknown[] }).users).toEqual([{ id: 'jf-kid', name: 'Kid' }]);
    await owner.req('PATCH', `/api/users/${kidId}`, { jellyfinUserId: 'jf-kid', maxAge: 9 });
    favourites = [
      { Name: 'Paddington', Type: 'Movie', ProviderIds: { Tmdb: '116149' } },
      { Name: 'Not Here', Type: 'Movie', ProviderIds: { Tmdb: '777' } },
      { Name: 'No ids', Type: 'Movie' },
    ];
    const on = (await kid.req('PUT', '/api/watchlist/me', { sync: true })).json() as { sync: boolean; sources: { jellyfin: boolean } };
    expect(on).toMatchObject({ sync: true, sources: { jellyfin: true, plex: false } });
    const r = await syncWatchlist(t.app.ctx, kidId);
    expect(r.error).toBeNull();
    const reqs = t.app.ctx.db.select().from(requests).all();
    expect(reqs.map((x) => [x.tmdbId, x.requestedBy, x.status])).toEqual([[116149, kidId, 'pending']]);
    const items = t.app.ctx.db.select().from(watchlistItems).all();
    expect(items.find((i) => i.tmdbId === 777)?.result).toMatch(/isn't available on your profile/);
    // Nothing is asked twice.
    expect((await syncWatchlist(t.app.ctx, kidId)).requested).toBe(0);
    expect(t.app.ctx.db.select().from(requests).all()).toHaveLength(1);
    const view = (await kid.req('GET', '/api/watchlist/me')).json() as { items: unknown[]; syncedAt: number };
    expect(view.items).toHaveLength(2);
    expect(view.syncedAt).toBeGreaterThan(0);
  });

  it('reads the Plex watchlist with the user’s own token, looking up missing ids', async () => {
    t.app.ctx.db.update(users).set({ plexToken: sealSecret(t.app.ctx, 'kid-token'), watchlistSync: true }).where(eq(users.id, kidId)).run();
    plexList = [
      { ratingKey: 'a', type: 'movie', title: 'Paddington', Guid: [{ id: 'tmdb://116149' }] },
      { ratingKey: 'b', type: 'movie', title: 'Not Here' },
    ];
    await owner.req('PUT', '/api/settings/requests', { movieLimit: 1 });
    const r = await syncWatchlist(t.app.ctx, kidId);
    expect(r).toMatchObject({ checked: 2, requested: 1, error: null });
    // Over the limit: not recorded, so it's tried again next time.
    expect(t.app.ctx.db.select().from(watchlistItems).all().map((i) => i.tmdbId)).toEqual([116149]);
    expect(t.app.ctx.db.select().from(requests).all()[0]!.requestedBy).toBe(kidId);
  });

  it('only shows and changes the signed-in user’s own watchlist', async () => {
    t.app.ctx.db.update(users).set({ plexToken: sealSecret(t.app.ctx, 'owner-token') }).where(eq(users.username, 'owner')).run();
    // The kid has no Plex account of their own, so the owner's doesn't count for them.
    expect((await kid.req('PUT', '/api/watchlist/me', { sync: true })).statusCode).toBe(400);
    expect(((await owner.req('PUT', '/api/watchlist/me', { sync: true })).json() as { sync: boolean }).sync).toBe(true);
    expect(((await kid.req('GET', '/api/watchlist/me')).json() as { sync: boolean }).sync).toBe(false);
  });
});
