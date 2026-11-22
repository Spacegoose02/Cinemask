import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { episodeOfFile, seasonOfFolder } from '../src/server/files/service.js';
import { matchScore } from '../src/server/files/folders.js';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { fakeFetch, tmdbRoutes } from './fakes.js';

describe('mapping titles to folders by hand', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let owner: Client;
  let kid: Client;
  let tv: string;
  let movies: string;
  let outside: string;

  beforeEach(async () => {
    t = await makeApp();
    owner = await setupOwner(t.app);
    tv = path.join(t.dir, 'media', 'tv');
    movies = path.join(t.dir, 'media', 'movies');
    outside = path.join(t.dir, 'private');
    for (const d of [tv, movies, outside]) fs.mkdirSync(d, { recursive: true });
    fs.mkdirSync(path.join(outside, 'secrets'));
    fakeFetch({ ...tmdbRoutes });
    await owner.req('PUT', '/api/settings/metadata', { tmdbApiKey: 'k' });
    await owner.req('PUT', '/api/settings/media', { downloadsPath: path.join(t.dir, 'downloads'), moviesPath: movies, tvPath: tv });
    const u = await createUser(owner, 'kid', 'user');
    kid = new Client(t.app);
    await kid.login('kid', u.password);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  const addBluey = async () => (await owner.req('POST', '/api/monitored', { kind: 'show', tmdbId: 82728, search: false })).json().id as number;

  it('reads season folders and episode numbers that have no SxxEyy', () => {
    expect([seasonOfFolder('Season 2'), seasonOfFolder('S03'), seasonOfFolder('Specials'), seasonOfFolder('Series 4'), seasonOfFolder('Spidey 2'), seasonOfFolder('Extras')]).toEqual([2, 3, 0, 4, null, null]);
    expect(episodeOfFile('/x/Episode 4.mkv')).toEqual([4]);
    expect(episodeOfFile('/x/E01E02 - Two parter.mkv')).toEqual([1, 2]);
    expect(episodeOfFile('/x/05 - The Pool.mkv')).toEqual([5]);
    expect(episodeOfFile('/x/05 - The Pool.mkv', false)).toEqual([]);
    expect(episodeOfFile('/x/Glow Webs 1080p.mkv')).toEqual([]);
  });

  it('scores folder names against titles', () => {
    const bluey = { title: 'Bluey', year: 2018, tmdbId: 82728 };
    expect(matchScore('Bluey (2018)', bluey)).toBeGreaterThanOrEqual(1);
    expect(matchScore('Bluey {tmdb-82728}', bluey)).toBe(2);
    expect(matchScore('Something {tmdb-1}', bluey)).toBe(0);
    expect(matchScore("Disney's Bluey [1080p]", bluey)).toBeGreaterThanOrEqual(0.6);
    expect(matchScore('Paw Patrol (2013)', bluey)).toBe(0);
  });

  it('finds a show whose folder year is a year off from TMDB, and episodes named without a season', async () => {
    const folder = path.join(tv, 'Bluey (2019)');
    fs.mkdirSync(path.join(folder, 'Season 1'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'Season 1', '01 - The Magic Xylophone.mkv'), 'a');
    fs.writeFileSync(path.join(folder, 'Season 1', 'Bluey Episode 2.mkv'), 'b');
    const id = await addBluey();
    expect((await owner.req('POST', `/api/monitored/${id}/scan`)).json()).toMatchObject({ found: 2, folder, exists: true });
  });

  it('says so when no folder is found', async () => {
    const id = await addBluey();
    expect((await owner.req('POST', `/api/monitored/${id}/scan`)).json()).toMatchObject({ found: 0, exists: false });
  });

  it('browses only inside the media folders and points a show at a folder picked by hand', async () => {
    const folder = path.join(tv, 'Kids', 'Blue Dog Show');
    fs.mkdirSync(path.join(folder, 'S1'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'S1', 'bluey.s01e01.mkv'), 'a');
    fs.writeFileSync(path.join(folder, 'S1', 'bluey.s01e03.mkv'), 'c');
    // A link out of the media folder is never listed or accepted.
    fs.symlinkSync(outside, path.join(tv, 'escape'));
    const id = await addBluey();

    const top = (await owner.req('GET', '/api/files/browse?kind=show')).json();
    expect(top.dirs.map((d: { path: string }) => d.path)).toEqual([tv]);
    const root = (await owner.req('GET', `/api/files/browse?kind=show&path=${encodeURIComponent(tv)}`)).json();
    expect(root).toMatchObject({ current: tv, parent: null, rootId: 'default' });
    expect(root.dirs.map((d: { name: string }) => d.name)).toEqual(['Kids']);
    expect((await owner.req('GET', `/api/files/browse?kind=show&path=${encodeURIComponent(outside)}`)).statusCode).toBe(400);
    expect((await owner.req('GET', `/api/files/browse?kind=show&path=${encodeURIComponent(path.join(tv, 'escape'))}`)).statusCode).toBe(400);
    expect((await owner.req('GET', `/api/files/browse?kind=show&path=${encodeURIComponent(path.join(tv, '..', 'private'))}`)).statusCode).toBe(400);
    expect((await owner.req('GET', `/api/files/browse?kind=movie&path=${encodeURIComponent(tv)}`)).statusCode).toBe(400);
    expect((await kid.req('GET', `/api/files/browse?kind=show&path=${encodeURIComponent(tv)}`)).statusCode).toBe(403);

    // Not outside, not the media folder itself, not by a plain user.
    expect((await owner.req('POST', `/api/monitored/${id}/folder`, { path: path.join(outside, 'secrets') })).statusCode).toBe(400);
    expect((await owner.req('POST', `/api/monitored/${id}/folder`, { path: path.join(tv, 'escape', 'secrets') })).statusCode).toBe(400);
    expect((await owner.req('POST', `/api/monitored/${id}/folder`, { path: tv })).statusCode).toBe(400);
    expect((await owner.req('POST', `/api/monitored/${id}/folder`, { path: path.join(tv, 'nope') })).statusCode).toBe(400);
    expect((await kid.req('POST', `/api/monitored/${id}/folder`, { path: folder })).statusCode).toBe(403);

    expect((await owner.req('POST', `/api/monitored/${id}/folder`, { path: folder })).json()).toMatchObject({ found: 2, folder });
    const files = (await owner.req('GET', `/api/monitored/${id}/files`)).json();
    expect(files.folder).toBe(folder);
    expect(files.files).toHaveLength(2);
    const log = t.app.ctx.dbHandle.sqlite.prepare("SELECT action FROM audit_log WHERE action = 'files.folder_set'").all();
    expect(log).toHaveLength(1);
  });

  it('lists unmapped folders with suggestions and imports them in bulk', async () => {
    const id = await addBluey();
    const movieId = (await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, search: false })).json().id as number;
    // Not found automatically: the folder name doesn't start with the title.
    const folder = path.join(tv, "Disney's Bluey [1080p]");
    fs.mkdirSync(path.join(folder, 'Season 1'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'Season 1', 'Episode 3.mkv'), 'c');
    fs.mkdirSync(path.join(tv, 'Some Other Show'));
    expect((await owner.req('POST', `/api/monitored/${id}/scan`)).json().exists).toBe(false);

    expect((await kid.req('GET', '/api/files/library-import?kind=show')).statusCode).toBe(403);
    const list = (await owner.req('GET', '/api/files/library-import?kind=show')).json();
    expect(list.folders.map((f: { name: string }) => f.name)).toEqual(["Disney's Bluey [1080p]", 'Some Other Show']);
    expect(list.folders[0].suggestion).toMatchObject({ id, title: 'Bluey' });
    expect(list.folders[1].suggestion).toBeNull();
    expect(list.titles.map((x: { id: number }) => x.id)).toEqual([id]);

    expect((await kid.req('POST', '/api/files/library-import', { items: [{ folder, monitoredId: id }] })).statusCode).toBe(403);
    const r = (
      await owner.req('POST', '/api/files/library-import', {
        items: [
          { folder, monitoredId: id },
          { folder: path.join(outside, 'secrets'), monitoredId: movieId },
          { folder: path.join(tv, 'Some Other Show'), monitoredId: movieId },
        ],
      })
    ).json();
    expect(r).toMatchObject({ mapped: 1, files: 1 });
    expect(r.results.filter((x: { error?: string }) => x.error)).toHaveLength(2);
    // Mapped now, so it no longer shows; the other folder still does.
    const after = (await owner.req('GET', '/api/files/library-import?kind=show')).json();
    expect(after.folders.map((f: { name: string }) => f.name)).toEqual(['Some Other Show']);
    expect(after.titles).toEqual([]);
    // Importing the same pair again is harmless.
    const other = (await owner.req('POST', '/api/files/library-import', { items: [{ folder, monitoredId: id }] })).json();
    expect(other.mapped).toBe(1);
  });
});
