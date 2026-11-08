import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Release } from '../src/server/arr/indexers.js';
import { trackDownloads } from '../src/server/arr/tracker.js';
import { setMusicBrainzInterval } from '../src/server/integrations/musicbrainz.js';
import { checkFollowedArtists, namesAlbum, rankAlbumReleases, type AlbumRow } from '../src/server/music/service.js';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { bodyText, fakeFetch, torrentFile } from './fakes.js';

const MBZ = 'https://musicbrainz.org/ws/2';
const INDEXER = 'http://indexer.local';
const QBIT = 'http://qbit.local:8080';
const MB = 1024 * 1024;

const ARTIST = { id: '0383dadf-2a4e-4d10-a46a-e9e041da8eb3', name: 'Queen', disambiguation: 'UK rock group', country: 'GB', type: 'Group' };
const credit = [{ name: 'Queen', artist: { id: ARTIST.id, name: 'Queen' } }];
const NIGHT = { id: '6a8d1d10-1111-4b5a-9a3d-000000000001', title: 'A Night at the Opera', 'first-release-date': '1975-11-21', 'primary-type': 'Album', 'secondary-types': [], 'artist-credit': credit };
const LIVE = { id: '6a8d1d10-1111-4b5a-9a3d-000000000002', title: 'Live Killers', 'first-release-date': '1979-06-22', 'primary-type': 'Album', 'secondary-types': ['Live'], 'artist-credit': credit };
const NEW = { id: '6a8d1d10-1111-4b5a-9a3d-000000000003', title: 'The Comeback', 'first-release-date': `${new Date().getUTCFullYear()}-01-01`, 'primary-type': 'Album', 'secondary-types': [], 'artist-credit': credit };

const rel = (title: string, size: number, extra: Partial<Release> = {}): Release => ({
  guid: title,
  title,
  downloadUrl: `magnet:?xt=urn:btih:${title.length}`,
  infoUrl: null,
  size,
  publishedAt: null,
  indexer: 'Test',
  indexerId: 1,
  protocol: 'torrent',
  seeders: 10,
  peers: 10,
  ...extra,
});

function torznab(items: { title: string; size: number }[]) {
  return `<?xml version="1.0"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>${items
    .map(
      (i, n) => `<item><title>${i.title}</title><guid>g${n}</guid><link>magnet:?xt=urn:btih:${n}</link><size>${i.size}</size>
<torznab:attr name="seeders" value="20"/><torznab:attr name="peers" value="25"/></item>`,
    )
    .join('')}</channel></rss>`;
}

beforeAll(() => setMusicBrainzInterval(0));

describe('album matching', () => {
  const album = { title: 'A Night at the Opera', artist: 'Queen' } as AlbumRow;

  it('needs every word of the artist and title', () => {
    expect(namesAlbum('Queen - A Night At The Opera (1975) [FLAC 24bit]', album)).toBe(true);
    expect(namesAlbum('Queen-A.Night.At.The.Opera-WEB-2011-FLAC', album)).toBe(true);
    expect(namesAlbum('Queen - A Day at the Races', album)).toBe(false);
    expect(namesAlbum('A Night at the Opera Soundtrack', album)).toBe(false);
  });

  it('ranks releases by format preference and leaves out discographies', () => {
    const list = [
      rel('Queen - A Night at the Opera [MP3 320]', 120 * MB),
      rel('Queen - A Night at the Opera [FLAC]', 400 * MB),
      rel('Queen - Discography incl A Night at the Opera FLAC', 30_000 * MB),
      rel('Queen - Complete Discography A Night at the Opera', 2000 * MB),
      rel('Queen - A Night at the Opera', 1 * MB),
    ];
    expect(rankAlbumReleases(list, album as AlbumRow, 'any').map((r) => r.title)).toEqual(['Queen - A Night at the Opera [FLAC]', 'Queen - A Night at the Opera [MP3 320]']);
    expect(rankAlbumReleases(list, album as AlbumRow, 'lossless').map((r) => r.title)).toEqual(['Queen - A Night at the Opera [FLAC]']);
    expect(rankAlbumReleases(list, album as AlbumRow, 'lossy').map((r) => r.title)).toEqual(['Queen - A Night at the Opera [MP3 320]']);
  });
});

describe('music requests', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let owner: Client;
  let kid: Client;
  let dl: string;
  const added: string[] = [];
  let qbitTorrents: Record<string, unknown>[] = [];
  let releaseGroups: unknown[] = [];
  let agents: string[] = [];

  beforeEach(async () => {
    t = await makeApp();
    owner = await setupOwner(t.app);
    dl = path.join(t.dir, 'downloads');
    fs.mkdirSync(dl, { recursive: true });
    added.length = 0;
    qbitTorrents = [];
    agents = [];
    releaseGroups = [NIGHT, LIVE];
    const mb = (fn: (u: URL) => unknown) => (u: URL, init?: RequestInit) => {
      agents.push(new Headers(init?.headers).get('user-agent') ?? '');
      return fn(u);
    };
    fakeFetch({
      [`${MBZ}/artist/${ARTIST.id}`]: mb(() => ARTIST),
      [`${MBZ}/artist`]: mb(() => ({ artists: [ARTIST] })),
      [`${MBZ}/release-group/${NIGHT.id}`]: mb(() => NIGHT),
      [`${MBZ}/release-group/${NEW.id}`]: mb(() => NEW),
      [`${MBZ}/release-group/00000000-0000-0000-0000-000000000000`]: mb(() => new Response('{}', { status: 404 })),
      [`${MBZ}/release-group`]: mb((u) => ({ 'release-groups': u.searchParams.get('artist') ? releaseGroups : [NIGHT] })),
      [`${INDEXER}/api`]: () =>
        new Response(
          torznab([
            { title: 'Queen - A Night at the Opera (1975) [FLAC]', size: 400 * MB },
            { title: 'Queen - The Comeback (2026) [FLAC]', size: 400 * MB },
            { title: 'Queen - Greatest Hits', size: 200 * MB },
          ]),
        ),
      [`${INDEXER}/dl/`]: torrentFile,
      [`${QBIT}/api/v2/auth/login`]: () => new Response('Ok.', { headers: { 'set-cookie': 'SID=abc; path=/' } }),
      [`${QBIT}/api/v2/torrents/add`]: (_u: URL, init?: RequestInit) => {
        added.push(bodyText(init?.body));
        return new Response('Ok.');
      },
      [`${QBIT}/api/v2/torrents/info`]: () => qbitTorrents,
    });
    await owner.req('PUT', '/api/settings/media', { downloadsPath: dl, musicPath: path.join(t.dir, 'music') });
    expect((await owner.req('POST', '/api/indexers', { name: 'Test', type: 'torznab', url: INDEXER, apiKey: 'k' })).statusCode).toBe(200);
    expect((await owner.req('POST', '/api/download-clients', { name: 'qBit', type: 'qbittorrent', url: QBIT, username: 'admin', password: 'pw' })).statusCode).toBe(200);
    const u = await createUser(owner, 'kid', 'user');
    kid = new Client(t.app);
    await kid.login('kid', u.password);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  it('finds artists and their albums, then a request downloads and imports as Artist/Album (Year)', async () => {
    const found = (await kid.req('GET', '/api/music/search?type=artist&q=queen')).json();
    expect(found.artists[0]).toMatchObject({ mbid: ARTIST.id, name: 'Queen', followed: false });
    expect(agents[0]).toMatch(/^Cinemask\//);
    const page = (await kid.req('GET', `/api/music/artist/${ARTIST.id}`)).json();
    expect(page.albums.map((a: { title: string }) => a.title)).toEqual(['A Night at the Opera', 'Live Killers']); // studio albums first

    const r = (await kid.req('POST', '/api/music', { mbid: NIGHT.id })).json();
    expect(r).toMatchObject({ status: 'pending', title: 'A Night at the Opera', artist: 'Queen', year: 1975, requestedByName: 'kid' });
    expect((await kid.req('POST', '/api/music', { mbid: NIGHT.id })).json().id).toBe(r.id);
    expect((await kid.req('GET', '/api/music/search?type=album&q=night')).json().albums[0].request).toEqual({ id: r.id, status: 'pending' });
    expect((await kid.req('POST', `/api/music/${r.id}/approve`)).statusCode).toBe(403);
    expect((await kid.req('POST', '/api/music', { mbid: '../../etc/passwd' })).statusCode).toBe(400);

    await owner.req('POST', `/api/music/${r.id}/approve`);
    await vi.waitFor(() => expect(added).toHaveLength(1));
    expect((await owner.req('GET', '/api/music')).json()[0].status).toBe('downloading');

    const folder = path.join(dl, 'Queen - A Night at the Opera [FLAC]');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, '01 - Death on Two Legs.flac'), 'audio');
    fs.writeFileSync(path.join(folder, '11 - Bohemian Rhapsody.flac'), 'audio');
    fs.writeFileSync(path.join(folder, 'cover.jpg'), 'img');
    fs.writeFileSync(path.join(folder, 'release.nfo'), 'x');
    qbitTorrents = [{ hash: 'h1', name: 'Queen', progress: 1, state: 'stalledUP', size: 5, content_path: folder, save_path: dl, tags: 'mm-1' }];
    await trackDownloads(t.app.ctx);

    const dest = path.join(t.dir, 'music', 'Queen', 'A Night at the Opera (1975)');
    expect(fs.readdirSync(dest).sort()).toEqual(['01 - Death on Two Legs.flac', '11 - Bohemian Rhapsody.flac', 'cover.jpg']);
    expect((await kid.req('GET', '/api/music')).json()[0].status).toBe('available');
  });

  it('turns away an unknown album', async () => {
    expect((await kid.req('POST', '/api/music', { mbid: '00000000-0000-0000-0000-000000000000' })).statusCode).toBe(400);
  });

  it('lets only the requester cancel a pending request, and managers decline', async () => {
    const r = (await kid.req('POST', '/api/music', { mbid: NIGHT.id })).json();
    const u2 = await createUser(owner, 'sib', 'user');
    const sib = new Client(t.app);
    await sib.login('sib', u2.password);
    expect((await sib.req('DELETE', `/api/music/${r.id}`)).statusCode).toBe(403);
    expect((await sib.req('GET', '/api/music')).json()).toEqual([]); // only their own
    expect((await owner.req('POST', `/api/music/${r.id}/decline`, { reason: 'Already on vinyl' })).json()).toEqual({ ok: true });
    expect((await kid.req('GET', '/api/music')).json()[0]).toMatchObject({ status: 'declined', reason: 'Already on vinyl' });
  });

  it('follows artists (managers only) and requests their new studio albums', async () => {
    expect((await kid.req('POST', '/api/music/artists', { mbid: ARTIST.id })).statusCode).toBe(403);
    const f = (await owner.req('POST', '/api/music/artists', { mbid: ARTIST.id })).json();
    expect(f).toMatchObject({ name: 'Queen' });
    expect((await kid.req('GET', '/api/music/artists')).json()).toHaveLength(1);

    // Old albums aren't requested; a new one is, and starts downloading.
    expect(await checkFollowedArtists(t.app.ctx)).toBe(0);
    releaseGroups = [NEW, NIGHT, { ...NEW, id: '6a8d1d10-1111-4b5a-9a3d-000000000004', title: 'Live Comeback', 'secondary-types': ['Live'] }];
    expect(await checkFollowedArtists(t.app.ctx)).toBe(1);
    const list = (await owner.req('GET', '/api/music')).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: 'The Comeback', status: 'downloading', requestedByName: 'Followed artist' });
    expect(await checkFollowedArtists(t.app.ctx)).toBe(0); // not twice

    expect((await kid.req('DELETE', `/api/music/artists/${f.id}`)).statusCode).toBe(403);
    expect((await owner.req('DELETE', `/api/music/artists/${f.id}`)).json()).toEqual({ ok: true });
  });

  it('keeps music settings to admins', async () => {
    expect((await kid.req('GET', '/api/settings/music')).statusCode).toBe(403);
    expect((await kid.req('GET', '/api/music/counts')).statusCode).toBe(403);
  });
});
