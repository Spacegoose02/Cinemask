import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollShelfmark, syncBookBandit } from '../src/server/books/service.js';
import { forgetBookBanditSessions } from '../src/server/integrations/bookbandit.js';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { fakeFetch } from './fakes.js';

const BB = 'http://bookbandit.local:8080';
const OL = 'https://openlibrary.org';
const SM = 'http://shelfmark.local:8084';
const HOBBIT = { key: '/works/OL262758W', title: 'The Hobbit', author_name: ['J.R.R. Tolkien'], first_publish_year: 1937, cover_i: 14627509 };
const WILD = { key: '/works/OL15331214W', title: 'The Wild Robot', author_name: ['Peter Brown'], first_publish_year: 2016, cover_i: 8228691 };
const ID1 = '0b5c1a0e-6a4f-4a8e-9d3b-1f2e3d4c5b6a';
const ID2 = '1c6d2b1f-7b5a-4b9f-8e4c-2a3f4e5d6c7b';

const book = (id: string, title: string, author: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  publishedYear: 1937,
  rating: 'middle_grade',
  coverPath: 'covers/x.jpg',
  kindleOnly: false,
  authors: [{ id: 'a', name: author }],
  series: [],
  percent: null,
  ...extra,
});

describe('BookBandit', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let owner: Client;
  let kid: Client;
  let bbBooks: Record<string, unknown>[];
  let logins: { username: string; password: string }[];
  let scans: string[];
  let refuseNext: boolean;
  let role: string;
  const TOKEN = 'bbs_session-token.sig';

  const authed = (init?: RequestInit) => (init?.headers as Record<string, string> | undefined)?.Authorization === `Bearer ${TOKEN}`;

  beforeEach(async () => {
    forgetBookBanditSessions();
    t = await makeApp();
    owner = await setupOwner(t.app);
    bbBooks = [];
    logins = [];
    scans = [];
    refuseNext = false;
    role = 'admin';
    fakeFetch({
      [`${OL}/search.json`]: (url: URL) => {
        const q = url.searchParams.get('q') ?? '';
        if (q === `key:${HOBBIT.key}`) return { numFound: 1, docs: [HOBBIT] };
        if (q === `key:${WILD.key}`) return { numFound: 1, docs: [WILD] };
        return { numFound: 2, docs: [HOBBIT, WILD] };
      },
      [`${BB}/api/health`]: () => ({ ok: true, name: 'bookbandit' }),
      [`${BB}/api/auth/login`]: (_u: URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { username: string; password: string };
        logins.push(body);
        if (body.password !== 'bb-secret') return new Response(JSON.stringify({ error: 'Wrong username or password' }), { status: 401 });
        return new Response(JSON.stringify({ token: TOKEN, expiresAt: Date.now() + 30 * 86400_000, user: { role, displayName: 'Cinemask' } }), {
          headers: { 'content-type': 'application/json', 'set-cookie': `bb_session=${TOKEN}` },
        });
      },
      [`${BB}/api/books`]: (u: URL, init?: RequestInit) => {
        if (!authed(init) || refuseNext) {
          refuseNext = false;
          return new Response('{}', { status: 401 });
        }
        const offset = Number(u.searchParams.get('offset'));
        return { items: bbBooks.slice(offset, offset + 200), limit: 200, offset, total: bbBooks.length };
      },
      [`${BB}/api/admin/library/scan`]: (_u: URL, init?: RequestInit) => {
        if (!authed(init)) return new Response('{}', { status: 401 });
        if (role !== 'admin') return new Response('{}', { status: 403 });
        scans.push(String(init?.method));
        return new Response('{}', { status: 202 });
      },
      [`${SM}/api/search`]: () => [{ id: 'md5abc', title: 'The Wild Robot', author: 'Peter Brown', format: 'epub' }],
      [`${SM}/api/download`]: () => ({ status: 'queued' }),
      [`${SM}/api/status`]: () => ({ done: { md5abc: {} } }),
    });
    // Covers are answered by path; the fake matches by prefix so add them as one handler.
    const fetchFn = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin === BB && /^\/api\/books\/[^/]+\/cover$/.test(url.pathname)) {
        if (!authed(init)) return new Response('{}', { status: 401 });
        return new Response(Buffer.from([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg', 'x-seen-auth': 'yes' } });
      }
      return fetchFn(input, init);
    });
    await owner.req('PUT', '/api/settings/bookbandit', { enabled: true, url: BB, publicUrl: 'https://books.example.com/', username: 'Cinemask', password: 'bb-secret' });
    const u = await createUser(owner, 'kid', 'user');
    kid = new Client(t.app);
    await kid.login('kid', u.password);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  it('tests the connection, and never returns the password or the session token', async () => {
    expect((await owner.req('POST', '/api/integrations/bookbandit/test')).json()).toEqual({ ok: true, message: 'Connected as Cinemask (admin)' });
    expect(logins).toEqual([{ username: 'cinemask', password: 'bb-secret' }]);
    role = 'adult';
    expect((await owner.req('POST', '/api/integrations/bookbandit/test')).json().message).toContain("isn't an admin");
    role = 'kid';
    expect((await owner.req('POST', '/api/integrations/bookbandit/test')).json()).toMatchObject({ ok: false, message: expect.stringContaining('grown-up') });
    expect((await kid.req('POST', '/api/integrations/bookbandit/test')).statusCode).toBe(403);

    await owner.req('PUT', '/api/settings/bookbandit', { password: 'wrong' });
    expect((await owner.req('POST', '/api/integrations/bookbandit/test')).json()).toEqual({ ok: false, message: 'BookBandit: the username or password was rejected' });

    const raw = (await owner.req('GET', '/api/settings/bookbandit')).body;
    expect(raw).not.toContain('bb-secret');
    expect(raw).not.toContain('wrong');
    expect((await owner.req('PUT', '/api/settings/bookbandit', { username: '../admin?x=1' })).statusCode).toBe(400);
    expect((await owner.req('PUT', '/api/settings/bookbandit', { url: 'file:///etc/passwd' })).statusCode).toBe(400);
  });

  it('mirrors the library, keeping only well-formed books, and shows it to signed-in people', async () => {
    bbBooks = [
      book(ID1, 'The Hobbit', 'J.R.R. Tolkien'),
      book(ID2, 'Kindle Thing', 'Someone', { kindleOnly: true }),
      book('../../api/admin', 'Bad id', 'Nobody'),
      { id: ID2, title: '' },
    ];
    expect((await kid.req('POST', '/api/books/bookbandit/sync')).statusCode).toBe(403);
    expect((await owner.req('POST', '/api/books/bookbandit/sync')).json()).toEqual({ books: 1 });

    expect((await new Client(t.app).req('GET', '/api/books/bookbandit')).statusCode).toBe(401);
    const lib = (await kid.req('GET', '/api/books/bookbandit')).json();
    expect(lib).toEqual({
      connected: true,
      items: [{ id: ID1, title: 'The Hobbit', author: 'J.R.R. Tolkien', year: 1937, cover: `bookbandit:/api/books/${ID1}/cover`, link: `https://books.example.com/book/${ID1}` }],
    });
    expect(JSON.stringify(lib)).not.toContain('bbs_');

    // Covers come through Cinemask without exposing the session; only BookBandit-shaped ids are proxied.
    const img = await kid.req('GET', `/api/images?src=${encodeURIComponent(lib.items[0].cover)}`);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(img.headers['x-seen-auth']).toBeUndefined();
    for (const bad of ['bookbandit:/api/books/../admin/inbox/cover', `bookbandit:/api/books/${ID1}/files/1`, `bookbandit:/api/admin/library/scan`]) {
      expect((await kid.req('GET', `/api/images?src=${encodeURIComponent(bad)}`)).statusCode, bad).toBe(400);
    }

    // Search says it's there, and an ebook request for it is refused; the audiobook is still requestable.
    const found = (await kid.req('GET', '/api/books/search?q=hobbit')).json().results;
    expect(found.find((b: { title: string }) => b.title === 'The Hobbit')).toMatchObject({ inBookBandit: true });
    expect(found.find((b: { title: string }) => b.title === 'The Wild Robot')).toMatchObject({ inBookBandit: false });
    const dup = await kid.req('POST', '/api/books', { workKey: HOBBIT.key, format: 'ebook' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error ?? dup.body).toContain('already in BookBandit');
    expect((await kid.req('POST', '/api/books', { workKey: HOBBIT.key, format: 'audiobook' })).json().status).toBe('pending');
  });

  it('signs in once, reuses the session, and signs in again when BookBandit refuses it', async () => {
    bbBooks = [book(ID1, 'The Hobbit', 'J.R.R. Tolkien')];
    await syncBookBandit(t.app.ctx);
    await syncBookBandit(t.app.ctx);
    expect(logins).toHaveLength(1);
    refuseNext = true;
    expect(await syncBookBandit(t.app.ctx)).toEqual({ books: 1 });
    expect(logins).toHaveLength(2);
    // A new password in Settings means a new session, not the one made with the old password.
    await owner.req('PUT', '/api/settings/bookbandit', { password: 'wrong' });
    await expect(syncBookBandit(t.app.ctx)).rejects.toThrow('rejected');
    expect(logins).toHaveLength(3);
  });

  it('a failed sync leaves the mirror as it was', async () => {
    bbBooks = [book(ID1, 'The Hobbit', 'J.R.R. Tolkien')];
    await syncBookBandit(t.app.ctx);
    await owner.req('PUT', '/api/settings/bookbandit', { password: 'wrong' });
    expect((await owner.req('POST', '/api/books/bookbandit/sync')).statusCode).toBe(502);
    expect((await kid.req('GET', '/api/books/bookbandit')).json().items).toHaveLength(1);
  });

  it('marks a waiting ebook request ready when it shows up, and asks for a scan after importing one', async () => {
    const booksDir = path.join(t.dir, 'books');
    const ingest = path.join(t.dir, 'shelfmark');
    fs.mkdirSync(ingest, { recursive: true });
    await owner.req('PUT', '/api/settings/media', { booksPath: booksDir, downloadsPath: path.join(t.dir, 'dl') });
    await owner.req('PUT', '/api/settings/shelfmark', { enabled: true, url: SM, ingestPath: ingest });

    const r = (await owner.req('POST', '/api/books', { workKey: WILD.key, format: 'ebook' })).json();
    await vi.waitFor(async () => expect((await owner.req('GET', '/api/books')).json()[0].status).toBe('downloading'));
    fs.writeFileSync(path.join(ingest, 'Peter Brown - The Wild Robot.epub'), 'book');
    await pollShelfmark(t.app.ctx);
    expect((await owner.req('GET', '/api/books')).json()[0]).toMatchObject({ id: r.id, status: 'available' });
    await vi.waitFor(() => expect(scans).toEqual(['POST']));

    // One that arrived some other way (dropped into BookBandit by hand) is marked ready on the next sync.
    const h = (await kid.req('POST', '/api/books', { workKey: HOBBIT.key, format: 'ebook' })).json();
    await owner.req('POST', `/api/books/${h.id}/approve`);
    await vi.waitFor(async () => expect((await owner.req('GET', '/api/books?status=failed')).json()).toHaveLength(1));
    bbBooks = [book(ID1, 'The Hobbit', 'J.R.R. Tolkien')];
    await owner.req('POST', '/api/books/bookbandit/sync');
    expect((await kid.req('GET', '/api/books')).json()[0]).toMatchObject({ id: h.id, status: 'available' });
  });
});
