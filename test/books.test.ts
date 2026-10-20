import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Release } from '../src/server/arr/indexers.js';
import { trackDownloads } from '../src/server/arr/tracker.js';
import { namesBook, pollReadMeABook, pollShelfmark, rankReleases, type BookRow } from '../src/server/books/service.js';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { bodyText, fakeFetch, torrentFile } from './fakes.js';

const OL = 'https://openlibrary.org';
const ABS = 'http://abs.local:13378';
const SM = 'http://shelfmark.local:8084';
const RMAB = 'http://rmab.local:3030';
const INDEXER = 'http://indexer.local';
const QBIT = 'http://qbit.local:8080';
const MB = 1024 * 1024;

const HOBBIT = { key: '/works/OL262758W', title: 'The Hobbit', author_name: ['J.R.R. Tolkien'], first_publish_year: 1937, cover_i: 14627509, isbn: ['9780547928227'] };
const WILD = { key: '/works/OL15331214W', title: 'The Wild Robot', author_name: ['Peter Brown'], first_publish_year: 2016, cover_i: 8228691 };

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

describe('book matching', () => {
  const book = { title: 'The Hobbit', author: 'J.R.R. Tolkien', format: 'audiobook' } as BookRow;

  it('needs every title word and the author surname', () => {
    expect(namesBook('J.R.R. Tolkien - The Hobbit (Unabridged) [M4B]', book)).toBe(true);
    expect(namesBook('Tolkien.The.Hobbit.2012.1080p.BluRay', book)).toBe(true); // ranking filters this one by size/format
    expect(namesBook('The Hobbit Coloring Book', { ...book, author: 'Someone Else' })).toBe(false);
    expect(namesBook('Tolkien - The Silmarillion', book)).toBe(false);
  });

  it('ranks audiobook releases: right format and size, unabridged, m4b first', () => {
    const ranked = rankReleases(
      [
        rel('Tolkien - The Hobbit [EPUB]', 2 * MB),
        rel('Tolkien - The Hobbit (Abridged) MP3', 200 * MB),
        rel('Tolkien - The Hobbit MP3 Unabridged', 400 * MB),
        rel('Tolkien - The Hobbit M4B Unabridged', 350 * MB),
        rel('Tolkien - The Hobbit 1080p', 20_000 * MB),
      ],
      book,
    );
    expect(ranked.map((r) => r.title)).toEqual(['Tolkien - The Hobbit M4B Unabridged', 'Tolkien - The Hobbit MP3 Unabridged', 'Tolkien - The Hobbit (Abridged) MP3']);
    const ebooks = rankReleases([rel('Tolkien - The Hobbit [EPUB]', 2 * MB), rel('Tolkien - The Hobbit M4B', 300 * MB)], { ...book, format: 'ebook' });
    expect(ebooks.map((r) => r.title)).toEqual(['Tolkien - The Hobbit [EPUB]']);
  });
});

describe('books, audiobooks and podcasts', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let owner: Client;
  let kid: Client;
  let dl: string;
  let ingest: string;
  const added: string[] = [];
  const absWrites: { method: string; path: string; body?: unknown }[] = [];
  let qbitTorrents: Record<string, unknown>[] = [];
  let absBooks: Record<string, unknown>[] = [];
  let smStatus: Record<string, Record<string, unknown>> = {};
  const smDownloads: string[] = [];
  const rmabRequests: { auth: string; body: unknown }[] = [];
  let rmabStatus = 'searching';

  beforeEach(async () => {
    t = await makeApp();
    owner = await setupOwner(t.app);
    dl = path.join(t.dir, 'downloads');
    ingest = path.join(t.dir, 'shelfmark');
    fs.mkdirSync(dl, { recursive: true });
    fs.mkdirSync(ingest, { recursive: true });
    added.length = 0;
    absWrites.length = 0;
    smDownloads.length = 0;
    rmabRequests.length = 0;
    rmabStatus = 'searching';
    qbitTorrents = [];
    absBooks = [];
    smStatus = {};
    fakeFetch({
      [`${OL}/search.json`]: (url: URL) => {
        const q = url.searchParams.get('q') ?? '';
        if (q === `key:${HOBBIT.key}`) return { numFound: 1, docs: [HOBBIT] };
        if (q === `key:${WILD.key}`) return { numFound: 1, docs: [WILD] };
        return { numFound: 2, docs: [HOBBIT, WILD] };
      },
      [`${OL}/trending/weekly.json`]: () => ({ works: [WILD] }),
      [`${ABS}/api/libraries`]: () => ({
        libraries: [
          { id: 'lib-books', name: 'Audiobooks', mediaType: 'book', folders: [{ id: 'f1', fullPath: '/audiobooks' }] },
          { id: 'lib-pods', name: 'Podcasts', mediaType: 'podcast', folders: [{ id: 'f2', fullPath: '/podcasts' }] },
        ],
      }),
      [`${ABS}/api/libraries/lib-books/items`]: () => ({ results: absBooks, total: absBooks.length }),
      [`${ABS}/api/libraries/lib-pods/items`]: () => ({ results: [], total: 0 }),
      [`${ABS}/api/libraries/lib-books/scan`]: (u: URL, init?: RequestInit) => {
        absWrites.push({ method: String(init?.method), path: u.pathname });
        return new Response('OK');
      },
      [`${ABS}/api/items/abs-1/cover`]: (_u: URL, init?: RequestInit) =>
        new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { headers: { 'content-type': 'image/jpeg', 'x-auth': String((init?.headers as Record<string, string>).Authorization) } }),
      [`${ABS}/api/podcasts`]: (u: URL, init?: RequestInit) => {
        absWrites.push({ method: String(init?.method), path: u.pathname, body: JSON.parse(String(init?.body)) });
        return { id: 'pod-1' };
      },
      'https://itunes.apple.com/lookup': (u: URL) => ({
        results: u.searchParams.get('id')?.split(',').includes('1') ? [{ collectionId: 1, collectionName: 'Story Pirates', artistName: 'Gimlet', feedUrl: 'https://feeds.example/story-pirates', artworkUrl600: 'https://img.example/sp.jpg' }] : [],
      }),
      'https://rss.applemarketingtools.com/api/v2/us/podcasts/top/30/podcasts.json': () => ({ feed: { results: [{ id: '1' }, { id: 'nope' }] } }),
      [`${SM}/api/search`]: () => [{ id: 'md5abc', title: 'The Wild Robot', author: 'Peter Brown', format: 'epub' }],
      [`${SM}/api/download`]: (u: URL) => {
        smDownloads.push(u.searchParams.get('id')!);
        return { status: 'queued' };
      },
      [`${SM}/api/status`]: () => smStatus,
      [`${RMAB}/api/auth/me`]: () => ({ user: { username: 'cinemask' } }),
      [`${RMAB}/api/audiobooks/search`]: () => ({ results: [{ asin: 'B007978NPG', title: 'The Hobbit', author: 'J.R.R. Tolkien', narrator: 'Andy Serkis' }] }),
      [`${RMAB}/api/requests/req-1`]: () => ({ success: true, request: { id: 'req-1', status: rmabStatus, errorMessage: rmabStatus === 'failed' ? 'No torrents found' : null } }),
      [`${RMAB}/api/requests`]: (_u: URL, init?: RequestInit) => {
        rmabRequests.push({ auth: String((init?.headers as Record<string, string>).Authorization), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ success: true, request: { id: 'req-1', status: 'pending' } }), { status: 201 });
      },
      [`${INDEXER}/api`]: () =>
        new Response(
          torznab([
            { title: 'J.R.R. Tolkien - The Hobbit (Unabridged) [M4B]', size: 300 * MB },
            { title: 'The Hobbit 2012 1080p BluRay', size: 9000 * MB },
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
    await owner.req('PUT', '/api/settings/media', { downloadsPath: dl, audiobooksPath: path.join(t.dir, 'audiobooks'), booksPath: path.join(t.dir, 'books') });
    await owner.req('PUT', '/api/settings/audiobookshelf', { enabled: true, url: ABS, apiKey: 'abs-token', audiobookLibraryId: 'lib-books', podcastLibraryId: 'lib-pods' });
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

  it('hands approved audiobooks to ReadMeABook and follows them', async () => {
    await owner.req('PUT', '/api/settings/readmeabook', { enabled: true, url: RMAB, apiToken: 'rmab_secret' });
    expect((await owner.req('POST', '/api/integrations/readmeabook/test')).json()).toEqual({ ok: true, message: 'Connected as cinemask' });
    const r = (await kid.req('POST', '/api/books', { workKey: HOBBIT.key, format: 'audiobook' })).json();
    await owner.req('POST', `/api/books/${r.id}/approve`);
    await vi.waitFor(async () => expect((await kid.req('GET', '/api/books?status=all')).json()[0].status).toBe('downloading'));
    expect(rmabRequests).toEqual([{ auth: 'Bearer rmab_secret', body: { audiobook: { asin: 'B007978NPG', title: 'The Hobbit', author: 'J.R.R. Tolkien', narrator: 'Andy Serkis' } } }]);
    expect(added).toEqual([]); // not sent to the download client as well

    await pollReadMeABook(t.app.ctx);
    expect((await kid.req('GET', '/api/books?status=all')).json()[0].status).toBe('downloading');
    rmabStatus = 'downloaded';
    await pollReadMeABook(t.app.ctx);
    expect((await kid.req('GET', '/api/books?status=all')).json()[0].status).toBe('available');
  });

  it('lets a manager fix a request that matched the wrong book', async () => {
    const r = (await kid.req('POST', '/api/books', { workKey: HOBBIT.key, format: 'audiobook' })).json();
    expect((await kid.req('POST', `/api/books/${r.id}/match`, { workKey: WILD.key })).statusCode).toBe(403);
    const fixed = (await owner.req('POST', `/api/books/${r.id}/match`, { workKey: WILD.key })).json();
    expect(fixed).toMatchObject({ workKey: WILD.key, title: 'The Wild Robot', author: 'Peter Brown' });
    const other = (await kid.req('POST', '/api/books', { workKey: HOBBIT.key, format: 'audiobook' })).json();
    expect((await owner.req('POST', `/api/books/${other.id}/match`, { workKey: WILD.key })).statusCode).toBe(409);
  });

  it('search shows request state; an approved audiobook downloads, imports as Author/Title and rescans Audiobookshelf', async () => {
    const r = (await kid.req('POST', '/api/books', { workKey: HOBBIT.key, format: 'audiobook' })).json();
    expect(r).toMatchObject({ status: 'pending', title: 'The Hobbit', author: 'J.R.R. Tolkien', requestedByName: 'kid' });
    // The same request again returns the open one instead of a duplicate.
    expect((await kid.req('POST', '/api/books', { workKey: HOBBIT.key, format: 'audiobook' })).json().id).toBe(r.id);
    const found = (await kid.req('GET', '/api/books/search?q=hobbit')).json().results;
    expect(found[0]).toMatchObject({ title: 'The Hobbit', requests: { audiobook: { status: 'pending' } } });
    expect((await kid.req('POST', `/api/books/${r.id}/approve`)).statusCode).toBe(403);
    expect((await kid.req('POST', '/api/books', { workKey: '../../etc', format: 'audiobook' })).statusCode).toBe(400);

    expect((await owner.req('POST', `/api/books/${r.id}/approve`)).json().status).toBe('approved');
    await vi.waitFor(() => expect(added).toHaveLength(1));
    expect(added[0]).toContain('category=cinemask');
    const book = (await owner.req('GET', '/api/books')).json()[0];
    expect(book.status).toBe('downloading');

    const folder = path.join(dl, 'The Hobbit M4B');
    fs.mkdirSync(path.join(folder, 'CD1'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'CD1', '01 - Chapter One.mp3'), 'audio');
    fs.writeFileSync(path.join(folder, 'CD1', '02 - Chapter Two.mp3'), 'audio');
    fs.writeFileSync(path.join(folder, 'readme.nfo'), 'x');
    qbitTorrents = [{ hash: 'h1', name: 'The Hobbit', progress: 1, state: 'stalledUP', size: 5, content_path: folder, save_path: dl, tags: 'mm-1' }];
    await trackDownloads(t.app.ctx);

    const dest = path.join(t.dir, 'audiobooks', 'J.R.R. Tolkien', 'The Hobbit (1937)', 'CD1');
    expect(fs.readdirSync(dest)).toEqual(['01 - Chapter One.mp3', '02 - Chapter Two.mp3']);
    expect(fs.existsSync(path.join(t.dir, 'audiobooks', 'J.R.R. Tolkien', 'The Hobbit (1937)', 'readme.nfo'))).toBe(false);
    expect((await kid.req('GET', '/api/books')).json()[0].status).toBe('available');
    await vi.waitFor(() => expect(absWrites).toContainEqual({ method: 'POST', path: '/api/libraries/lib-books/scan' }));
    expect((await owner.req('GET', '/api/downloads?history=true')).json()[0]).toMatchObject({ status: 'imported' });
  });

  it('an ebook goes through Shelfmark and is imported from its download folder', async () => {
    await owner.req('PUT', '/api/settings/shelfmark', { enabled: true, url: SM, ingestPath: ingest });
    const r = (await owner.req('POST', '/api/books', { workKey: WILD.key, format: 'ebook' })).json();
    await vi.waitFor(async () => expect((await owner.req('GET', '/api/books')).json()[0].status).toBe('downloading'));
    expect(smDownloads).toEqual(['md5abc']);
    expect(added).toHaveLength(0);

    smStatus = { downloading: { md5abc: {} } };
    await pollShelfmark(t.app.ctx);
    expect((await owner.req('GET', '/api/books')).json()[0].status).toBe('downloading');

    fs.writeFileSync(path.join(ingest, 'Peter Brown - The Wild Robot.epub'), 'book');
    fs.writeFileSync(path.join(ingest, 'Someone - Other Book.epub'), 'other');
    smStatus = { done: { md5abc: {} } };
    await pollShelfmark(t.app.ctx);
    expect(fs.existsSync(path.join(t.dir, 'books', 'Peter Brown', 'The Wild Robot (2016)', 'The Wild Robot.epub'))).toBe(true);
    const done = (await owner.req('GET', '/api/books')).json()[0];
    expect(done).toMatchObject({ id: r.id, status: 'available' });
  });

  it('a failed search records why, and only managers can retry', async () => {
    const r = (await owner.req('POST', '/api/books', { workKey: WILD.key, format: 'audiobook' })).json();
    await vi.waitFor(async () => expect((await owner.req('GET', '/api/books')).json()[0].status).toBe('failed'));
    expect((await owner.req('GET', '/api/books')).json()[0].error).toContain('No matching release');
    expect((await kid.req('POST', `/api/books/${r.id}/retry`)).statusCode).toBe(403);
    expect((await owner.req('POST', `/api/books/${r.id}/retry`)).json().status).toBe('failed');
  });

  it('syncs the Audiobookshelf library, proxies covers without exposing the token, and refuses duplicate audiobook requests', async () => {
    absBooks = [{ id: 'abs-1', libraryId: 'lib-books', mediaType: 'book', addedAt: 1, media: { metadata: { title: 'The Hobbit', authorName: 'J.R.R. Tolkien' } } }];
    expect((await kid.req('POST', '/api/books/library/sync')).statusCode).toBe(403);
    expect((await owner.req('POST', '/api/books/library/sync')).json()).toEqual({ books: 1, podcasts: 0 });
    const lib = (await kid.req('GET', '/api/books/library')).json();
    expect(lib.items).toHaveLength(1);
    expect(lib.items[0].cover).toBe('abs:/api/items/abs-1/cover');
    const img = await kid.req('GET', `/api/images?src=${encodeURIComponent(lib.items[0].cover)}`);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(img.headers['x-auth']).toBeUndefined();
    expect((await kid.req('GET', `/api/images?src=${encodeURIComponent('abs:/api/items/../../api/me')}`)).statusCode).toBe(400);

    expect((await kid.req('POST', '/api/books', { workKey: HOBBIT.key, format: 'audiobook' })).statusCode).toBe(409);
    // Ebooks are separate from Audiobookshelf.
    expect((await kid.req('POST', '/api/books', { workKey: HOBBIT.key, format: 'ebook' })).json().status).toBe('pending');
    expect((await kid.req('GET', '/api/books/search?q=hobbit')).json().results[0].inAudiobookshelf).toBe(true);

    // A request that shows up in Audiobookshelf later becomes available on the next sync.
    absBooks = [];
    await owner.req('POST', '/api/books/library/sync');
    const wild = (await owner.req('POST', '/api/books', { workKey: WILD.key, format: 'audiobook' })).json();
    absBooks = [{ id: 'abs-2', libraryId: 'lib-books', mediaType: 'book', media: { metadata: { title: 'The Wild Robot', authorName: 'Peter Brown' } } }];
    await vi.waitFor(async () => expect((await owner.req('GET', '/api/books?status=failed')).json()).toHaveLength(1));
    await owner.req('POST', '/api/books/library/sync');
    expect((await owner.req('GET', '/api/books')).json().find((b: { id: number }) => b.id === wild.id).status).toBe('available');
  });

  it('users cancel only their own pending book requests', async () => {
    const mine = (await kid.req('POST', '/api/books', { workKey: HOBBIT.key, format: 'ebook' })).json();
    const u2 = await createUser(owner, 'sibling', 'user');
    const sib = new Client(t.app);
    await sib.login('sibling', u2.password);
    expect((await sib.req('GET', '/api/books')).json()).toHaveLength(0);
    expect((await sib.req('DELETE', `/api/books/${mine.id}`)).statusCode).toBe(403);
    expect((await kid.req('DELETE', `/api/books/${mine.id}`)).statusCode).toBe(200);
  });

  it('podcasts: anyone can browse, managers subscribe using the feed Apple lists', async () => {
    const top = (await kid.req('GET', '/api/podcasts/top')).json();
    expect(top).toEqual([expect.objectContaining({ itunesId: 1, title: 'Story Pirates', subscribed: false })]);
    expect((await kid.req('POST', '/api/podcasts', { itunesId: 1 })).statusCode).toBe(403);
    expect((await owner.req('POST', '/api/podcasts', { itunesId: 1, feedUrl: 'http://169.254.169.254/' })).json()).toMatchObject({ ok: true });
    const write = absWrites.find((w) => w.path === '/api/podcasts')!;
    expect(write.body).toMatchObject({ libraryId: 'lib-pods', folderId: 'f2', path: '/podcasts/Story Pirates', media: { metadata: { feedUrl: 'https://feeds.example/story-pirates' }, autoDownloadEpisodes: true } });
    expect((await owner.req('POST', '/api/podcasts', { itunesId: 999 })).statusCode).toBe(404);
  });

  it('never returns the Audiobookshelf token or Shelfmark password', async () => {
    await owner.req('PUT', '/api/settings/shelfmark', { enabled: true, url: SM, username: 'me', password: 'sm-secret' });
    const raw = (await owner.req('GET', '/api/settings/audiobookshelf')).body + (await owner.req('GET', '/api/settings/shelfmark')).body;
    expect(raw).not.toContain('abs-token');
    expect(raw).not.toContain('sm-secret');
  });
});
