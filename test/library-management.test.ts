import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insideRoot } from '../src/server/files/service.js';
import { ensureMedia } from '../src/server/library/service.js';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { fakeFetch, tmdbRoutes } from './fakes.js';

describe('file management, calendar and health', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let owner: Client;
  let kid: Client;
  let tv: string;
  let movies: string;

  beforeEach(async () => {
    t = await makeApp();
    owner = await setupOwner(t.app);
    tv = path.join(t.dir, 'media', 'tv');
    movies = path.join(t.dir, 'media', 'movies');
    fs.mkdirSync(tv, { recursive: true });
    fs.mkdirSync(movies, { recursive: true });
    fakeFetch({ ...tmdbRoutes });
    await owner.req('PUT', '/api/settings/metadata', { tmdbApiKey: 'k' });
    await owner.req('PUT', '/api/settings/media', { downloadsPath: path.join(t.dir, 'downloads'), moviesPath: movies, tvPath: tv });
    await owner.req('PUT', '/api/settings/naming', { seasonFolder: 'Season {season}', episodeFile: '{Series Title} - S{season:00}E{episode:00} - {Episode Title}' });
    const u = await createUser(owner, 'kid', 'user');
    kid = new Client(t.app);
    await kid.login('kid', u.password);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  const addShowWithFiles = async () => {
    const m = (await owner.req('POST', '/api/monitored', { kind: 'show', tmdbId: 82728, search: false })).json();
    const old = path.join(tv, 'Bluey (2018)', 'S1');
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'bluey.s01e01.1080p.web-dl.mkv'), 'one');
    fs.writeFileSync(path.join(old, 'bluey.s01e02e03.720p.hdtv.mkv'), 'two-three');
    const scan = (await owner.req('POST', `/api/monitored/${m.id}/scan`)).json();
    expect(scan).toMatchObject({ found: 3, missing: 0 });
    return m.id as number;
  };

  it('adopts existing files, previews a rename and applies it', async () => {
    const id = await addShowWithFiles();
    const files = (await owner.req('GET', `/api/monitored/${id}/files`)).json();
    expect(files.files).toHaveLength(2);
    expect(files.files.find((f: { episodes: number[] }) => f.episodes.length === 2)).toMatchObject({ quality: 'HDTV-720p', season: 1, episodes: [2, 3] });

    const preview = (await owner.req('GET', `/api/monitored/${id}/rename`)).json();
    expect(preview.map((p: { to: string }) => path.relative(tv, p.to)).sort()).toEqual([
      path.join('Bluey (2018)', 'Season 1', 'Bluey - S01E01 - Ep 1.mkv'),
      path.join('Bluey (2018)', 'Season 1', 'Bluey - S01E02-E03 - Ep 2 + Ep 3.mkv'),
    ]);
    // Users can't touch files.
    expect((await kid.req('POST', `/api/monitored/${id}/rename`, {})).statusCode).toBe(403);
    expect((await owner.req('POST', `/api/monitored/${id}/rename`, {})).json()).toEqual({ renamed: 2, errors: [] });
    expect(fs.readdirSync(path.join(tv, 'Bluey (2018)'))).toEqual(['Season 1']); // the old empty folder is gone
    expect((await owner.req('GET', `/api/monitored/${id}/rename`)).json()).toEqual([]);
  });

  it('deletes an episode (taking a multi-episode file with it) and can stop monitoring it', async () => {
    const id = await addShowWithFiles();
    const res = (await owner.req('POST', `/api/monitored/${id}/delete-files`, { scope: 'episode', season: 1, episode: 2, unmonitor: true })).json();
    expect(res).toMatchObject({ deleted: 1, freed: 9 });
    const eps = t.app.ctx.dbHandle.sqlite.prepare('SELECT episode, file_path, monitored FROM monitored_episodes WHERE monitored_id = ? ORDER BY episode').all(id) as { episode: number; file_path: string | null; monitored: number }[];
    expect(eps.map((e) => [e.episode, Boolean(e.file_path), e.monitored])).toEqual([
      [1, true, 1],
      [2, false, 0],
      [3, false, 1],
    ]);
    expect((await owner.req('POST', `/api/monitored/${id}/delete-files`, { scope: 'season', season: 1 })).json()).toMatchObject({ deleted: 1 });
    expect(fs.existsSync(path.join(tv, 'Bluey (2018)'))).toBe(false);
  });

  it('refuses to delete anything outside the media folders', async () => {
    const id = await addShowWithFiles();
    const outside = path.join(t.dir, 'precious.mkv');
    fs.writeFileSync(outside, 'keep me');
    t.app.ctx.dbHandle.sqlite.prepare('UPDATE monitored_episodes SET file_path = ? WHERE monitored_id = ? AND episode = 1').run(outside, id);
    const res = await owner.req('POST', `/api/monitored/${id}/delete-files`, { scope: 'episode', season: 1, episode: 1 });
    expect(res.statusCode).toBe(400);
    expect(fs.existsSync(outside)).toBe(true);

    // A symlink inside the library pointing out of it doesn't count as inside.
    const link = path.join(tv, 'escape');
    fs.symlinkSync(t.dir, link);
    expect(insideRoot(tv, path.join(link, 'precious.mkv'))).toBe(false);
    expect(insideRoot(tv, tv)).toBe(false);
  });

  it('removes a movie with its folder when asked', async () => {
    const m = (await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, search: false })).json();
    const folder = path.join(movies, 'Paddington (2014)');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'Paddington.2014.1080p.BluRay.mkv'), 'movie');
    fs.writeFileSync(path.join(folder, 'Paddington.2014.en.srt'), 'subs');
    expect((await owner.req('POST', `/api/monitored/${m.id}/scan`)).json().found).toBe(1);
    expect((await owner.req('GET', `/api/monitored/${m.id}/files`)).json().files[0]).toMatchObject({ quality: 'Bluray-1080p', size: 5 });
    expect((await owner.req('POST', `/api/monitored/${m.id}/remove`, { deleteFiles: true })).json()).toEqual({ ok: true, freed: 9 });
    expect(fs.existsSync(folder)).toBe(false);
    expect(fs.existsSync(movies)).toBe(true);
  });

  it('finds a title already on the server in a folder named its own way, in any root folder', async () => {
    const kids = path.join(t.dir, 'media', 'kids');
    await owner.req('PUT', '/api/settings/media', { extraFolders: [{ id: 'kids', name: 'Kids Movies', kind: 'movie', path: kids, category: '' }] });
    fs.mkdirSync(path.join(movies, 'Paddington 2 (2017)'), { recursive: true }); // a different film
    fs.writeFileSync(path.join(movies, 'Paddington 2 (2017)', 'p2.mkv'), 'other');
    const folder = path.join(kids, 'Paddington.2014.1080p.BluRay-GRP');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'paddington.mkv'), 'movie');
    const m = (await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, search: false })).json();
    await owner.req('PATCH', `/api/monitored/${m.id}`, { monitored: false });
    expect((await owner.req('POST', `/api/monitored/${m.id}/scan`)).json()).toMatchObject({ found: 1, folder });
    expect((await owner.req('GET', `/api/monitored/lookup/movie/116149`)).json().monitored).toMatchObject({ rootId: 'kids', monitored: false });
    expect((await owner.req('POST', `/api/monitored/${m.id}/remove`, { deleteFiles: true })).json()).toEqual({ ok: true, freed: 5 });
    expect(fs.existsSync(folder)).toBe(false);
    expect(fs.existsSync(path.join(movies, 'Paddington 2 (2017)', 'p2.mkv'))).toBe(true);
  });

  it('prefers a folder tagged with the TMDB id', async () => {
    fs.mkdirSync(path.join(movies, 'Paddington (2014)-old'), { recursive: true });
    const folder = path.join(movies, 'Paddington {tmdb-116149}');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'paddington.mkv'), 'movie');
    const m = (await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, search: false })).json();
    expect((await owner.req('POST', `/api/monitored/${m.id}/scan`)).json()).toMatchObject({ found: 1, folder });
  });

  it('plays a trailer already in the folder of a title Cinemask does not manage, and shows managers the folder', async () => {
    ensureMedia(t.app.ctx, 'movie', 116149, { title: 'Paddington', year: 2014 });
    const folder = path.join(movies, 'Paddington (2014)');
    fs.mkdirSync(path.join(folder, 'Trailers'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'Paddington.2014.1080p.BluRay.mp4'), 'movie');
    fs.writeFileSync(path.join(folder, 'Paddington (2014)-trailer.mkv'), 'trailer');
    fs.writeFileSync(path.join(folder, 'Trailers', 'Teaser.mp4'), 'teaser');
    expect((await kid.req('GET', '/api/trailers/movie/116149')).json().map((x: { name: string }) => x.name)).toEqual(['Paddington (2014)-trailer', 'Teaser']);
    expect((await kid.req('GET', '/api/trailers/movie/116149/0')).body).toBe('trailer');
    expect((await owner.req('GET', '/api/monitored/lookup/movie/116149')).json()).toMatchObject({ monitored: null, folder });
    expect((await kid.req('GET', '/api/monitored/lookup/movie/116149')).json().folder).toBeUndefined();
  });

  it('calendar groups a show’s episodes on the same day and lists movie release types', async () => {
    await addShowWithFiles();
    const paddington = (await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, search: false })).json();
    const days = (await kid.req('GET', '/api/calendar?start=2018-09-01&end=2018-10-31')).json();
    expect(days).toHaveLength(1);
    // monitoredId lets a manager search for an episode or movie straight from the calendar.
    expect(days[0]).toMatchObject({ date: '2018-10-01', title: 'Bluey', hasFile: true, monitoredId: expect.any(Number) });
    expect(days[0].episodes).toHaveLength(3);
    // Premieres and finales are marked for the calendar's badges and its premieres view.
    expect(days[0].episodes.map((e: { marker: string | null }) => e.marker)).toEqual(['series_premiere', null, 'season_finale']);
    const movie = (await kid.req('GET', '/api/calendar?start=2015-04-01&end=2015-04-30')).json();
    // The digital release came after the cinema one, so it isn't the premiere.
    expect(movie).toEqual([expect.objectContaining({ monitoredId: paddington.id, title: 'Paddington', releaseType: 'digital', date: '2015-04-28', hasFile: false, premiere: false })]);
    expect((await kid.req('GET', '/api/calendar?start=2018-01-01&end=2018-12-31')).statusCode).toBe(400);
  });

  it('lists what is monitored and what is missing', async () => {
    const show = await addShowWithFiles();
    const movie = (await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, search: false })).json();
    await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 555, search: false });
    expect((await kid.req('GET', '/api/monitored/overview')).statusCode).toBe(403);
    const byTitle = () => owner.req('GET', '/api/monitored/overview').then((r) => Object.fromEntries(r.json().map((x: { title: string }) => [x.title, x])));
    let o = await byTitle();
    expect(o.Bluey).toMatchObject({ monitored: true, status: 'downloaded', episodes: { aired: 3, missing: 0 } });
    expect(o.Paddington).toMatchObject({ monitored: true, status: 'missing', episodes: null });
    expect(o['Future Film']).toMatchObject({ status: 'upcoming' });

    // An episode's file goes: the show is partly missing. Unmonitoring shows too.
    t.app.ctx.dbHandle.sqlite.prepare('UPDATE monitored_episodes SET file_path = NULL WHERE monitored_id = ? AND episode = 1').run(show);
    await owner.req('PATCH', `/api/monitored/${movie.id}`, { monitored: false });
    o = await byTitle();
    expect(o.Bluey).toMatchObject({ status: 'partial', episodes: { aired: 3, missing: 1 } });
    expect(o.Paddington.monitored).toBe(false);
    expect(o.Paddington).toMatchObject({ profile: expect.any(String), ended: false, nextAir: null });
  });

  it('lists each followed show\'s next and latest episode for anyone', async () => {
    const show = await addShowWithFiles();
    const day = (offset: number) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
    const setAir = (episode: number, date: string) => t.app.ctx.dbHandle.sqlite.prepare('UPDATE monitored_episodes SET air_date = ? WHERE monitored_id = ? AND episode = ?').run(date, show, episode);
    setAir(1, day(-3));
    setAir(2, day(-1));
    setAir(3, day(0));
    const res = (await kid.req('GET', '/api/airing?days=7')).json();
    expect(res.next).toEqual([expect.objectContaining({ title: 'Bluey', season: 1, episode: 3, airDate: day(0), hasFile: true })]);
    expect(res.recent).toEqual([expect.objectContaining({ episode: 2, airDate: day(-1) })]);
    expect((await owner.req('GET', '/api/monitored/overview')).json()[0]).toMatchObject({ title: 'Bluey', nextAir: null });
    setAir(3, day(2));
    expect((await owner.req('GET', '/api/monitored/overview')).json()[0]).toMatchObject({ nextAir: day(2), episodes: { aired: 2 } });
    // Unmonitored shows aren't listed.
    await owner.req('PATCH', `/api/monitored/${show}`, { monitored: false });
    expect((await kid.req('GET', '/api/airing')).json()).toEqual({ next: [], recent: [] });
    expect((await kid.req('GET', '/api/airing?days=90')).statusCode).toBe(400);
  });

  it('health checks report missing folders and are admin only', async () => {
    fs.rmSync(movies, { recursive: true });
    expect((await kid.req('GET', '/api/system/health')).statusCode).toBe(403);
    const report = (await owner.req('GET', '/api/system/health')).json();
    const byId = Object.fromEntries(report.checks.map((c: { id: string }) => [c.id, c]));
    expect(byId.movies.level).toBe('error');
    expect(byId.tv.level).not.toBe('error');
    expect(byId.indexers.level).toBe('warning');
    expect(byId.backup.level).toBe('warning');
    expect(report.level).toBe('error');
    expect((await owner.req('GET', '/api/system/health/summary')).json()).toMatchObject({ level: 'error' });
  });
});
