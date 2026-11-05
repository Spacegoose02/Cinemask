import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { fakeFetch, tmdbRoutes } from './fakes.js';

const R = '/api/compat/radarr/api/v3';
const S = '/api/compat/sonarr/api/v3';

describe('Radarr- and Sonarr-compatible API', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let owner: Client;
  let key: string;
  let userKey: string;
  const call = (k: string, method: string, url: string, body?: unknown) => t.app.inject({ method: method as 'GET', url, payload: body as never, headers: { 'x-api-key': k } });

  beforeEach(async () => {
    t = await makeApp();
    owner = await setupOwner(t.app);
    fakeFetch({ ...tmdbRoutes, 'https://api.themoviedb.org/3/find/353546': () => ({ movie_results: [], tv_results: [{ id: 82728, name: 'Bluey' }] }) });
    await owner.req('PUT', '/api/settings/metadata', { tmdbApiKey: 'k' });
    await owner.req('PUT', '/api/settings/media', { moviesPath: path.join(t.dir, 'm'), tvPath: path.join(t.dir, 'tv') });
    key = (await owner.req('POST', '/api/auth/api-keys', { name: 'Overseerr', access: 'full' })).json().key;
    const u = await createUser(owner, 'kid', 'user');
    const kid = new Client(t.app);
    await kid.login('kid', u.password);
    userKey = (await kid.req('POST', '/api/auth/api-keys', { name: 'mine', access: 'full' })).json().key;
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  it('answers Radarr calls the way Overseerr makes them', async () => {
    expect((await call(key, 'GET', `${R}/system/status`)).json()).toMatchObject({ appName: 'Radarr', version: expect.any(String) });
    const profiles = (await call(key, 'GET', `${R}/qualityprofile`)).json() as { id: number; name: string }[];
    expect(profiles.length).toBeGreaterThan(0);
    expect((await call(key, 'GET', `${R}/rootfolder`)).json()).toEqual([expect.objectContaining({ path: path.join(t.dir, 'm') })]);
    const [found] = (await call(key, 'GET', `${R}/movie/lookup?term=tmdb:116149`)).json() as { id?: number; title: string }[];
    expect(found).toMatchObject({ title: 'Paddington', tmdbId: 116149, hasFile: false });
    expect(found!.id).toBeUndefined();
    const added = await call(key, 'POST', `${R}/movie`, { tmdbId: 116149, title: 'Paddington', qualityProfileId: profiles[0]!.id, rootFolderPath: path.join(t.dir, 'm'), monitored: true, addOptions: { searchForMovie: false } });
    expect(added.statusCode).toBe(200);
    const movie = added.json() as { id: number; monitored: boolean; qualityProfileId: number };
    expect(movie).toMatchObject({ monitored: true, qualityProfileId: profiles[0]!.id });
    expect(((await call(key, 'GET', `${R}/movie/lookup?term=tmdb:116149`)).json() as { id: number }[])[0]!.id).toBe(movie.id);
    expect((await call(key, 'POST', `${R}/movie`, { tmdbId: 116149 })).statusCode).toBe(400);
    expect((await call(key, 'PUT', `${R}/movie`, { id: movie.id, monitored: false })).json()).toMatchObject({ monitored: false });
    expect((await call(key, 'GET', `${R}/movie?tmdbId=116149`)).json()).toHaveLength(1);
    expect((await call(key, 'GET', `${R}/queue`)).json()).toMatchObject({ totalRecords: 0, records: [] });
    expect((await call(key, 'POST', `${R}/command`, { name: 'MoviesSearch', movieIds: [movie.id] })).json()).toMatchObject({ name: 'MoviesSearch', status: 'queued' });
    expect((await call(key, 'POST', `${R}/command`, { name: 'Backup' })).statusCode).toBe(400);
    expect((await call(key, 'DELETE', `${R}/movie/${movie.id}?deleteFiles=false`)).statusCode).toBe(200);
    expect((await call(key, 'GET', `${R}/movie`)).json()).toEqual([]);
  });

  it('answers Sonarr calls, adding a show by TVDB id with its seasons', async () => {
    const [found] = (await call(key, 'GET', `${S}/series/lookup?term=tvdb:353546`)).json() as { title: string; seasons: { seasonNumber: number }[] }[];
    expect(found).toMatchObject({ title: 'Bluey', tvdbId: 353546, seasons: [{ seasonNumber: 1 }] });
    const added = await call(key, 'POST', `${S}/series`, { tvdbId: 353546, qualityProfileId: 1, languageProfileId: 1, seasons: [{ seasonNumber: 1, monitored: true }], monitored: true, seriesType: 'standard', addOptions: { searchForMissingEpisodes: false } });
    expect(added.statusCode).toBe(200);
    const series = added.json() as { id: number; seasons: { seasonNumber: number; monitored: boolean; statistics: { totalEpisodeCount: number } }[] };
    expect(series.seasons).toEqual([expect.objectContaining({ seasonNumber: 1, monitored: true, statistics: expect.objectContaining({ totalEpisodeCount: 3 }) })]);
    expect((await call(key, 'GET', `${S}/series?tvdbId=353546`)).json()).toHaveLength(1);
    const eps = (await call(key, 'GET', `${S}/episode?seriesId=${series.id}`)).json() as { id: number; episodeNumber: number; absoluteEpisodeNumber: number }[];
    expect(eps.map((e) => [e.episodeNumber, e.absoluteEpisodeNumber])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    expect((await call(key, 'POST', `${S}/command`, { name: 'EpisodeSearch', episodeIds: [eps[0]!.id] })).statusCode).toBe(200);
    expect((await call(key, 'GET', `${S}/calendar?start=2018-09-30&end=2018-10-02`)).json()).toHaveLength(3);
    expect((await call(key, 'PUT', `${S}/series/${series.id}`, { seriesType: 'anime' })).json()).toMatchObject({ seriesType: 'anime' });
  });

  it('needs a manager’s API key, and a read-only key can’t change anything', async () => {
    expect((await t.app.inject({ method: 'GET', url: `${R}/movie` })).statusCode).toBe(401);
    expect((await call(userKey, 'GET', `${R}/movie`)).statusCode).toBe(403);
    expect((await call(userKey, 'POST', `${S}/series`, { tvdbId: 353546 })).statusCode).toBe(403);
    const ro = (await owner.req('POST', '/api/auth/api-keys', { name: 'LunaSea', access: 'read' })).json().key;
    expect((await call(ro, 'GET', `${R}/movie`)).statusCode).toBe(200);
    expect((await call(ro, 'POST', `${R}/movie`, { tmdbId: 116149 })).statusCode).toBe(403);
  });
});
