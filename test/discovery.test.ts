import fs from 'node:fs';
import path from 'node:path';
import { parseVideoUrl, sweepTrailers } from '../src/server/trailers/service.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCsv, parseListUrl } from '../src/server/lists/service.js';
import { sniffImage } from '../src/server/posters/service.js';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { fakeFetch, JELLYFIN, PLEX, plexRoutes, tmdbRoutes } from './fakes.js';

const TMDB = 'https://api.themoviedb.org/3';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4ba0000000049454e44ae426082', 'hex');

describe('parsers', () => {
  it('recognises list links', () => {
    expect(parseListUrl('https://mdblist.com/lists/garycrawfordgc/top-watched-movies-of-the-week')).toEqual({ source: 'mdblist', config: { user: 'garycrawfordgc', slug: 'top-watched-movies-of-the-week' } });
    expect(parseListUrl('https://www.themoviedb.org/list/8136-best-picture')).toEqual({ source: 'tmdb_list', config: { id: 8136 } });
    expect(parseListUrl('https://evil.example/lists/a/b')).toBeNull();
  });

  it('parses quoted CSV fields', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ]);
  });

  it('sniffs image types from bytes', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
  });
});

describe('discovery, lists, collections, posters and trailers', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let owner: Client;
  let kid: Client;
  let discoverUrl: URL | null;
  const plexWrites: string[] = [];
  let plexCollections: { ratingKey: string; title: string; thumb?: string }[] = [];

  beforeEach(async () => {
    t = await makeApp();
    owner = await setupOwner(t.app);
    plexWrites.length = 0;
    plexCollections = [];
    discoverUrl = null;
    fakeFetch({
      ...tmdbRoutes,
      ...plexRoutes,
      [`${TMDB}/discover/movie`]: (url: URL) => {
        discoverUrl = url;
        return { page: 1, total_pages: 1, total_results: 1, results: [{ id: 116149, title: 'Paddington', release_date: '2014-11-28', poster_path: '/p.jpg' }] };
      },
      [`${TMDB}/genre/movie/list`]: () => ({ genres: [{ id: 16, name: 'Animation' }] }),
      [`${TMDB}/genre/tv/list`]: () => ({ genres: [{ id: 16, name: 'Animation' }] }),
      [`${TMDB}/watch/providers/tv`]: () => ({ results: [{ provider_id: 73, provider_name: 'Tubi TV', logo_path: '/t.jpg', display_priority: 3 }] }),
      [`${TMDB}/discover/tv`]: (url: URL) => {
        discoverUrl = url;
        return { page: 1, total_pages: 1, total_results: 0, results: [] };
      },
      [`${TMDB}/search/company`]: (url: URL) =>
        url.searchParams.get('query') === 'Lifetime' ? { results: [{ id: 3431, name: 'Lifetime' }, { id: 99, name: 'Lifetime Fitness' }] } : { results: [] },
      [`${TMDB}/watch/providers/movie`]: () => ({ results: [{ provider_id: 8, provider_name: 'Netflix', logo_path: '/n.jpg', display_priority: 1 }] }),
      'https://api.mdblist.com/lists/someone/family-night/items': () => ({
        movies: [
          { id: 1, title: 'Paddington', release_year: 2014, mediatype: 'movie', ids: { tmdb: 116149 } },
          { id: 2, title: 'Future Film', release_year: 2099, mediatype: 'movie', ids: { tmdb: 555 } },
        ],
        shows: [{ id: 3, title: 'Bluey', release_year: 2018, mediatype: 'show', ids: { tmdb: 82728 } }],
      }),
      [`${TMDB}/find/tt1109624`]: () => ({ movie_results: [{ id: 116149, title: 'Paddington', poster_path: '/p.jpg' }], tv_results: [] }),
      [`${TMDB}/movie/116149/images`]: () => ({ posters: [{ file_path: '/alt.jpg', width: 1000, height: 1500, iso_639_1: 'en', vote_average: 5, vote_count: 3 }] }),
      [`${TMDB}/movie/116149/videos`]: () => ({ results: [{ key: 'abcDEF12345', site: 'YouTube', type: 'Trailer', name: 'Official Trailer', official: true, size: 1080 }, { key: 'bad key!', site: 'YouTube', type: 'Trailer' }] }),
      [`${PLEX}/library/sections/1/collections`]: () => ({ MediaContainer: { Metadata: plexCollections } }),
      [`${PLEX}/library/sections/2/collections`]: () => ({ MediaContainer: {} }),
      [`${PLEX}/library/collections/900/children`]: () => ({ MediaContainer: { Metadata: [{ ratingKey: '11' }] } }),
      [`${PLEX}/library/metadata/10`]: () => ({ MediaContainer: { Metadata: [{ librarySectionID: 1 }] } }),
      [`${PLEX}/library/metadata/11`]: () => ({ MediaContainer: { Metadata: [{ librarySectionID: 1 }] } }),
      [`${PLEX}/library/metadata/900/posters`]: (url: URL, init?: RequestInit) => {
        plexWrites.push(`${init?.method} poster ${url.searchParams.get('url')}`);
        return new Response('');
      },
      [`${PLEX}/library/metadata/900/thumb/1`]: (_u: URL, init?: RequestInit) =>
        new Response(PNG, { headers: { 'content-type': 'image/png', 'x-token-seen': String((init?.headers as Record<string, string>)['X-Plex-Token']) } }),
      [`${PLEX}/library/sections/1/all`]: (url: URL, init?: RequestInit) => {
        if (init?.method === 'PUT' && url.searchParams.has('label.locked')) {
          const add = url.searchParams.get('label[0].tag.tag');
          plexWrites.push(`${url.searchParams.get('id')} label${add ? '+' : '-'}${add ?? url.searchParams.get('label[].tag.tag-')}`);
          return new Response('');
        }
        if (init?.method === 'PUT') {
          plexWrites.push(`${url.searchParams.get('id')} ${url.searchParams.get('collection[0].tag.tag') ? '+' : '-'}${url.searchParams.get('collection[0].tag.tag') ?? url.searchParams.get('collection[].tag.tag-')}`);
          plexCollections = [{ ratingKey: '900', title: 'Bear Films', thumb: '/library/metadata/900/thumb/1' }];
          return new Response('');
        }
        return (plexRoutes[`${PLEX}/library/sections/1/all`] as () => unknown)();
      },
      [`${JELLYFIN}/Collections`]: (url: URL) => ({ Id: `jf-${url.searchParams.get('Ids')}` }),
    });
    await owner.req('PUT', '/api/settings/metadata', { tmdbApiKey: 'k', mdblistApiKey: 'm' });
    await owner.req('PUT', '/api/settings/plex', { enabled: true, url: PLEX, token: 'plex-token' });
    await t.librarySync.run();
    const u = await createUser(owner, 'kid', 'user');
    kid = new Client(t.app);
    await kid.login('kid', u.password);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  it('discover passes every filter to TMDB and marks what is on the server', async () => {
    const res = (await kid.req('GET', '/api/discover?kind=movie&genres=16,10751&providers=8&yearFrom=2010&yearTo=2020&ratingMin=7&language=en&sort=rating')).json();
    expect(res.results[0]).toMatchObject({ title: 'Paddington', availability: { status: 'on_server' } });
    const p = Object.fromEntries(discoverUrl!.searchParams);
    expect(p).toMatchObject({
      with_genres: '16|10751',
      with_watch_providers: '8',
      watch_region: 'US',
      'primary_release_date.gte': '2010-01-01',
      'primary_release_date.lte': '2020-12-31',
      'vote_average.gte': '7',
      'vote_count.gte': '200',
      with_original_language: 'en',
      sort_by: 'vote_average.desc',
    });
    expect((await kid.req('GET', '/api/discover?language=english')).statusCode).toBe(400);
    const opts = (await kid.req('GET', '/api/discover/options?kind=tv')).json();
    expect(opts.networks.find((n: { name: string }) => n.name === 'Discovery')).toBeTruthy();
  });

  it('filters by channel, including Lifetime and Hallmark movies, and by a service’s originals', async () => {
    // TV: a chip covers its sibling networks.
    await kid.req('GET', '/api/discover?kind=tv&networks=34');
    expect(discoverUrl!.searchParams.get('with_networks')).toBe('34|1072|7103');
    // Originals: Tubi's own shows instead of everything on Tubi.
    await kid.req('GET', '/api/discover?kind=tv&providers=73&originals=true');
    expect(discoverUrl!.searchParams.get('with_networks')).toBe('5187');
    expect(discoverUrl!.searchParams.get('with_watch_providers')).toBeNull();
    // Movies: a channel matches its production companies by exact name.
    await kid.req('GET', '/api/discover?kind=movie&networks=34');
    expect(discoverUrl!.searchParams.get('with_companies')).toBe('3431');
    expect(discoverUrl!.searchParams.get('with_networks')).toBeNull();
    // Nothing matched: no results rather than every movie.
    await kid.req('GET', '/api/discover?kind=movie&networks=7282');
    expect(discoverUrl!.searchParams.get('with_companies')).toBe('0');
    const tv = (await kid.req('GET', '/api/discover/options?kind=tv')).json();
    expect(tv.networks.map((n: { name: string }) => n.name)).toEqual(expect.arrayContaining(['Lifetime', 'Hallmark', 'Tubi', 'USA Network']));
    expect(tv.originals).toEqual([73]);
    const movie = (await kid.req('GET', '/api/discover/options?kind=movie')).json();
    expect(movie.networks.map((n: { name: string }) => n.name)).toContain('Hallmark');
    expect(movie.networks.map((n: { name: string }) => n.name)).not.toContain('ABC');
    expect(movie.originals).toEqual([8]);
  });

  it('an mdblist list syncs, and with auto-add starts monitoring what is missing', async () => {
    expect((await kid.req('POST', '/api/lists', { name: 'x', url: 'https://mdblist.com/lists/someone/family-night' })).statusCode).toBe(403);
    const list = (await owner.req('POST', '/api/lists', { name: 'Family night', url: 'https://mdblist.com/lists/someone/family-night', autoAdd: true, searchOnAdd: false })).json();
    expect(list.sync).toMatchObject({ ok: true, items: 3, added: 1 }); // Paddington and Bluey are already on Plex
    const items = (await kid.req('GET', `/api/lists/${list.id}/items`)).json().items;
    expect(items.map((i: { title: string }) => i.title)).toEqual(['Paddington', 'Future Film', 'Bluey']);
    // Paddington and Bluey were picked up by library sync (added_by is null); the list added Future Film.
    const monitoredTitles = (t.app.ctx.dbHandle.sqlite.prepare('SELECT title FROM monitored WHERE added_by IS NOT NULL ORDER BY title').all() as { title: string }[]).map((r) => r.title);
    expect(monitoredTitles).toEqual(['Future Film']);
  });

  it('imports Yamtrack and IMDb CSV exports', async () => {
    const yamtrack = 'media_id,source,media_type,title,image,season_number\n82728,tmdb,tv,Bluey,,\n82728,tmdb,season,Bluey,,1\n116149,tmdb,movie,Paddington,,\n999,mal,anime,Some Anime,,';
    const res = await owner.req('POST', '/api/lists/import-csv?name=Yamtrack', yamtrack, { headers: { 'content-type': 'text/plain' } });
    expect(res.json()).toMatchObject({ imported: 2, skipped: 1, source: 'csv' });
    const imdb = 'Position,Const,Created,Title,Title Type,Year\n1,tt1109624,2024-01-01,Paddington,movie,2014';
    const res2 = await owner.req('POST', '/api/lists/import-csv?name=IMDb', imdb, { headers: { 'content-type': 'text/plain' } });
    expect(res2.json()).toMatchObject({ imported: 1 });
    expect((await owner.req('GET', `/api/lists/${res2.json().id}/items`)).json().items[0]).toMatchObject({ tmdbId: 116149, kind: 'movie' });
  });

  it('pushes a collection to Plex as tags and sets its poster', async () => {
    const c = (await owner.req('POST', '/api/collections', { name: 'Bear Films', poster: '/bear.jpg', syncPlex: true, items: [{ kind: 'movie', tmdbId: 116149 }] })).json();
    expect(c.items[0]).toMatchObject({ title: 'Paddington', availability: { status: 'on_server' } });
    const push = (await owner.req('POST', `/api/collections/${c.id}/push`)).json();
    expect(push.plex).toEqual({ added: 1, removed: 0, notOnServer: 0 });
    expect(plexWrites).toEqual(['10 +Bear Films', 'POST poster https://image.tmdb.org/t/p/original/bear.jpg']);

    // Something added to the collection in Plex by hand is removed on the next push.
    plexWrites.length = 0;
    t.app.ctx.dbHandle.sqlite.prepare("UPDATE collections SET plex_key = '900'").run();
    await owner.req('POST', `/api/collections/${c.id}/push`);
    expect(plexWrites[0]).toBe('10 +Bear Films');
    expect(plexWrites[1]).toBe('11 -Bear Films');
    expect((await kid.req('POST', `/api/collections/${c.id}/push`)).statusCode).toBe(403);
  });

  it('fills a collection from a Plex label and labels a collection\'s items on Plex', async () => {
    expect((await owner.req('GET', '/api/library/labels')).json()).toEqual({ labels: ['Kids'] });
    expect((await kid.req('GET', '/api/library/labels')).statusCode).toBe(403);
    const kids = (await owner.req('POST', '/api/collections', { name: 'Kids', fromLabel: 'kids' })).json();
    expect(kids.items.map((i: { title: string }) => i.title)).toEqual(['Paddington']);
    expect((await owner.req('POST', `/api/collections/${kids.id}/items`, { kind: 'movie', tmdbId: 999 })).statusCode).toBe(400);

    const c = (await owner.req('POST', '/api/collections', { name: 'Bears', plexLabel: 'Bears', syncPlex: true, items: [{ kind: 'movie', tmdbId: 116149 }] })).json();
    plexWrites.length = 0;
    await owner.req('POST', `/api/collections/${c.id}/push`);
    expect(plexWrites).toContain('10 label+Bears');
    // An item that carries the label but left the collection loses it.
    t.app.ctx.dbHandle.sqlite.prepare(`UPDATE library_items SET labels = '["Bears"]' WHERE external_key = '11'`).run();
    plexWrites.length = 0;
    await owner.req('POST', `/api/collections/${c.id}/push`);
    expect(plexWrites).toContain('11 label-Bears');
  });

  it('adds a collection to the connected servers in one step', async () => {
    const c = (await owner.req('POST', '/api/collections', { name: 'Bear Films', toServers: true, items: [{ kind: 'movie', tmdbId: 116149 }] })).json();
    expect(c).toMatchObject({ syncPlex: true, syncJellyfin: false });
    expect(plexWrites).toEqual(['10 +Bear Films']);
    await owner.req('PUT', '/api/settings/plex', { enabled: false });
    expect((await owner.req('POST', '/api/collections', { name: 'Nothing', toServers: true })).statusCode).toBe(400);
  });

  it('imports Plex collections and proxies their covers without exposing the token', async () => {
    plexCollections = [{ ratingKey: '900', title: 'Bear Films', thumb: '/library/metadata/900/thumb/1' }];
    expect((await owner.req('POST', '/api/collections/import', { server: 'plex' })).json()).toEqual({ imported: 1, updated: 0 });
    const list = (await kid.req('GET', '/api/collections')).json();
    expect(list[0]).toMatchObject({ name: 'Bear Films', poster: 'plex:/library/metadata/900/thumb/1', itemCount: 1, library: 'Movies' });
    const img = await kid.req('GET', `/api/images?src=${encodeURIComponent(list[0].poster)}`);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['x-token-seen']).toBeUndefined();
    expect((await kid.req('GET', `/api/images?src=${encodeURIComponent('plex:/:/prefs')}`)).statusCode).toBe(400);
    expect((await kid.req('GET', `/api/images?src=${encodeURIComponent('local:../../app.db')}`)).statusCode).toBe(400);
  });

  it('changes a poster from TMDB or an upload, and refuses non-images and private URLs', async () => {
    const opts = (await owner.req('GET', '/api/posters/movie/116149')).json();
    expect(opts[0]).toMatchObject({ source: 'tmdb', value: '/alt.jpg' });
    expect((await owner.req('POST', '/api/posters/movie/116149', { value: '/alt.jpg' })).json().servers).toEqual([{ server: 'plex', ok: true }]);
    expect((await kid.req('GET', '/api/media/movie/116149')).json().posterPath).toBe('/alt.jpg');
    expect((await owner.req('POST', '/api/posters/movie/116149', { value: 'https://127.0.0.1/x.jpg' })).statusCode).toBe(400);
    expect((await owner.req('POST', '/api/posters/movie/116149', Buffer.from('<svg/>'), { headers: { 'content-type': 'image/png' } })).statusCode).toBe(400);
    expect((await owner.req('POST', '/api/posters/movie/116149', PNG, { headers: { 'content-type': 'image/png' } })).statusCode).toBe(200);
    const override = (await kid.req('GET', '/api/media/movie/116149')).json().posterPath as string;
    expect(override).toMatch(/^local:movie-116149-[\w-]+\.png$/);
    expect((await kid.req('GET', `/api/images?src=${encodeURIComponent(override)}`)).statusCode).toBe(200);
    await owner.req('DELETE', '/api/posters/movie/116149');
    expect((await kid.req('GET', '/api/media/movie/116149')).json().posterPath).toBe('/p.jpg');
    expect(fs.readdirSync(path.join(t.dir, 'posters'))).toEqual([]);
  });

  it('fetches trailers for managed titles that have files but no trailer', async () => {
    const movies = path.join(t.dir, 'media', 'movies');
    const ytdlp = path.join(t.dir, 'yt-dlp');
    fs.writeFileSync(ytdlp, '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\nout=$(echo "$2" | sed "s/%(ext)s/mkv/")\necho trailer > "$out"\n', { mode: 0o755 });
    await owner.req('PUT', '/api/settings/media', { moviesPath: movies });
    await owner.req('PUT', '/api/settings/extras', { ytDlpPath: ytdlp });
    fs.mkdirSync(path.join(movies, 'Paddington (2014)'), { recursive: true });
    fs.writeFileSync(path.join(movies, 'Paddington (2014)', 'Paddington.2014.1080p.mkv'), 'movie');
    const m = (await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, search: false })).json();
    t.app.ctx.dbHandle.sqlite.prepare('update monitored set path = ?, file_path = ? where id = ?').run(path.join(movies, 'Paddington (2014)'), path.join(movies, 'Paddington (2014)', 'Paddington.2014.1080p.mkv'), m.id);
    expect(await sweepTrailers(t.app.ctx)).toBe(1);
    expect(fs.readdirSync(path.join(movies, 'Paddington (2014)')).sort()).toEqual(['Paddington.2014.1080p-trailer.mkv', 'Paddington.2014.1080p.mkv']);
    expect(await sweepTrailers(t.app.ctx)).toBe(0); // already has one
    await owner.req('PUT', '/api/settings/extras', { autoDownloadTrailers: false });
    fs.rmSync(path.join(movies, 'Paddington (2014)', 'Paddington.2014.1080p-trailer.mkv'));
    expect(await sweepTrailers(t.app.ctx)).toBe(0); // turned off
  });

  it('downloads a trailer next to the movie with yt-dlp and removes it', async () => {
    const movies = path.join(t.dir, 'media', 'movies');
    const ytdlp = path.join(t.dir, 'yt-dlp');
    // A stand-in for yt-dlp that writes the output file named by -o.
    fs.writeFileSync(ytdlp, '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\nout=$(echo "$2" | sed "s/%(ext)s/mkv/")\necho trailer > "$out"\n', { mode: 0o755 });
    await owner.req('PUT', '/api/settings/media', { moviesPath: movies });
    await owner.req('PUT', '/api/settings/extras', { ytDlpPath: ytdlp });
    const m = (await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, search: false })).json();
    const info = (await owner.req('GET', `/api/monitored/${m.id}/trailers`)).json();
    expect(info.candidates.map((c: { key: string }) => c.key)).toEqual(['abcDEF12345']);
    expect((await owner.req('POST', `/api/monitored/${m.id}/trailers`, { key: '--exec=rm' })).statusCode).toBe(400);
    expect((await owner.req('POST', `/api/monitored/${m.id}/trailers`, { key: 'abcDEF12345' })).json().status).toBe('downloading');
    await vi.waitFor(async () => expect((await owner.req('GET', `/api/monitored/${m.id}/trailers`)).json().job.status).toBe('done'));
    const files = (await owner.req('GET', `/api/monitored/${m.id}/trailers`)).json().files;
    expect(files.map((f: { path: string }) => path.relative(movies, f.path))).toEqual([path.join('Paddington (2014)', 'Paddington (2014)-trailer.mkv')]);

    // Anyone who can browse can watch it, with seeking (range requests).
    expect((await kid.req('GET', '/api/trailers/movie/116149')).json()).toEqual([{ index: 0, name: 'Paddington (2014)-trailer', size: 8, type: 'video/x-matroska' }]);
    const part = await kid.req('GET', '/api/trailers/movie/116149/0', undefined, { headers: { range: 'bytes=0-3' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 0-3/8');
    expect(part.body).toBe('trai');
    expect((await kid.req('GET', '/api/trailers/movie/116149/1')).statusCode).toBe(404);
    expect((await kid.req('DELETE', `/api/monitored/${m.id}/trailers`)).statusCode).toBe(403);

    // A pasted link: only YouTube and Vimeo.
    expect((await owner.req('POST', `/api/monitored/${m.id}/trailers`, { url: 'https://evil.example/video' })).statusCode).toBe(400);
    expect((await owner.req('POST', `/api/monitored/${m.id}/trailers`, { url: 'https://vimeo.com/76979871' })).json()).toMatchObject({ status: 'downloading', key: '76979871' });
    await vi.waitFor(async () => expect((await owner.req('GET', `/api/monitored/${m.id}/trailers`)).json().job.status).toBe('done'));
    expect((await owner.req('DELETE', `/api/monitored/${m.id}/trailers`)).json()).toEqual({ removed: 1 });
  });

  it('reads YouTube and Vimeo links and nothing else', () => {
    expect(parseVideoUrl('https://www.youtube.com/watch?v=abcDEF12345&t=3')).toEqual({ site: 'YouTube', key: 'abcDEF12345' });
    expect(parseVideoUrl('https://youtu.be/abcDEF12345')).toEqual({ site: 'YouTube', key: 'abcDEF12345' });
    expect(parseVideoUrl('https://player.vimeo.com/video/76979871')).toEqual({ site: 'Vimeo', key: '76979871' });
    expect(parseVideoUrl('https://www.youtube.com/watch?v=--exec=rm')).toBeNull();
    expect(parseVideoUrl('https://youtube.com.evil.example/watch?v=abcDEF12345')).toBeNull();
    expect(parseVideoUrl('javascript:alert(1)')).toBeNull();
  });

  it('only runs a program named yt-dlp', async () => {
    const other = path.join(t.dir, 'not-ytdlp');
    fs.writeFileSync(other, '#!/bin/sh\ntouch /tmp/pwned\n', { mode: 0o755 });
    await owner.req('PUT', '/api/settings/media', { moviesPath: path.join(t.dir, 'media', 'movies') });
    await owner.req('PUT', '/api/settings/extras', { ytDlpPath: other });
    const m = (await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, search: false })).json();
    const res = await owner.req('POST', `/api/monitored/${m.id}/trailers`, { key: 'abcDEF12345' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/named yt-dlp/);
  });

  it('each person keeps their own homepage layout', async () => {
    expect((await kid.req('GET', '/api/home/layout')).json().custom).toBe(false);
    const rows = [{ type: 'recent' }, { type: 'popular', kind: 'tv' }];
    expect((await kid.req('PUT', '/api/home/layout', { rows })).json()).toEqual({ rows, custom: true });
    expect((await owner.req('GET', '/api/home/layout')).json().custom).toBe(false);
    expect((await kid.req('PUT', '/api/home/layout', { rows: [{ type: 'evil' }] })).statusCode).toBe(400);
    expect((await kid.req('DELETE', '/api/home/layout')).json().custom).toBe(false);
  });
});
