import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { fakeFetch, tmdbRoutes } from './fakes.js';

const RADARR = 'http://radarr.local:7878';
const SONARR = 'http://sonarr.local:8989';
const OVERSEERR = 'http://overseerr.local:5055';

describe('importing from Radarr, Sonarr and Overseerr', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let owner: Client;
  let media: string;
  const keys: string[] = [];

  beforeEach(async () => {
    t = await makeApp();
    owner = await setupOwner(t.app);
    media = path.join(t.dir, 'media');
    keys.length = 0;
    const seen = (init?: RequestInit) => keys.push(String((init?.headers as Record<string, string>)['X-Api-Key']));
    fakeFetch({
      ...tmdbRoutes,
      'https://api.themoviedb.org/3/find/353546': () => ({ movie_results: [], tv_results: [{ id: 82728, name: 'Bluey' }] }),
      [`${RADARR}/api/v3/system/status`]: (_u, init) => (seen(init), { version: '5.14.0' }),
      [`${RADARR}/api/v3/qualityprofile`]: () => [{ id: 4, name: 'Any' }],
      [`${RADARR}/api/v3/movie`]: (_u, init) => {
        seen(init);
        return [
          { title: 'Paddington', year: 2014, tmdbId: 116149, monitored: false, qualityProfileId: 4, path: '/movies/Paddington (2014)' },
          { title: 'No Ids', monitored: true, qualityProfileId: 4 },
        ];
      },
      [`${SONARR}/api/v3/qualityprofile`]: () => [{ id: 1, name: 'HD-1080p' }],
      // An older Sonarr: no TMDB id, so it's looked up by TVDB id.
      [`${SONARR}/api/v3/series`]: () => [{ title: 'Bluey', tvdbId: 353546, monitored: true, qualityProfileId: 1, seasons: [{ seasonNumber: 0, monitored: false }, { seasonNumber: 1, monitored: true }] }],
      [`${OVERSEERR}/api/v1/request`]: () => ({
        pageInfo: { results: 3 },
        results: [
          { id: 1, status: 1, type: 'movie', createdAt: '2024-01-02T00:00:00.000Z', media: { tmdbId: 116149, status: 2 }, requestedBy: { email: 'KID@example.com', displayName: 'Kid' } },
          { id: 2, status: 2, type: 'tv', createdAt: '2024-01-03T00:00:00.000Z', media: { tmdbId: 82728, status: 5 }, seasons: [{ seasonNumber: 1 }], requestedBy: { plexUsername: 'stranger' } },
          { id: 3, status: 1, type: 'movie', createdAt: '2024-01-04T00:00:00.000Z', media: { tmdbId: 116149, status: 2 }, requestedBy: { email: 'kid@example.com' } },
        ],
      }),
    });
    await owner.req('PUT', '/api/settings/metadata', { tmdbApiKey: 'k' });
    await owner.req('PUT', '/api/settings/media', { moviesPath: path.join(media, 'movies'), tvPath: path.join(media, 'tv') });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  const finished = async (source: string) => {
    await vi.waitFor(async () => expect((await owner.req('GET', `/api/import/${source}`)).json().running).toBe(false));
    return (await owner.req('GET', `/api/import/${source}`)).json();
  };

  it('is for admins, keeps the API key secret, and needs an address first', async () => {
    const u = await createUser(owner, 'boss', 'manager');
    const manager = new Client(t.app);
    await manager.login('boss', u.password);
    expect((await manager.req('POST', '/api/import/radarr')).statusCode).toBe(403);
    expect((await owner.req('POST', '/api/import/radarr')).statusCode).toBe(400);
    await owner.req('PUT', '/api/settings/radarr', { url: RADARR, apiKey: 'radarr-secret' });
    expect((await owner.req('GET', '/api/settings/radarr')).body).not.toContain('radarr-secret');
    expect((await owner.req('POST', '/api/import/radarr/test')).json()).toEqual({ ok: true, message: 'Connected to Radarr 5.14.0' });
    expect(keys).toEqual(['radarr-secret']);
  });

  it('imports Radarr movies, finding their files where they are, without downloading', async () => {
    const folder = path.join(media, 'movies', 'Paddington.2014.1080p');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'Paddington.2014.1080p.BluRay.mkv'), 'v');
    await owner.req('PUT', '/api/settings/radarr', { url: RADARR, apiKey: 'r' });
    await owner.req('POST', '/api/import/radarr');
    expect(await finished('radarr')).toMatchObject({ total: 2, added: 1, skipped: 1, errors: [] });
    const [m] = (await owner.req('GET', '/api/monitored')).json();
    expect(m).toMatchObject({ tmdbId: 116149, monitored: false, filePath: path.join(folder, 'Paddington.2014.1080p.BluRay.mkv') });
    // A title already here (library sync monitors everything) takes Radarr's monitored state, and keeps its file.
    await owner.req('PATCH', `/api/monitored/${m.id}`, { monitored: true });
    await owner.req('POST', '/api/import/radarr');
    expect(await finished('radarr')).toMatchObject({ added: 0, updated: 1, skipped: 1 });
    expect((await owner.req('GET', '/api/monitored')).json()[0]).toMatchObject({ monitored: false, filePath: m.filePath });
  });

  it('imports Sonarr shows by TVDB id when Sonarr has no TMDB id', async () => {
    await owner.req('PUT', '/api/settings/sonarr', { url: SONARR, apiKey: 's' });
    await owner.req('POST', '/api/import/sonarr');
    expect(await finished('sonarr')).toMatchObject({ added: 1, errors: [] });
    const [s] = (await owner.req('GET', '/api/monitored')).json();
    expect(s).toMatchObject({ kind: 'show', tmdbId: 82728, monitored: true });
  });

  it('imports Overseerr requests once each, matched to users by email', async () => {
    const kid = await createUser(owner, 'kid', 'user');
    t.app.ctx.dbHandle.sqlite.prepare('UPDATE users SET email = ? WHERE id = ?').run('kid@example.com', kid.id);
    await owner.req('PUT', '/api/settings/overseerr', { url: OVERSEERR, apiKey: 'o' });
    await owner.req('POST', '/api/import/overseerr');
    expect(await finished('overseerr')).toMatchObject({ total: 3, added: 2, skipped: 1, errors: [] });
    const reqs = (await owner.req('GET', '/api/requests')).json() as { title: string; status: string; requestedByName: string; seasons: number[] | null }[];
    expect(reqs.map((r) => [r.title, r.status, r.requestedByName]).sort()).toEqual([
      ['Bluey', 'available', 'stranger'],
      ['Paddington', 'pending', 'kid'],
    ]);
  });
});
