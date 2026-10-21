import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureMedia } from '../src/server/library/service.js';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { fakeFetch, JELLYFIN, jellyfinRoutes, PLEX, plexRoutes, tmdbRoutes } from './fakes.js';

let t: Awaited<ReturnType<typeof makeApp>>;
let owner: Client;
beforeEach(async () => {
  t = await makeApp();
  owner = await setupOwner(t.app);
  await owner.req('PUT', '/api/settings/plex', { enabled: true, url: PLEX, token: 'plex-token' });
  await owner.req('PUT', '/api/settings/metadata', { tmdbApiKey: 'tmdb-key' });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await t.close();
});

describe('Plex connection', () => {
  it('tests the connection and fills in the server id for Plex sign-in', async () => {
    const { calls } = fakeFetch(plexRoutes);
    const res = await owner.req('POST', '/api/integrations/plex/test');
    expect(res.json()).toEqual({ ok: true, message: 'Connected to Home Plex (Plex 1.41.0)' });
    expect(t.app.ctx.settings.get('auth').plex.serverMachineId).toBe('abc123');
    expect(calls[0]).not.toContain('plex-token'); // token goes in a header, not the URL
  });

  it('reports a rejected token without leaking it', async () => {
    fakeFetch({ [`${PLEX}/`]: () => new Response('', { status: 401 }) });
    const res = await owner.req('POST', '/api/integrations/plex/test');
    expect(res.json()).toEqual({ ok: false, message: 'Plex: the API key or token was rejected' });
  });
});

describe('library sync', () => {
  beforeEach(async () => {
    fakeFetch({ ...plexRoutes, ...tmdbRoutes });
    await t.librarySync.run();
  });

  it('imports movies, shows and episodes with quality', async () => {
    expect(t.librarySync.status.results.plex).toEqual({ ok: true, movies: 2, shows: 1, episodes: 2 });
    const lib = (await owner.req('GET', '/api/library?sort=title')).json();
    expect(lib.total).toBe(3);
    expect(lib.items.map((i: { title: string }) => i.title)).toEqual(['Bluey', 'Old Agent Movie', 'Paddington']);
    expect(lib.items.find((i: { title: string }) => i.title === 'Bluey').resolution).toBe('2160p');
  });

  it('looks up TMDB ids for items only matched by IMDb', async () => {
    const lib = (await owner.req('GET', '/api/library?q=old')).json();
    expect(lib.items[0].tmdbId).toBe(999);
  });

  it('treats % and _ in searches literally', async () => {
    expect((await owner.req('GET', '/api/library?q=%25')).json().total).toBe(0);
  });

  it('filters by resolution and kind', async () => {
    expect((await owner.req('GET', '/api/library?resolution=1080p')).json().total).toBe(1);
    expect((await owner.req('GET', '/api/library?kind=show')).json().total).toBe(1);
  });

  it('lists the Plex libraries and filters by one', async () => {
    const u = await createUser(owner, 'viewer', 'user');
    const user = new Client(t.app);
    await user.login('viewer', u.password);
    expect((await user.req('GET', '/api/library/sections')).json().libraries).toEqual([
      { name: 'Movies', kind: 'movie', count: 2 },
      { name: 'TV Shows', kind: 'show', count: 1 },
    ]);
    const movies = (await user.req('GET', '/api/library?library=Movies&sort=title')).json();
    expect(movies.items.map((i: { title: string }) => i.title)).toEqual(['Old Agent Movie', 'Paddington']);
    expect((await user.req('GET', '/api/library?library=Kids%20Movies')).json().total).toBe(0);
  });

  it('monitors what it finds without searching for anything already out', async () => {
    const rows = t.app.ctx.dbHandle.sqlite.prepare('SELECT id, kind, title, monitored FROM monitored ORDER BY title').all() as { id: number; kind: string; title: string; monitored: number }[];
    expect(rows.map((r) => [r.title, r.monitored])).toContainEqual(['Paddington', 0]);
    const bluey = rows.find((r) => r.title === 'Bluey')!;
    expect(bluey.monitored).toBe(1);
    // Episodes that already aired stay as they are; only future ones would be fetched.
    const aired = t.app.ctx.dbHandle.sqlite.prepare("SELECT COUNT(*) AS n FROM monitored_episodes WHERE monitored_id = ? AND monitored = 1 AND air_date <= date('now')").get(bluey.id) as { n: number };
    expect(aired.n).toBe(0);
    expect(t.librarySync.status.autoMonitored).toBe(rows.length);

    // Removed by hand: the next sync leaves it alone.
    await owner.req('DELETE', `/api/monitored/${bluey.id}`);
    await t.librarySync.run();
    expect(t.app.ctx.dbHandle.sqlite.prepare("SELECT COUNT(*) AS n FROM monitored WHERE title = 'Bluey'").get()).toEqual({ n: 0 });
  });

  it('can be told not to monitor what it finds', async () => {
    t.app.ctx.dbHandle.sqlite.prepare('DELETE FROM monitored').run();
    await owner.req('PUT', '/api/settings/library', { autoMonitor: 'off' });
    await t.librarySync.run();
    expect(t.app.ctx.dbHandle.sqlite.prepare('SELECT COUNT(*) AS n FROM monitored').get()).toEqual({ n: 0 });
  });

  it('reads play counts and filters by watched', async () => {
    const watched = (await owner.req('GET', '/api/library?watched=watched')).json();
    // A show counts as watched once every episode has been played.
    expect(watched.items.map((i: { title: string }) => i.title)).toEqual(['Paddington']);
    expect(watched.items.find((i: { title: string }) => i.title === 'Paddington')).toMatchObject({ viewCount: 3, lastViewedAt: 1720000000000 });
    expect((await owner.req('GET', '/api/library?watched=unwatched')).json().total).toBe(2);
    const m = (await owner.req('GET', '/api/media/movie/116149')).json();
    expect(m.watch).toEqual({ viewCount: 3, lastViewedAt: 1720000000000 });
    const season = (await owner.req('GET', '/api/media/show/82728/season/1')).json();
    expect(season.episodes.map((e: { viewCount: number | null }) => e.viewCount)).toEqual([1, 0, null]);
  });

  it('keeps a match fixed by hand through the next sync', async () => {
    const lib = (await owner.req('GET', '/api/library?q=old')).json();
    const u = await createUser(owner, 'kid', 'user');
    const c = new Client(t.app);
    await c.login('kid', u.password);
    expect((await c.req('POST', '/api/library/match', { itemIds: lib.items[0].itemIds, tmdbId: 555 })).statusCode).toBe(403);
    const res = await owner.req('POST', '/api/library/match', { itemIds: lib.items[0].itemIds, tmdbId: 555 });
    expect(res.json()).toMatchObject({ kind: 'movie', tmdbId: 555, title: 'Future Film' });
    await t.librarySync.run();
    const after = (await owner.req('GET', '/api/library?q=old')).json();
    expect(after.items[0].tmdbId).toBe(555);
  });

  it('re-points a monitored title at a different TMDB entry', async () => {
    const row = t.app.ctx.dbHandle.sqlite.prepare("SELECT id FROM monitored WHERE title = 'Paddington'").get() as { id: number };
    const res = await owner.req('POST', `/api/monitored/${row.id}/match`, { tmdbId: 555 });
    expect(res.json()).toMatchObject({ tmdbId: 555, title: 'Future Film' });
    // Two monitored rows can't point at the same title.
    t.app.ctx.dbHandle.sqlite.prepare("UPDATE monitored SET tmdb_id = 116149 WHERE id = ?").run(row.id);
    const other = (await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 555 })).json();
    expect((await owner.req('POST', `/api/monitored/${other.id}/match`, { tmdbId: 116149 })).statusCode).toBe(409);
  });

  it('a second sync replaces, not duplicates, the server contents', async () => {
    await t.librarySync.run();
    expect((await owner.req('GET', '/api/library')).json().total).toBe(3);
  });
});

describe('statuses and details', () => {
  beforeEach(async () => {
    fakeFetch({ ...plexRoutes, ...tmdbRoutes });
    await t.librarySync.run();
  });

  it('marks search results on server, not on server, or not available', async () => {
    const res = (await owner.req('GET', '/api/search?q=paddington')).json();
    const status = Object.fromEntries(res.results.map((r: { title: string; availability: { status: string } }) => [r.title, r.availability.status]));
    expect(status).toEqual({ Paddington: 'on_server', 'Future Film': 'not_available', 'Not Here': 'not_on_server' });
    expect(res.library[0].title).toBe('Paddington');
  });

  it('returns movie details with trailer, release dates and collection', async () => {
    const m = (await owner.req('GET', '/api/media/movie/116149')).json();
    expect(m).toMatchObject({
      title: 'Paddington',
      trailerKey: 'trailer1234',
      digitalRelease: '2015-04-28',
      availability: { status: 'on_server', resolution: '1080p', servers: ['plex'] },
      collection: { id: 1, name: 'Paddington Collection' },
      genres: ['Family'],
    });
  });

  it('marks a show partial when aired episodes are missing, with per-episode status', async () => {
    const s = (await owner.req('GET', '/api/media/show/82728')).json();
    expect(s.availability.status).toBe('partial');
    expect(s.seasons[0]).toMatchObject({ seasonNumber: 1, episodeCount: 3, onServer: 2 });
    const season = (await owner.req('GET', '/api/media/show/82728/season/1')).json();
    expect(season.episodes.map((e: { onServer: boolean }) => e.onServer)).toEqual([true, true, false]);
  });

  it('lets regular users browse but not trigger a sync', async () => {
    const u = await createUser(owner, 'kid', 'user');
    const c = new Client(t.app);
    await c.login('kid', u.password);
    expect((await c.req('GET', '/api/library')).statusCode).toBe(200);
    expect((await c.req('POST', '/api/library/sync')).statusCode).toBe(403);
  });
});

describe('Plex and Jellyfin together', () => {
  it('merges the same title from both servers and combines episodes', async () => {
    await owner.req('PUT', '/api/settings/jellyfin', { enabled: true, url: JELLYFIN, apiKey: 'jf-key' });
    const { fn } = fakeFetch({ ...plexRoutes, ...jellyfinRoutes, ...tmdbRoutes });
    await t.librarySync.run();
    expect(t.librarySync.status.results.jellyfin).toEqual({ ok: true, movies: 1, shows: 1, episodes: 1 });
    const lib = (await owner.req('GET', '/api/library?q=paddington')).json();
    expect(lib.total).toBe(1);
    expect(lib.items[0]).toMatchObject({ resolution: '2160p', servers: expect.arrayContaining(['plex', 'jellyfin']) });
    const show = (await owner.req('GET', '/api/media/show/82728')).json();
    expect(show.availability.status).toBe('on_server');
    const jfCall = fn.mock.calls.find(([u]) => String(u).startsWith(JELLYFIN));
    expect(String(jfCall![0])).not.toContain('jf-key');
  });
});

describe('library posters', () => {
  it('fills details for every title in one run, and one failing title holds up nothing', async () => {
    for (let id = 1000; id < 1260; id++) ensureMedia(t.app.ctx, 'movie', id, { title: `Movie ${id}` });
    fakeFetch({
      'https://api.themoviedb.org/3/movie/': (url) => {
        const id = Number(url.pathname.split('/').pop());
        if (id === 1000) return new Response('busy', { status: 500 });
        return { id, title: `Movie ${id}`, overview: '', release_date: '2020-01-01', runtime: 90, status: 'Released', poster_path: `/${id}.jpg`, backdrop_path: null, vote_average: 6, genres: [], imdb_id: null };
      },
    });
    expect(await t.librarySync.backfillMetadata()).toBe(259);
    const lib = t.app.ctx.dbHandle.sqlite.prepare('select tmdb_id, poster_path from media where poster_path is null').all();
    expect(lib).toEqual([{ tmdb_id: 1000, poster_path: null }]);
  });
});
