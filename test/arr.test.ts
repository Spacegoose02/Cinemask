import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/server/arr/clients.js';
import { decide } from '../src/server/arr/decision.js';
import { assertSafeUrl, isPrivateAddress } from '../src/server/arr/direct.js';
import { parseFeed, type Release } from '../src/server/arr/indexers.js';
import { trackDownloads } from '../src/server/arr/tracker.js';
import { importDownload } from '../src/server/arr/importer.js';
import { forgetWatchFailures, scanWatchFolder } from '../src/server/arr/watch.js';
import { rssSync } from '../src/server/arr/rss.js';
import { maxSizeFor } from '../src/server/arr/search.js';
import { ensureMedia } from '../src/server/library/service.js';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { bodyText, fakeFetch, torrentFile, tmdbRoutes } from './fakes.js';

const INDEXER = 'http://indexer.local';
const QBIT = 'http://qbit.local:8080';

function torznab(items: { title: string; seeders?: number; size?: number }[]) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>
${items
  .map(
    (i, n) => `<item><title>${i.title}</title><guid>guid-${n}-${i.title}</guid><link>${INDEXER}/dl/${n}</link><size>${i.size ?? 2_000_000_000}</size>
<pubDate>Mon, 01 Jan 2024 00:00:00 +0000</pubDate><enclosure url="${INDEXER}/dl/${n}.torrent" length="${i.size ?? 2_000_000_000}" type="application/x-bittorrent"/>
<torznab:attr name="seeders" value="${i.seeders ?? 20}"/><torznab:attr name="peers" value="25"/></item>`,
  )
  .join('\n')}
</channel></rss>`;
}

const rel = (title: string, extra: Partial<Release> = {}): Release => ({
  guid: title,
  title,
  downloadUrl: 'x',
  infoUrl: null,
  size: 1,
  publishedAt: null,
  indexer: 'i',
  indexerId: 1,
  protocol: 'torrent',
  seeders: 10,
  peers: 10,
  ...extra,
});

describe('indexer feeds', () => {
  it('parses Torznab items with attributes', () => {
    const r = parseFeed(torznab([{ title: 'Paddington.2014.1080p.BluRay.x264-GRP', seeders: 42 }]), { id: 1, name: 'Test', type: 'torznab' });
    expect(r[0]).toMatchObject({ title: 'Paddington.2014.1080p.BluRay.x264-GRP', seeders: 42, size: 2_000_000_000, protocol: 'torrent', downloadUrl: `${INDEXER}/dl/0.torrent` });
  });

  it('turns an indexer error document into an error', () => {
    expect(() => parseFeed('<error code="100" description="Incorrect user credentials"/>', { id: 1, name: 'Test', type: 'newznab' })).toThrow('Incorrect user credentials');
  });
});

describe('release decisions', () => {
  const profile = { id: 1, name: '1080p or above', qualities: ['WEBDL-1080p', 'Bluray-1080p', 'WEBDL-2160p'] as never, cutoff: 'Bluray-1080p' as never, upgradesAllowed: true, language: 'en' };
  const movie = { kind: 'movie' as const, title: 'Paddington', year: 2014 };

  it('accepts a matching release and rejects the wrong title, year, quality or language', () => {
    expect(decide(rel('Paddington.2014.1080p.BluRay.x264'), movie, profile, new Set()).accepted).toBe(true);
    expect(decide(rel('Paddington.2.2017.1080p.BluRay'), movie, profile, new Set()).rejections).toContain('Title does not match');
    expect(decide(rel('Paddington.1999.1080p.BluRay'), movie, profile, new Set()).rejections[0]).toMatch(/Year/);
    expect(decide(rel('Paddington.2014.720p.BluRay'), movie, profile, new Set()).rejections[0]).toMatch(/not allowed/);
    expect(decide(rel('Paddington.2014.FRENCH.1080p.BluRay'), movie, profile, new Set()).rejections[0]).toMatch(/Language/);
    expect(decide(rel('Paddington.2014.MULTi.1080p.BluRay'), movie, profile, new Set()).accepted).toBe(true);
  });

  it('only upgrades below the cutoff, and only to something better', () => {
    expect(decide(rel('Paddington.2014.1080p.BluRay'), { ...movie, currentQuality: 'WEBDL-1080p' }, profile, new Set()).accepted).toBe(true);
    expect(decide(rel('Paddington.2014.1080p.WEB-DL'), { ...movie, currentQuality: 'WEBDL-1080p' }, profile, new Set()).accepted).toBe(false);
    expect(decide(rel('Paddington.2014.2160p.WEB-DL'), { ...movie, currentQuality: 'Bluray-1080p' }, profile, new Set()).rejections[0]).toMatch(/cutoff/);
  });

  it('rejects blocklisted and dead torrents', () => {
    expect(decide(rel('Paddington.2014.1080p.BluRay'), movie, profile, new Set(['Paddington.2014.1080p.BluRay'])).accepted).toBe(false);
    expect(decide(rel('Paddington.2014.1080p.BluRay', { seeders: 0 }), movie, profile, new Set()).accepted).toBe(false);
  });

  it('skips CAM and telesync copies when asked to', () => {
    const cam = rel('Paddington.2014.1080p.HDCAM.x264');
    expect(decide(cam, movie, profile, new Set(), { skipCam: true }).rejections[0]).toMatch(/CAM copy/);
    expect(decide(cam, movie, profile, new Set(), { skipCam: false }).accepted).toBe(true);
  });

  it('matches episodes and season packs to wanted episodes', () => {
    const show = { kind: 'show' as const, title: 'Bluey', year: 2018, episodes: [{ season: 1, episode: 3, currentQuality: null }] };
    expect(decide(rel('Bluey.S01E03.1080p.WEB-DL'), show, profile, new Set()).accepted).toBe(true);
    expect(decide(rel('Bluey.S01E02.1080p.WEB-DL'), show, profile, new Set()).accepted).toBe(false);
    expect(decide(rel('Bluey.S01.1080p.WEB-DL'), show, profile, new Set()).covers).toEqual({ season: 1, episodes: [3] });
  });

  it('matches a news or talk show release named by the day it aired', () => {
    const show = { kind: 'show' as const, title: '20/20', year: 1978, episodes: [{ season: 48, episode: 7, currentQuality: null, airDate: '2025-10-17' }] };
    expect(decide(rel('20.20.2025.10.17.1080p.WEB.h264-BAE'), show, profile, new Set())).toMatchObject({ accepted: true, covers: { season: 48, episodes: [7] } });
    expect(decide(rel('20-20.2025.10.10.1080p.WEB.h264-BAE'), show, profile, new Set()).rejections).toContain('No wanted episode aired on 2025-10-10');
  });
});

describe('direct download safety', () => {
  it('recognises private addresses', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:192.168.0.1', '100.64.0.1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('blocks private, non-http and credentialed URLs', async () => {
    await expect(assertSafeUrl('http://127.0.0.1/x', false)).rejects.toThrow(/private/);
    await expect(assertSafeUrl('http://[::1]/x', false)).rejects.toThrow(/private/);
    // IPv4 inside IPv6, which URL parsing rewrites to hex ("::ffff:7f00:1").
    for (const u of ['http://[::ffff:127.0.0.1]:8080/x', 'http://[::ffff:169.254.169.254]/latest', 'http://[64:ff9b::10.0.0.1]/', 'http://[::ffff:0:192.168.1.1]/'])
      await expect(assertSafeUrl(u, false), u).rejects.toThrow(/private/);
    await expect(assertSafeUrl('http://[::ffff:8.8.8.8]/x', false)).resolves.toBeInstanceOf(URL);
    await expect(assertSafeUrl('file:///etc/passwd', false)).rejects.toThrow(/http/);
    await expect(assertSafeUrl('http://user:pw@8.8.8.8/x', false)).rejects.toThrow(/passwords/);
    await expect(assertSafeUrl('http://192.168.1.10/x', true)).resolves.toBeInstanceOf(URL);
  });
});

describe('request → download → import', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let owner: Client;
  let kid: Client;
  let media: string;
  let dl: string;
  const added: string[] = [];
  let qbitTorrents: Record<string, unknown>[] = [];

  beforeEach(async () => {
    t = await makeApp();
    owner = await setupOwner(t.app);
    media = path.join(t.dir, 'media');
    dl = path.join(t.dir, 'downloads');
    fs.mkdirSync(dl, { recursive: true });
    qbitTorrents = [];
    added.length = 0;
    fakeFetch({
      ...tmdbRoutes,
      [`${INDEXER}/api`]: (url: URL) =>
        new Response(
          url.searchParams.get('t') === 'tvsearch'
            ? torznab([{ title: 'Bluey.S01.1080p.WEB-DL.AAC2.0-GRP' }, { title: 'Bluey.S01E01.720p.HDTV' }])
            : torznab([
                { title: 'Paddington.2014.720p.BluRay.x264-LOW' },
                { title: 'Paddington.2014.1080p.BluRay.x264-SPARKS', seeders: 50 },
                { title: 'Paddington.2014.1080p.WEB-DL-NOSEED', seeders: 0 },
              ]),
        ),
      [`${INDEXER}/dl/`]: torrentFile,
      [`${QBIT}/api/v2/auth/login`]: () => new Response('Ok.', { headers: { 'set-cookie': 'SID=abc; path=/' } }),
      [`${QBIT}/api/v2/app/version`]: () => new Response('v5.0.0'),
      [`${QBIT}/api/v2/torrents/add`]: (_u: URL, init?: RequestInit) => {
        added.push(bodyText(init?.body));
        return new Response('Ok.');
      },
      [`${QBIT}/api/v2/torrents/info`]: () => qbitTorrents,
    });
    await owner.req('PUT', '/api/settings/metadata', { tmdbApiKey: 'k' });
    await owner.req('PUT', '/api/settings/media', { downloadsPath: dl, moviesPath: path.join(media, 'movies'), tvPath: path.join(media, 'tv') });
    expect((await owner.req('POST', '/api/indexers', { name: 'Test', type: 'torznab', url: INDEXER, apiKey: 'idx-key' })).statusCode).toBe(200);
    expect((await owner.req('POST', '/api/download-clients', { name: 'qBit', type: 'qbittorrent', url: QBIT, username: 'admin', password: 'pw' })).statusCode).toBe(200);
    const u = await createUser(owner, 'kid', 'user');
    kid = new Client(t.app);
    await kid.login('kid', u.password);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  const grabbed = () => (t.app.ctx.dbHandle.sqlite.prepare('SELECT title FROM downloads ORDER BY id').all() as { title: string }[]).map((r) => r.title);
  const profileId = async (name: string) => ((await owner.req('GET', '/api/profiles')).json() as { id: number; name: string }[]).find((p) => p.name === name)!.id;

  it('stores indexer and client secrets encrypted and never returns them', async () => {
    const raw = JSON.stringify(t.app.ctx.dbHandle.sqlite.prepare('SELECT * FROM indexers, download_clients').all());
    expect(raw).not.toContain('idx-key');
    expect(raw).not.toContain('"pw"');
    expect((await owner.req('GET', '/api/indexers')).body).not.toContain('idx-key');
    expect((await owner.req('POST', '/api/download-clients/1/test')).json()).toEqual({ ok: true, message: 'Connected to qBittorrent v5.0.0' });
  });

  it('a user request waits for approval, then downloads the best release and imports it', async () => {
    const r = (await kid.req('POST', '/api/requests', { kind: 'movie', tmdbId: 116149 })).json();
    expect(r.status).toBe('pending');
    expect(added).toHaveLength(0);
    // Users can't approve their own requests.
    expect((await kid.req('POST', `/api/requests/${r.id}/approve`, {})).statusCode).toBe(403);

    const approved = (await owner.req('POST', `/api/requests/${r.id}/approve`, {})).json();
    expect(approved.status).toBe('approved');
    await vi.waitFor(() => expect(added).toHaveLength(1));
    expect(grabbed()[0]).toBe('Paddington.2014.1080p.BluRay.x264-SPARKS');
    expect(added[0]).toContain('category=cinemask');
    expect(added[0]).toContain('tags=mm-1');

    // The client reports the download finished; the tracker imports it.
    const folder = path.join(dl, 'Paddington.2014.1080p.BluRay.x264-SPARKS');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'paddington.2014.1080p.bluray.x264-sparks.mkv'), 'video');
    fs.writeFileSync(path.join(folder, 'sample.mkv'), 's');
    qbitTorrents = [{ hash: 'h1', name: 'Paddington', progress: 1, state: 'stalledUP', size: 5, content_path: folder, save_path: dl, tags: 'mm-1' }];
    await trackDownloads(t.app.ctx);

    const dest = path.join(media, 'movies', 'Paddington (2014)', 'Paddington (2014) - Bluray-1080p.mkv');
    expect(fs.existsSync(dest)).toBe(true);
    // Hardlinked, so the torrent keeps seeding without using extra space.
    expect(fs.statSync(dest).nlink).toBe(2);
    const downloads = (await owner.req('GET', '/api/downloads?history=true')).json();
    expect(downloads[0]).toMatchObject({ status: 'imported', quality: 'Bluray-1080p' });
    expect((await kid.req('GET', '/api/requests')).json()[0].status).toBe('available');
    // In Recently added straight away, before Plex has scanned it.
    expect((await kid.req('GET', '/api/library/recent?kind=movie')).json().items).toEqual([expect.objectContaining({ kind: 'movie', tmdbId: 116149, title: 'Paddington' })]);
  });

  it('unpacks a download that arrived as an archive, and a manager can retry a failed import', async () => {
    const m = (await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, search: false })).json();
    const res = (await owner.req('GET', `/api/monitored/${m.id}/releases`)).json();
    await owner.req('POST', `/api/monitored/${m.id}/grab`, { guid: res.releases.find((r: { accepted: boolean }) => r.accepted).guid });
    const folder = path.join(dl, 'Paddington.2014.1080p.BluRay.x264-SPARKS');
    fs.mkdirSync(folder, { recursive: true });
    const archive = path.join(folder, 'Paddington.2014.1080p.BluRay.x264-SPARKS.7z');
    fs.writeFileSync(archive, 'packed');
    // The client reports the archive itself as the download, as SABnzbd does for a single-file job.
    qbitTorrents = [{ hash: 'h1', name: 'Paddington', progress: 1, state: 'stalledUP', size: 5, content_path: archive, save_path: dl, tags: 'mm-1' }];
    const history = async () => (await owner.req('GET', '/api/downloads?history=true')).json()[0];

    // With unpacking off, the import fails and says why.
    await owner.req('PUT', '/api/settings/media', { unpackArchives: false });
    await trackDownloads(t.app.ctx);
    expect(await history()).toMatchObject({ status: 'failed', error: expect.stringMatching(/packed in an archive.*Unpack archives/) });

    // A password-protected archive can't be unpacked.
    const unar = path.join(t.dir, 'unar');
    fs.writeFileSync(unar, '#!/bin/sh\necho "This archive requires a password to unpack." >&2\nexit 1\n', { mode: 0o755 });
    vi.stubEnv('UNAR_PATH', unar);
    await owner.req('PUT', '/api/settings/media', { unpackArchives: true });
    const d = await history();
    expect((await kid.req('POST', `/api/downloads/${d.id}/retry-import`)).statusCode).toBe(403);
    expect((await owner.req('POST', `/api/downloads/${d.id}/retry-import`)).json()).toEqual({ ok: true });
    await trackDownloads(t.app.ctx);
    expect(await history()).toMatchObject({ status: 'failed', error: expect.stringMatching(/Couldn't unpack .*\.7z: it is password-protected/) });

    // unar writes the video into a folder of its own, which goes once the movie is imported.
    fs.writeFileSync(unar, '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\necho video > "$2/paddington.2014.1080p.bluray.x264-sparks.mkv"\n', { mode: 0o755 });
    await owner.req('POST', `/api/downloads/${d.id}/retry-import`);
    await trackDownloads(t.app.ctx);
    expect(await history()).toMatchObject({ status: 'imported' });
    expect(fs.existsSync(path.join(media, 'movies', 'Paddington (2014)', 'Paddington (2014) - Bluray-1080p.mkv'))).toBe(true);
    expect(fs.existsSync(`${archive}_unpacked`)).toBe(false);
    expect(fs.existsSync(archive)).toBe(true);
    // Only failed downloads go back.
    expect((await owner.req('POST', `/api/downloads/${d.id}/retry-import`)).statusCode).toBe(400);
    vi.unstubAllEnvs();
  });

  it('managers skip approval', async () => {
    const r = (await owner.req('POST', '/api/requests', { kind: 'movie', tmdbId: 116149 })).json();
    expect(r.status).toBe('approved');
  });

  it('an admin can let a user download movies or shows without approval, each on its own', async () => {
    const kidId = (await owner.req('GET', '/api/users')).json().find((u: { username: string }) => u.username === 'kid').id;
    expect((await kid.req('PATCH', `/api/users/${kidId}`, { autoApproveMovies: true })).statusCode).toBe(403);
    expect((await owner.req('PATCH', `/api/users/${kidId}`, { autoApproveMovies: true })).json()).toMatchObject({ autoApproveMovies: true, autoApproveShows: false });
    expect((await kid.req('POST', '/api/requests', { kind: 'show', tmdbId: 82728 })).json().status).toBe('pending');
    const movie = (await kid.req('POST', '/api/requests', { kind: 'movie', tmdbId: 116149 })).json();
    expect(movie).toMatchObject({ status: 'approved', decidedByName: 'Auto-approved' });
    await vi.waitFor(() => expect(added).toHaveLength(1));
  });

  it('a request for a title that is already monitored keeps its profile and adds the seasons', async () => {
    const m = (await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, profileId: await profileId('HD-720p'), search: false })).json();
    // Monitored but not on the server: a user can still ask for it.
    const r = (await kid.req('POST', '/api/requests', { kind: 'movie', tmdbId: 116149 })).json();
    expect(r.status).toBe('pending');
    await owner.req('POST', `/api/requests/${r.id}/approve`, {});
    expect((await owner.req('GET', `/api/monitored/lookup/movie/116149`)).json().monitored).toMatchObject({ id: m.id, profileId: await profileId('HD-720p') });
  });

  it('users only see their own requests and cannot cancel others', async () => {
    const own = (await owner.req('POST', '/api/requests', { kind: 'show', tmdbId: 82728 })).json();
    expect((await kid.req('GET', '/api/requests')).json()).toHaveLength(0);
    expect((await kid.req('DELETE', `/api/requests/${own.id}`)).statusCode).toBe(403);
  });

  it('manual search shows rejections and only grabs releases it returned', async () => {
    const m = (await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, search: false })).json();
    const res = (await owner.req('GET', `/api/monitored/${m.id}/releases`)).json();
    const byTitle = Object.fromEntries(res.releases.map((r: { title: string; accepted: boolean; rejections: string[] }) => [r.title, r]));
    expect(byTitle['Paddington.2014.1080p.BluRay.x264-SPARKS'].accepted).toBe(true);
    expect(byTitle['Paddington.2014.1080p.WEB-DL-NOSEED'].rejections).toContain('No seeders');
    expect((await owner.req('POST', `/api/monitored/${m.id}/grab`, { guid: 'http://evil.example/x.torrent' })).statusCode).toBe(400);
    const guid = res.releases.find((r: { title: string }) => r.title.includes('720p')).guid;
    expect((await owner.req('POST', `/api/monitored/${m.id}/grab`, { guid })).statusCode).toBe(200);
    expect(grabbed()[0]).toContain('720p');
  });

  it("a manual search result can only be grabbed for the title it was found for", async () => {
    const movie = (await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, search: false })).json();
    const show = (await owner.req('POST', '/api/monitored', { kind: 'show', tmdbId: 82728, search: false })).json();
    const res = (await owner.req('GET', `/api/monitored/${movie.id}/releases`)).json();
    const guid = res.releases[0].guid;
    expect((await owner.req('POST', `/api/monitored/${show.id}/grab`, { guid })).statusCode).toBe(400);
    expect(grabbed()).toEqual([]);
  });

  it('shows speed, time left and queue totals from the download client', async () => {
    const m = (await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, search: false })).json();
    const res = (await owner.req('GET', `/api/monitored/${m.id}/releases`)).json();
    await owner.req('POST', `/api/monitored/${m.id}/grab`, { guid: res.releases.find((r: { accepted: boolean }) => r.accepted).guid });
    qbitTorrents = [{ hash: 'h1', name: 'Paddington', progress: 0.5, state: 'downloading', size: 100, save_path: dl, tags: 'mm-1', dlspeed: 2048, eta: 8640000 }];
    await trackDownloads(t.app.ctx);
    // qBittorrent's 8640000 means "unknown".
    expect((await owner.req('GET', '/api/downloads')).json()[0]).toMatchObject({ status: 'downloading', progress: 0.5, speed: 2048, eta: null });
    qbitTorrents[0]!.eta = 90;
    await trackDownloads(t.app.ctx);
    expect((await owner.req('GET', '/api/downloads')).json()[0].eta).toBe(90);
  });

  it('skips CAM copies by default', async () => {
    fakeFetch({ ...tmdbRoutes, [`${INDEXER}/api`]: () => new Response(torznab([{ title: 'Paddington.2014.1080p.HDCAM.x264-GRP', seeders: 90 }])) });
    const m = (await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, search: false })).json();
    expect((await owner.req('GET', `/api/monitored/${m.id}/releases`)).json().releases[0].accepted).toBe(false);
    await owner.req('PUT', '/api/settings/downloading', { skipCamReleases: false });
    expect((await owner.req('GET', `/api/monitored/${m.id}/releases`)).json().releases[0].accepted).toBe(true);
  });

  it('changing the profile reports upgrade candidates without grabbing anything', async () => {
    const m = (await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, profileId: await profileId('HD-720p'), search: false })).json();
    t.app.ctx.dbHandle.sqlite.prepare("UPDATE monitored SET file_path = '/x.mkv', file_quality = 'WEBDL-720p' WHERE id = ?").run(m.id);
    const res = (await owner.req('PATCH', `/api/monitored/${m.id}`, { profileId: await profileId('1080p or above') })).json();
    expect(res.upgradeCandidates).toBe(1);
    expect(added).toHaveLength(0);
  });

  it('imports movies and shows dropped in the watch folder, and leaves what it cannot match', async () => {
    fakeFetch({
      ...tmdbRoutes,
      'https://api.themoviedb.org/3/search/movie': (u: URL) => ({ results: u.searchParams.get('query') === 'Paddington' ? [{ id: 116149, title: 'Paddington' }] : [] }),
      'https://api.themoviedb.org/3/search/tv': (u: URL) => ({ results: u.searchParams.get('query') === 'Bluey' ? [{ id: 82728, name: 'Bluey' }] : [] }),
    });
    const watch = path.join(t.dir, 'watch');
    const old = (Date.now() - 10 * 60 * 1000) / 1000;
    const drop = (rel: string) => {
      const f = path.join(watch, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, 'video');
      fs.utimesSync(f, old, old);
    };
    drop('Paddington (2014)/Paddington.2014.1080p.BluRay.mkv');
    drop('Paddington (2014)/movie.nfo');
    drop('Bluey/Season 1/Bluey.S01E02.720p.WEB-DL.mkv');
    drop('Nothing.Like.This.2099.mkv');
    const fresh = path.join(watch, 'Still.Copying.2014.mkv');
    fs.writeFileSync(fresh, 'part');

    // Off until a folder is set, and never a library folder itself.
    expect(await scanWatchFolder(t.app.ctx)).toBe(0);
    await owner.req('PUT', '/api/settings/media', { watchFolder: path.join(media, 'movies') });
    expect(await scanWatchFolder(t.app.ctx)).toBe(0);
    await owner.req('PUT', '/api/settings/media', { watchFolder: watch });
    expect(await scanWatchFolder(t.app.ctx)).toBe(2);

    expect(fs.existsSync(path.join(media, 'movies', 'Paddington (2014)', 'Paddington (2014) - Bluray-1080p.mkv'))).toBe(true);
    expect(fs.readdirSync(path.join(media, 'tv', 'Bluey (2018)', 'Season 01'))).toHaveLength(1);
    // Moved, not copied; the leftover .nfo went with its folder. The unmatched and half-copied files stay.
    expect(fs.readdirSync(watch).sort()).toEqual(['Nothing.Like.This.2099.mkv', 'Still.Copying.2014.mkv']);
    const history = (await owner.req('GET', '/api/downloads?history=true')).json();
    expect(history.find((d: { title: string }) => d.title === 'Nothing.Like.This.2099.mkv')).toMatchObject({ status: 'failed', indexer: 'Watch folder' });
    // An unmatched drop isn't retried until it changes.
    expect(await scanWatchFolder(t.app.ctx)).toBe(0);
    expect((await owner.req('GET', '/api/downloads?history=true')).json()).toHaveLength(history.length);
    // Nor after a restart, which forgets what failed.
    forgetWatchFailures();
    expect(await scanWatchFolder(t.app.ctx)).toBe(0);
    expect((await owner.req('GET', '/api/downloads?history=true')).json()).toHaveLength(history.length);

    // A second copy of something already in the library says so, and is left for Downloads → Import.
    drop('Paddington.2014.1080p.BluRay.mkv');
    expect(await scanWatchFolder(t.app.ctx)).toBe(0);
    const dup = (await owner.req('GET', '/api/downloads?history=true')).json().find((d: { title: string }) => d.title === 'Paddington.2014.1080p.BluRay.mkv');
    expect(dup.error).toMatch(/already in the library/);
    expect(fs.existsSync(path.join(watch, 'Paddington.2014.1080p.BluRay.mkv'))).toBe(true);
  });

  it('imports a file by hand as a movie or an episode, only from the downloads or watch folder', async () => {
    const movie = path.join(dl, 'stuck', 'weird name.mkv');
    const ep = path.join(dl, 'bluey-pilot.mkv');
    fs.mkdirSync(path.dirname(movie), { recursive: true });
    fs.writeFileSync(movie, 'movie');
    fs.writeFileSync(ep, 'episode');
    expect((await kid.req('GET', '/api/manual-import')).statusCode).toBe(403);
    const list = (await owner.req('GET', '/api/manual-import')).json();
    expect(list.files.map((f: { name: string }) => f.name).sort()).toEqual(['bluey-pilot.mkv', path.join('stuck', 'weird name.mkv')]);

    expect((await kid.req('POST', '/api/manual-import', { path: movie, kind: 'movie', tmdbId: 116149 })).statusCode).toBe(403);
    expect((await owner.req('POST', '/api/manual-import', { path: '/etc/passwd', kind: 'movie', tmdbId: 116149 })).statusCode).toBe(400);
    expect((await owner.req('POST', '/api/manual-import', { path: ep, kind: 'show', tmdbId: 82728 })).statusCode).toBe(400);

    const r = (await owner.req('POST', '/api/manual-import', { path: movie, kind: 'movie', tmdbId: 116149, mode: 'move' })).json();
    expect(r.imported).toEqual([path.join(media, 'movies', 'Paddington (2014)', 'Paddington (2014) - Unknown.mkv')]);
    expect(fs.existsSync(movie)).toBe(false);
    await owner.req('POST', '/api/manual-import', { path: ep, kind: 'show', tmdbId: 82728, season: 1, episodes: [1], mode: 'copy' });
    expect(fs.readdirSync(path.join(media, 'tv', 'Bluey (2018)', 'Season 01'))).toHaveLength(1);
    expect(fs.existsSync(ep)).toBe(true);
    const history = (await owner.req('GET', '/api/downloads?history=true')).json();
    expect(history.filter((d: { indexer: string; status: string }) => d.indexer === 'Manual import' && d.status === 'imported')).toHaveLength(2);
  });

  it('a finished download the client never gives a folder for fails after a while instead of sitting there', async () => {
    await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, search: true });
    await vi.waitFor(() => expect(added).toHaveLength(1));
    qbitTorrents = [{ hash: 'h1', name: 'Paddington', progress: 1, state: 'uploading', size: 5, content_path: '', save_path: '', tags: 'mm-1' }];
    await trackDownloads(t.app.ctx);
    expect((await owner.req('GET', '/api/downloads')).json()[0].status).toBe('completed');
    t.app.ctx.dbHandle.sqlite.prepare('UPDATE downloads SET completed_at = ?').run(Date.now() - 31 * 60 * 1000);
    await trackDownloads(t.app.ctx);
    const [d] = (await owner.req('GET', '/api/downloads?history=true')).json();
    expect(d.status).toBe('failed');
    expect(d.error).toMatch(/Downloads → Import/);
  });

  it('finds a finished download by name when the client reports a folder Cinemask can\'t see', async () => {
    await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, search: true });
    await vi.waitFor(() => expect(added).toHaveLength(1));
    // qBittorrent saved it under its own /data/Movies; here it is in the downloads folder's movies category.
    fs.mkdirSync(path.join(dl, 'movies'), { recursive: true });
    fs.writeFileSync(path.join(dl, 'movies', 'Paddington.2014.1080p.BluRay.x264-SPARKS.mkv'), 'movie');
    qbitTorrents = [{ hash: 'h1', name: 'Paddington', progress: 1, state: 'uploading', size: 5, content_path: '/data/Movies/Paddington.2014.1080p.BluRay.x264-SPARKS.mkv', save_path: '/data/Movies', tags: 'mm-1' }];
    await trackDownloads(t.app.ctx);
    expect((await owner.req('GET', '/api/downloads?history=true')).json()[0].status).toBe('imported');
    expect(fs.readdirSync(path.join(media, 'movies', 'Paddington (2014)'))).toHaveLength(1);

    // Nowhere to be found: the message says which client folder to map.
    expect(() => importDownload(t.app.ctx, 1, '/data/Movies/Gone.mkv')).toThrow(/mapping in Settings → Media management from \/data\/Movies/);
  });

  it('clears history, deletes files from the import list, and finds and deletes duplicate copies', async () => {
    const m = (await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, search: false })).json();
    const db = t.app.ctx.dbHandle.sqlite;
    const add = (status: string) => db.prepare("INSERT INTO downloads (title, protocol, status, added_at) VALUES ('x', 'torrent', ?, 1)").run(status);
    ['imported', 'failed', 'removed', 'queued'].forEach(add);
    expect((await kid.req('DELETE', '/api/downloads/history')).statusCode).toBe(403);
    expect((await owner.req('DELETE', '/api/downloads/history?only=failed')).json().cleared).toBe(2);
    expect((await owner.req('DELETE', '/api/downloads/history')).json().cleared).toBe(1);
    expect((db.prepare('SELECT status FROM downloads').all() as { status: string }[]).map((r) => r.status)).toEqual(['queued']);

    // Deleting from the import list takes the release folder's leftovers with its last video.
    const rel = path.join(dl, 'Some.Release.2014');
    fs.mkdirSync(rel, { recursive: true });
    fs.writeFileSync(path.join(rel, 'some.release.mkv'), 'v');
    fs.writeFileSync(path.join(rel, 'info.nfo'), 'n');
    expect((await kid.req('POST', '/api/manual-import/delete', { path: path.join(rel, 'some.release.mkv') })).statusCode).toBe(403);
    expect((await owner.req('POST', '/api/manual-import/delete', { path: path.join(media, 'x.mkv') })).statusCode).toBe(400);
    expect((await owner.req('POST', '/api/manual-import/delete', { path: path.join(rel, 'some.release.mkv') })).statusCode).toBe(200);
    expect(fs.existsSync(rel)).toBe(false);

    // Two copies of the movie (the trailer doesn't count); deleting one leaves the other tracked.
    const folder = path.join(media, 'movies', 'Paddington (2014)');
    fs.mkdirSync(folder, { recursive: true });
    const a = path.join(folder, 'Paddington.2014.1080p.BluRay.mkv');
    const b = path.join(folder, 'Paddington.2014.720p.WEB-DL.mkv');
    for (const f of [a, b, path.join(folder, 'Paddington-trailer.mkv')]) fs.writeFileSync(f, 'v');
    await owner.req('POST', `/api/monitored/${m.id}/scan`);
    expect((await kid.req('GET', '/api/duplicates')).statusCode).toBe(403);
    const dupes = (await owner.req('GET', '/api/duplicates')).json();
    expect(dupes.files).toHaveLength(1);
    expect(dupes.files[0].files.map((f: { path: string }) => f.path).sort()).toEqual([a, b]);
    expect((await owner.req('POST', '/api/duplicates/delete', { monitoredId: m.id, path: '/etc/passwd' })).statusCode).toBe(400);
    expect((await owner.req('POST', '/api/duplicates/delete', { monitoredId: m.id, path: a })).statusCode).toBe(200);
    expect(fs.existsSync(a)).toBe(false);
    expect((await owner.req('GET', '/api/duplicates')).json().files).toEqual([]);
    expect((await owner.req('GET', `/api/monitored/${m.id}/files`)).json().files[0]).toMatchObject({ path: b, exists: true });
    // The last copy can't be deleted from here.
    expect((await owner.req('POST', '/api/duplicates/delete', { monitoredId: m.id, path: b })).statusCode).toBe(400);
  });

  it('the upgrades switch stops replacing downloaded files, whatever the profile allows', async () => {
    await owner.req('PUT', '/api/settings/downloading', { upgrades: false });
    const m = (await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, profileId: await profileId('1080p or above'), search: false })).json();
    t.app.ctx.dbHandle.sqlite.prepare("UPDATE monitored SET file_path = '/x.mkv', file_quality = 'WEBDL-720p' WHERE id = ?").run(m.id);
    expect((await owner.req('POST', `/api/monitored/${m.id}/search`, {})).json().grabbed).toBe(0);
    expect(added).toHaveLength(0);
    await owner.req('PUT', '/api/settings/downloading', { upgrades: true });
    expect((await owner.req('POST', `/api/monitored/${m.id}/search`, {})).json().grabbed).toBe(1);
  });

  it('grabs a season pack for a show and imports each episode with the naming format', async () => {
    await owner.req('PUT', '/api/settings/naming', { seasonFolder: 'Season {season}', episodeFile: '{Series Title} - S{season:00}E{episode:00} - {Episode Title}' });
    await owner.req('POST', '/api/monitored', { kind: 'show', tmdbId: 82728, search: true });
    await vi.waitFor(() => expect(added).toHaveLength(1));
    expect(grabbed()[0]).toBe('Bluey.S01.1080p.WEB-DL.AAC2.0-GRP');
    const folder = path.join(dl, 'Bluey.S01.1080p.WEB-DL');
    fs.mkdirSync(folder, { recursive: true });
    for (const n of [1, 2, 3]) fs.writeFileSync(path.join(folder, `Bluey.S01E0${n}.1080p.WEB-DL.mkv`), `ep${n}`);
    qbitTorrents = [{ hash: 'h2', name: 'Bluey', progress: 1, state: 'uploading', size: 5, content_path: folder, save_path: dl, tags: 'mm-1' }];
    await trackDownloads(t.app.ctx);
    const season = path.join(media, 'tv', 'Bluey (2018)', 'Season 1');
    expect(fs.readdirSync(season).sort()).toEqual(['Bluey - S01E01 - Ep 1.mkv', 'Bluey - S01E02 - Ep 2.mkv', 'Bluey - S01E03 - Ep 3.mkv']);
  });

  const indexerReturns = (items: { title: string; seeders?: number; size?: number }[]) =>
    fakeFetch({
      ...tmdbRoutes,
      [`${INDEXER}/api`]: () => new Response(torznab(items)),
      [`${INDEXER}/dl/`]: torrentFile,
      [`${QBIT}/api/v2/auth/login`]: () => new Response('Ok.', { headers: { 'set-cookie': 'SID=abc; path=/' } }),
      [`${QBIT}/api/v2/torrents/add`]: (_u: URL, init?: RequestInit) => {
        added.push(bodyText(init?.body));
        return new Response('Ok.');
      },
      [`${QBIT}/api/v2/torrents/info`]: () => qbitTorrents,
    });

  it('prefers releases within the size limit, and warns when only bigger ones exist', async () => {
    indexerReturns([
      { title: 'Paddington.2014.1080p.BluRay.x264-BIG', size: 8 * 1024 ** 3, seeders: 90 },
      { title: 'Paddington.2014.1080p.WEB-DL-SMALL', size: 3 * 1024 ** 3 },
    ]);
    await owner.req('PUT', '/api/settings/downloading', { maxMovieSizeGb: 4 });
    const m = (await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, search: true })).json();
    await vi.waitFor(() => expect(grabbed()).toEqual(['Paddington.2014.1080p.WEB-DL-SMALL']));
    const manual = (await owner.req('GET', `/api/monitored/${m.id}/releases`)).json().releases;
    expect(manual.find((r: { title: string }) => r.title.endsWith('BIG')).oversize).toBe(8 * 1024 ** 3);

    // This title's own limit (2 GB) leaves nothing within it: the best one is grabbed with a warning.
    await owner.req('DELETE', '/api/downloads/1');
    await owner.req('PATCH', `/api/monitored/${m.id}`, { maxSizeMb: 2048 });
    expect((await owner.req('POST', `/api/monitored/${m.id}/search`, {})).json().grabbed).toBe(1);
    const dl2 = (await owner.req('GET', '/api/downloads')).json()[0];
    expect(dl2.title).toBe('Paddington.2014.1080p.BluRay.x264-BIG');
    expect(dl2.warning).toMatch(/Bigger than the 2\.0 GB limit: 8\.0 GB/);
  });

  it('holds an oversize pick until a manager confirms it, or skips it, as set', async () => {
    indexerReturns([{ title: 'Paddington.2014.1080p.BluRay.x264-BIG', size: 8 * 1024 ** 3, seeders: 90 }]);
    await owner.req('PUT', '/api/settings/downloading', { maxMovieSizeGb: 4, oversize: 'skip' });
    const m = (await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149 })).json();
    expect((await owner.req('POST', `/api/monitored/${m.id}/search`, {})).json().grabbed).toBe(0);
    expect(grabbed()).toEqual([]);

    await owner.req('PUT', '/api/settings/downloading', { oversize: 'ask' });
    await owner.req('POST', `/api/monitored/${m.id}/search`, {});
    const held = (await owner.req('GET', '/api/downloads')).json()[0];
    expect(held).toMatchObject({ status: 'held', title: 'Paddington.2014.1080p.BluRay.x264-BIG' });
    expect(held.heldRelease).toBeUndefined();
    expect(added).toHaveLength(0);
    // Searching again doesn't hold a second copy.
    await owner.req('POST', `/api/monitored/${m.id}/search`, {});
    expect(grabbed()).toHaveLength(1);

    expect((await kid.req('POST', `/api/downloads/${held.id}/confirm`)).statusCode).toBe(403);
    expect((await owner.req('POST', `/api/downloads/${held.id}/confirm`)).statusCode).toBe(200);
    expect(added).toHaveLength(1);
    expect(added[0]).toContain('torrents=mm-');
    const [sent] = (await owner.req('GET', '/api/downloads')).json();
    expect(sent).toMatchObject({ status: 'queued', title: 'Paddington.2014.1080p.BluRay.x264-BIG' });
    expect(sent.warning).toMatch(/Bigger than/);
    expect((await owner.req('POST', `/api/downloads/${held.id}/confirm`)).statusCode).toBe(404);
  });

  it('puts titles in their own root folder with its own download category, and moves them between folders', async () => {
    const kids = path.join(media, 'kids-movies');
    await owner.req('PUT', '/api/settings/media', { extraFolders: [{ id: 'kids', name: 'Kids Movies', kind: 'movie', path: kids, category: 'kids-movies' }] });
    expect((await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, rootId: 'nope' })).statusCode).toBe(400);
    const m = (await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, rootId: 'kids', search: true })).json();
    await vi.waitFor(() => expect(added).toHaveLength(1));
    expect(added[0]).toContain('category=kids-movies');

    const folder = path.join(dl, 'Paddington.2014.1080p.BluRay.x264-SPARKS');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'paddington.mkv'), 'video');
    qbitTorrents = [{ hash: 'h1', name: 'Paddington', progress: 1, state: 'stalledUP', size: 5, content_path: folder, save_path: dl, tags: 'mm-1' }];
    await trackDownloads(t.app.ctx);
    const inKids = path.join(kids, 'Paddington (2014)', 'Paddington (2014) - Bluray-1080p.mkv');
    expect(fs.existsSync(inKids)).toBe(true);

    expect((await owner.req('PATCH', `/api/monitored/${m.id}`, { rootId: 'default' })).statusCode).toBe(200);
    const moved = path.join(media, 'movies', 'Paddington (2014)', 'Paddington (2014) - Bluray-1080p.mkv');
    expect(fs.existsSync(moved)).toBe(true);
    expect(fs.existsSync(inKids)).toBe(false);
    expect((await owner.req('GET', `/api/monitored/${m.id}/files`)).json().files[0]).toMatchObject({ path: moved, exists: true });
  });

  it('downloads a link under a chosen name into a chosen folder', async () => {
    fakeFetch({
      'http://files.example/clip.mkv': () => new Response('home video', { headers: { 'content-length': '10' } }),
      [`${INDEXER}/dl/`]: torrentFile,
      [`${QBIT}/api/v2/auth/login`]: () => new Response('Ok.', { headers: { 'set-cookie': 'SID=abc; path=/' } }),
      [`${QBIT}/api/v2/torrents/add`]: (_u: URL, init?: RequestInit) => {
        added.push(bodyText(init?.body));
        return new Response('Ok.');
      },
      [`${QBIT}/api/v2/torrents/info`]: () => qbitTorrents,
    });
    await owner.req('PUT', '/api/settings/downloading', { allowPrivateDirectUrls: true });
    expect((await owner.req('POST', '/api/downloads/direct', { url: 'http://files.example/clip.mkv', destination: 'movie:nowhere' })).statusCode).toBe(400);
    expect((await owner.req('POST', '/api/downloads/direct', { url: 'file:///etc/passwd' })).statusCode).toBe(400);

    const destinations = (await owner.req('GET', '/api/root-folders')).json().destinations.map((d: { key: string }) => d.key);
    expect(destinations).toEqual(['downloads', 'movie:default', 'show:default', 'audiobooks', 'books']);
    const { id } = (await owner.req('POST', '/api/downloads/direct', { url: 'http://files.example/clip.mkv', name: 'Beach Day', destination: 'movie:default' })).json();
    await vi.waitFor(async () => expect((await owner.req('GET', '/api/downloads?history=true')).json().find((d: { id: number }) => d.id === id).status).toBe('imported'));
    expect(fs.readFileSync(path.join(media, 'movies', 'Beach Day.mkv'), 'utf8')).toBe('home video');

    // A magnet link goes to the torrent client and is delivered when it finishes.
    const magnet = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Show.Pilot';
    const m = (await owner.req('POST', '/api/downloads/direct', { url: magnet, name: 'Pilot', destination: 'show:default' })).json();
    expect(added.at(-1)).toContain('urls=magnet');
    const folder = path.join(dl, 'Show.Pilot');
    fs.mkdirSync(path.join(folder, 'extras'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'pilot.mkv'), 'ep');
    fs.writeFileSync(path.join(folder, 'extras', 'bts.mkv'), 'bts');
    qbitTorrents = [{ hash: '0123456789abcdef0123456789abcdef01234567', name: 'Show.Pilot', progress: 1, state: 'uploading', size: 5, content_path: folder, save_path: dl, tags: `mm-${m.id}` }];
    await trackDownloads(t.app.ctx);
    expect(fs.readFileSync(path.join(media, 'tv', 'Pilot', 'pilot.mkv'), 'utf8')).toBe('ep');
    expect(fs.existsSync(path.join(media, 'tv', 'Pilot', 'extras', 'bts.mkv'))).toBe(true);
  });

  it('searches the indexers for anything and delivers a result to the folder picked', async () => {
    expect((await kid.req('GET', '/api/indexers/search?q=paddington')).statusCode).toBe(403);
    // What was typed comes first, ahead of better-seeded releases that only contain it.
    const prev = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) =>
      new URL(String(input)).searchParams.get('q') === '48 hours'
        ? new Response(torznab([{ title: 'Travel.Man.48.Hours.In.S13E02.1080p.HDTV', seeders: 79 }, { title: '48.Hours.S36E07.WEBRip.x264-XENON', seeders: 21 }]))
        : prev(input, init),
    );
    expect((await owner.req('GET', '/api/indexers/search?q=48%20hours&type=tv')).json().releases.map((r: { title: string }) => r.title)).toEqual(['48.Hours.S36E07.WEBRip.x264-XENON', 'Travel.Man.48.Hours.In.S13E02.1080p.HDTV']);
    const found = (await owner.req('GET', '/api/indexers/search?q=paddington&type=movies')).json();
    expect(found.releases[0]).toMatchObject({ title: 'Paddington.2014.1080p.BluRay.x264-SPARKS', quality: 'Bluray-1080p', seeders: 50 });
    // Only a guid from the search can be sent, never a URL.
    expect((await owner.req('POST', '/api/downloads/release', { guid: 'http://evil.example/x.torrent' })).statusCode).toBe(400);
    expect((await owner.req('POST', '/api/downloads/release', { guid: found.releases[0].guid, destination: 'movie:nowhere' })).statusCode).toBe(400);
    const { downloadId } = (await owner.req('POST', '/api/downloads/release', { guid: found.releases[0].guid, destination: 'movie:default', name: 'Paddington (2014)' })).json();
    expect(added.at(-1)).toContain(`tags=mm-${downloadId}`);
    const folder = path.join(dl, 'Paddington.2014.1080p.BluRay.x264-SPARKS');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'paddington.mkv'), 'video');
    qbitTorrents = [{ hash: 'h9', name: 'Paddington', progress: 1, state: 'uploading', size: 5, content_path: folder, save_path: dl, tags: `mm-${downloadId}` }];
    await trackDownloads(t.app.ctx);
    expect(fs.readFileSync(path.join(media, 'movies', 'Paddington (2014)', 'paddington.mkv'), 'utf8')).toBe('video');
    expect((await owner.req('GET', '/api/downloads?history=true')).json().find((d: { id: number }) => d.id === downloadId).status).toBe('imported');
    expect(found.releases.every((r: { guid: string }) => /^[0-9a-f]{32}$/.test(r.guid))).toBe(true);

    // Left in the downloads folder, the client's copy is the only one, so "remove completed" leaves it alone.
    await owner.req('PUT', '/api/settings/media', { removeCompletedDownloads: true, importMode: 'copy' });
    const removed: string[] = [];
    fakeFetch({
      [`${INDEXER}/api`]: () => new Response(torznab([{ title: 'Home.Movies.2020' }])),
      [`${INDEXER}/dl/`]: torrentFile,
      [`${QBIT}/api/v2/auth/login`]: () => new Response('Ok.', { headers: { 'set-cookie': 'SID=abc; path=/' } }),
      [`${QBIT}/api/v2/torrents/add`]: () => new Response('Ok.'),
      [`${QBIT}/api/v2/torrents/delete`]: (_u: URL, init?: RequestInit) => (removed.push(String(init?.body)), new Response('')),
      [`${QBIT}/api/v2/torrents/info`]: () => qbitTorrents,
    });
    const home = (await owner.req('GET', '/api/indexers/search?q=home')).json().releases[0];
    const kept = (await owner.req('POST', '/api/downloads/release', { guid: home.guid })).json().downloadId;
    qbitTorrents = [{ hash: 'h10', name: 'Home', progress: 1, state: 'uploading', size: 5, content_path: folder, save_path: dl, tags: `mm-${kept}` }];
    await trackDownloads(t.app.ctx);
    expect((await owner.req('GET', '/api/downloads?history=true')).json().find((d: { id: number }) => d.id === kept).status).toBe('completed');
    expect(removed).toEqual([]);
  });

  it('RSS sync grabs a new release for a monitored title', async () => {
    await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, search: false });
    const r = await rssSync(t.app.ctx);
    expect(r.grabbed).toBe(1);
    expect(grabbed()[0]).toBe('Paddington.2014.1080p.BluRay.x264-SPARKS');
  });

  it('a failed download is blocklisted and another release is tried', async () => {
    await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, profileId: await profileId('Any'), search: true });
    await vi.waitFor(() => expect(added).toHaveLength(1));
    qbitTorrents = [{ hash: 'h1', name: 'x', progress: 0.1, state: 'error', size: 5, save_path: dl, tags: 'mm-1' }];
    await trackDownloads(t.app.ctx);
    expect(grabbed()).toEqual(['Paddington.2014.1080p.BluRay.x264-SPARKS', 'Paddington.2014.720p.BluRay.x264-LOW']);
    expect((await owner.req('GET', '/api/downloads?history=true')).json().find((d: { id: number }) => d.id === 1).status).toBe('failed');
  });
});

describe('qBittorrent sign-in', () => {
  afterEach(() => vi.unstubAllGlobals());
  const qbit = () => createClient({ type: 'qbittorrent', name: 'qBittorrent', url: 'http://qbit.local:8080', username: 'admin', password: 'pw' });

  it('accepts qBittorrent 5.2, which answers a good sign-in with 204 and no body', async () => {
    fakeFetch({
      'http://qbit.local:8080/api/v2/auth/login': () => new Response(null, { status: 204, headers: { 'set-cookie': 'QBT_SID_8080=abc; path=/' } }),
      'http://qbit.local:8080/api/v2/app/version': (_u, init) => new Response((init?.headers as Record<string, string>).Cookie === 'QBT_SID_8080=abc' ? 'v5.2.0' : 'Forbidden', { status: 200 }),
    });
    expect(await qbit().test()).toContain('v5.2.0');
  });

  it('says so when the password is wrong, or when qBittorrent has blocked it', async () => {
    fakeFetch({ 'http://qbit.local:8080/api/v2/auth/login': () => new Response('Fails.') });
    await expect(qbit().test()).rejects.toThrow('login was rejected');
    fakeFetch({ 'http://qbit.local:8080/api/v2/auth/login': () => new Response('Your IP address has been banned after too many failed authentication attempts.', { status: 403 }) });
    await expect(qbit().test()).rejects.toThrow(/blocked Cinemask/);
    fakeFetch({ 'http://qbit.local:8080/api/v2/auth/login': () => new Response('<html><body>Access denied</body></html>', { status: 403 }) });
    await expect(qbit().test()).rejects.toThrow(/proxy in front of it/);
  });

  it('signs in without a Referer, so a reverse proxy in front of qBittorrent passes its cross-site check', async () => {
    const { fn } = fakeFetch({
      'http://qbit.local:8080/api/v2/auth/login': () => new Response('Ok.', { headers: { 'set-cookie': 'SID=abc; path=/' } }),
      'http://qbit.local:8080/api/v2/app/version': () => new Response('v5.0.0'),
    });
    await qbit().test();
    for (const [, init] of fn.mock.calls) {
      const h = (init?.headers ?? {}) as Record<string, string>;
      expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain('referer');
      expect(h['user-agent']).toBe('Cinemask');
    }
  });
});

describe('episode size by length', () => {
  it('picks the limit for the show’s episode length, falling back to the flat limit', async () => {
    const t = await makeApp();
    try {
      const owner = await setupOwner(t.app);
      const show = (tmdbId: number, runtime: number | null) => {
        ensureMedia(t.app.ctx, 'show', tmdbId, { title: `Show ${tmdbId}` });
        t.app.ctx.dbHandle.sqlite.prepare('update media set runtime = ? where kind = ? and tmdb_id = ?').run(runtime, 'show', tmdbId);
        return { kind: 'show' as const, tmdbId, maxSizeMb: null };
      };
      const GB = 1024 ** 3;
      await owner.req('PUT', '/api/settings/downloading', { maxEpisodeSizeGb: 3, episodeSizeByRuntime: [{ minutes: 60, gb: 1.5 }, { minutes: 30, gb: 0.8 }, { minutes: 90, gb: 2 }] });
      expect(maxSizeFor(t.app.ctx, show(1, 22))).toBe(0.8 * GB);
      expect(maxSizeFor(t.app.ctx, show(2, 45))).toBe(1.5 * GB);
      expect(maxSizeFor(t.app.ctx, show(3, 88))).toBe(2 * GB);
      expect(maxSizeFor(t.app.ctx, show(4, 140))).toBe(2 * GB); // longer than every row: the last one
      expect(maxSizeFor(t.app.ctx, show(5, null))).toBe(3 * GB); // length unknown: the flat limit
      expect(maxSizeFor(t.app.ctx, { ...show(6, 22), maxSizeMb: 500 })).toBe(500 * 1024 ** 2); // the show's own limit wins
      expect((await owner.req('PUT', '/api/settings/downloading', { episodeSizeByRuntime: [{ minutes: 0, gb: 1 }] })).statusCode).toBe(400);
    } finally {
      await t.close();
    }
  });
});

describe('torrent files', () => {
  it('hashes the info dictionary the way clients do', async () => {
    const { torrentHash } = await import('../src/server/arr/clients.js');
    const { createHash } = await import('node:crypto');
    const info = 'd6:lengthi5e4:name4:test12:piece lengthi16384e6:pieces0:e';
    const file = Buffer.from(`d8:announce14:http://t.local4:info${info}e`);
    expect(torrentHash(file)).toBe(createHash('sha1').update(info).digest('hex'));
  });
});

describe('SABnzbd tracking', () => {
  afterEach(() => vi.unstubAllGlobals());
  const sab = () => createClient({ type: 'sabnzbd', name: 'SABnzbd', url: 'http://sab.local:8080', password: 'key' });

  it('finds a job by id after SABnzbd moved it to another category, and counts unpacking as downloaded', async () => {
    fakeFetch({
      'http://prowlarr.local/1/download': () => new Response('<nzb></nzb>', { headers: { 'content-type': 'application/x-nzb' } }),
      'http://sab.local:8080/api': (url, init) => {
        const p = url.searchParams;
        if (p.get('mode') === 'addfile') {
          // Cinemask fetches the NZB itself and uploads it, so SABnzbd never needs to reach the indexer.
          expect(p.get('nzbname')).toBe('Paddington.2014.1080p');
          expect(bodyText(init?.body)).toBe('name=Paddington.2014.1080p.nzb');
          return { status: true, nzo_ids: ['SABnzbd_nzo_a'] };
        }
        if (p.get('mode') === 'queue') return { queue: { slots: [] } };
        // The category filter misses both jobs: they landed in the default category.
        if (p.get('category')) return { history: { slots: [] } };
        expect(p.get('nzo_ids')).toBe('SABnzbd_nzo_a,SABnzbd_nzo_b');
        return {
          history: {
            slots: [
              { nzo_id: 'SABnzbd_nzo_a', name: 'Paddington.2014.1080p', status: 'Completed', storage: '/downloads/Paddington.2014.1080p', bytes: 10, category: '*', fail_message: '' },
              { nzo_id: 'SABnzbd_nzo_b', name: 'Other', status: 'Extracting', storage: '', bytes: 10, category: '*', fail_message: '' },
            ],
          },
        };
      },
    });
    expect(await sab().add('http://prowlarr.local/1/download', { category: 'cinemask', tag: 'mm-7', title: 'Paddington.2014.1080p' })).toBe('SABnzbd_nzo_a');
    const items = await sab().list('cinemask', ['SABnzbd_nzo_a', 'SABnzbd_nzo_b']);
    expect(items.map((i) => [i.id, i.status, i.progress, i.outputPath])).toEqual([
      ['SABnzbd_nzo_a', 'completed', 1, '/downloads/Paddington.2014.1080p'],
      ['SABnzbd_nzo_b', 'downloading', 1, null],
    ]);
  });
});

describe('connection errors', () => {
  it('say why a connection failed, without the address', async () => {
    const { connectError } = await import('../src/server/integrations/http.js');
    const fail = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
    expect(connectError(fail('ECONNREFUSED'))).toMatch(/refused/);
    expect(connectError(fail('ENOTFOUND'))).toMatch(/DNS/);
    expect(connectError(fail('DEPTH_ZERO_SELF_SIGNED_CERT'))).toMatch(/certificate/);
    expect(connectError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toMatch(/timed out/);
    fakeFetch({});
    vi.stubGlobal('fetch', async () => {
      throw fail('EHOSTUNREACH');
    });
    const sab = createClient({ type: 'sabnzbd', name: 'SABnzbd', url: 'http://sab.local:8080', password: 'secret-key' });
    const err = await sab.test().catch((e: Error) => e);
    expect(String(err)).toMatch(/SABnzbd: could not connect: that address isn't reachable/);
    expect(String(err)).not.toContain('secret-key');
    vi.unstubAllGlobals();
  });
});
