import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decide } from '../src/server/arr/decision.js';
import { assertSafeUrl, isPrivateAddress } from '../src/server/arr/direct.js';
import { parseFeed, type Release } from '../src/server/arr/indexers.js';
import { trackDownloads } from '../src/server/arr/tracker.js';
import { rssSync } from '../src/server/arr/rss.js';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { fakeFetch, tmdbRoutes } from './fakes.js';

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

  it('matches episodes and season packs to wanted episodes', () => {
    const show = { kind: 'show' as const, title: 'Bluey', year: 2018, episodes: [{ season: 1, episode: 3, currentQuality: null }] };
    expect(decide(rel('Bluey.S01E03.1080p.WEB-DL'), show, profile, new Set()).accepted).toBe(true);
    expect(decide(rel('Bluey.S01E02.1080p.WEB-DL'), show, profile, new Set()).accepted).toBe(false);
    expect(decide(rel('Bluey.S01.1080p.WEB-DL'), show, profile, new Set()).covers).toEqual({ season: 1, episodes: [3] });
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
      [`${QBIT}/api/v2/auth/login`]: () => new Response('Ok.', { headers: { 'set-cookie': 'SID=abc; path=/' } }),
      [`${QBIT}/api/v2/app/version`]: () => new Response('v5.0.0'),
      [`${QBIT}/api/v2/torrents/add`]: (_u: URL, init?: RequestInit) => {
        added.push(String(init?.body));
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
  });

  it('managers skip approval', async () => {
    const r = (await owner.req('POST', '/api/requests', { kind: 'movie', tmdbId: 116149 })).json();
    expect(r.status).toBe('approved');
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

  it('changing the profile reports upgrade candidates without grabbing anything', async () => {
    const m = (await owner.req('POST', '/api/monitored', { kind: 'movie', tmdbId: 116149, profileId: await profileId('HD-720p'), search: false })).json();
    t.app.ctx.dbHandle.sqlite.prepare("UPDATE monitored SET file_path = '/x.mkv', file_quality = 'WEBDL-720p' WHERE id = ?").run(m.id);
    const res = (await owner.req('PATCH', `/api/monitored/${m.id}`, { profileId: await profileId('1080p or above') })).json();
    expect(res.upgradeCandidates).toBe(1);
    expect(added).toHaveLength(0);
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
