import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { fakeFetch, tmdbRoutes } from './fakes.js';
import { entryFromWatchmask } from '../src/server/integrations/watchmask.js';
import { auditLog } from '../src/server/db/schema.js';

const WM = 'https://track.example.com';
const TOKEN = 'flp_secret-token';

describe('Watchmask', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let owner: Client;
  let manager: Client;
  let user: Client;
  /** Lists on the fake Watchmask, by id, holding "type:tmdbId" keys. */
  let lifetime: Set<string>;
  let auth: (string | null)[];
  let locked: boolean;

  beforeEach(async () => {
    t = await makeApp();
    owner = await setupOwner(t.app);
    lifetime = new Set(['movie:1001']);
    auth = [];
    locked = false;
    const seen = (init?: RequestInit) => auth.push(((init?.headers ?? {}) as Record<string, string>).Authorization ?? null);
    const lists = [
      { id: 68, name: 'Lifetime', items_count: 1, is_public: true, public_slug: 'lifetime-movies', owner: { username: 'me' } },
      { id: 70, name: 'Holiday', items_count: 0, is_public: false, public_slug: null, owner: { username: 'me' } },
    ];
    fakeFetch({
      ...tmdbRoutes,
      [`${WM}/api/v1/lists?`]: (_u: URL, init?: RequestInit) => (seen(init), { pagination: { total: lists.length, next: null }, results: lists }),
      [`${WM}/api/v1/lists/68/items`]: (_u: URL, init?: RequestInit) => (
        seen(init),
        {
          pagination: { total: 4, next: null },
          results: [
            { item: { media_id: '1001', source: 'tmdb', media_type: 'movie', title: 'A Deadly Affair', image: 'https://image.tmdb.org/t/p/w500/abc.jpg', release_datetime: '2024-05-01T00:00:00Z' } },
            { item: { media_id: '82728', source: 'tmdb', media_type: 'tv', title: 'Bluey', image: null } },
            { item: { media_id: '1234', source: 'tvdb', media_type: 'tv', title: 'From TVDB', ids: { tmdb: '4321' } } },
            { item: { media_id: '99', source: 'igdb', media_type: 'game', title: 'A game' } },
          ],
        }
      ),
      [`${WM}/api/v1/media/`]: (u: URL, init?: RequestInit) => {
        seen(init);
        const m = u.pathname.match(/^\/api\/v1\/media\/(movie|tv)\/tmdb\/(\d+)\/lists(?:\/(\d+))?$/);
        if (!m) return new Response('{"detail":"Unsupported media type."}', { status: 400 });
        const key = `${m[1]}:${m[2]}`;
        if (!m[3]) return { pagination: { total: 1, next: null }, results: lifetime.has(key) ? [{ list_id: 68, list_item_id: 1 }] : [] };
        if (Number(m[3]) !== 68) return new Response('{"detail":"List not found."}', { status: 404 });
        if (locked) return new Response('{"detail":"Forbidden"}', { status: 403 });
        if (init?.method === 'PUT') {
          if (lifetime.has(key)) return new Response('{"detail":"Media already in the list."}', { status: 409 });
          lifetime.add(key);
          return [];
        }
        if (!lifetime.delete(key)) return new Response('{"detail":"Media not found in the list."}', { status: 404 });
        return new Response(null, { status: 204 });
      },
    });
    await owner.req('PUT', '/api/settings/metadata', { tmdbApiKey: 'k' });
    const m = await createUser(owner, 'mgr', 'manager');
    manager = new Client(t.app);
    await manager.login('mgr', m.password);
    const u = await createUser(owner, 'kid', 'user');
    user = new Client(t.app);
    await user.login('kid', u.password);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  const connect = () => owner.req('PUT', '/api/settings/watchmask', { enabled: true, url: WM, token: TOKEN, defaultListId: 68 });

  it('stays out of the way until connected, and keeps the token secret', async () => {
    expect((await manager.req('GET', '/api/watchmask/lists')).json()).toEqual({ connected: false, defaultListId: null, lists: [] });
    expect((await manager.req('PUT', '/api/watchmask/titles/movie/2002/lists/68', {})).statusCode).toBe(400);
    expect((await connect()).statusCode).toBe(200);
    expect((await owner.req('GET', '/api/settings/watchmask')).body).not.toContain(TOKEN);
    expect(JSON.stringify(t.app.ctx.dbHandle.sqlite.prepare('SELECT * FROM settings').all())).not.toContain(TOKEN);
    const test = (await owner.req('POST', '/api/integrations/watchmask/test')).json();
    expect(test).toMatchObject({ ok: true, message: expect.stringContaining('2 lists') });
    expect(auth.every((a) => a === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('lets managers add a title to the default list, and plain users cannot', async () => {
    await connect();
    const lists = (await manager.req('GET', '/api/watchmask/lists')).json();
    expect(lists).toMatchObject({ connected: true, defaultListId: 68, lists: [{ id: 68, name: 'Lifetime' }, { id: 70 }] });
    expect((await manager.req('GET', '/api/watchmask/titles/movie/2002')).json()).toEqual({ listIds: [] });

    // Users browse and request; Watchmask lists belong to whoever's token is saved.
    expect((await user.req('GET', '/api/watchmask/lists')).statusCode).toBe(403);
    expect((await user.req('PUT', '/api/watchmask/titles/movie/2002/lists/68', {})).statusCode).toBe(403);
    expect(lifetime.has('movie:2002')).toBe(false);

    expect((await manager.req('PUT', '/api/watchmask/titles/movie/2002/lists/68', { title: 'Mother, May I?' })).json()).toEqual({ ok: true, added: true });
    expect(lifetime.has('movie:2002')).toBe(true);
    expect((await manager.req('GET', '/api/watchmask/titles/movie/2002')).json()).toEqual({ listIds: [68] });
    // Adding it again is fine, and isn't logged twice.
    expect((await manager.req('PUT', '/api/watchmask/titles/movie/2002/lists/68', {})).json()).toEqual({ ok: true, added: false });
    // Shows travel as Watchmask's "tv".
    expect((await manager.req('PUT', '/api/watchmask/titles/show/82728/lists/68', {})).json().added).toBe(true);
    expect(lifetime.has('tv:82728')).toBe(true);

    expect((await manager.req('DELETE', '/api/watchmask/titles/movie/2002/lists/68', { title: 'Mother, May I?' })).json()).toEqual({ ok: true, removed: true });
    expect(lifetime.has('movie:2002')).toBe(false);

    const log = t.app.ctx.db.select().from(auditLog).all().filter((a) => a.action.startsWith('watchmask.'));
    expect(log.map((a) => `${a.action} ${a.target}`)).toEqual(['watchmask.added Mother, May I?', 'watchmask.added show 82728', 'watchmask.removed Mother, May I?']);
  });

  it('validates input and explains a token that may not write the list', async () => {
    await connect();
    expect((await manager.req('PUT', '/api/watchmask/titles/book/1/lists/68', {})).statusCode).toBe(400);
    expect((await manager.req('PUT', '/api/watchmask/titles/movie/abc/lists/68', {})).statusCode).toBe(400);
    expect((await manager.req('PUT', '/api/watchmask/titles/movie/1/lists/-3', {})).statusCode).toBe(400);
    locked = true;
    const r = await manager.req('PUT', '/api/watchmask/titles/movie/2002/lists/68', {});
    expect(r.statusCode).toBe(502);
    expect(r.json().error ?? r.body).toMatch(/lists:write/);
    expect(r.body).not.toContain(TOKEN);
    expect(r.body).not.toContain('track.example.com');
  });

  it('follows a Watchmask list on Lists, only on the connected address', async () => {
    expect((await owner.req('POST', '/api/lists', { name: 'Lifetime', url: `${WM}/list/68` })).statusCode).toBe(400);
    await connect();
    const list = (await owner.req('POST', '/api/lists', { name: 'Lifetime', url: `${WM}/list/68` })).json();
    expect(list).toMatchObject({ source: 'watchmask', config: { ref: '68' }, sync: { ok: true, items: 3 } });
    const items = (await owner.req('GET', `/api/lists/${list.id}/items`)).json().items;
    expect(items.map((i: { kind: string; tmdbId: number }) => `${i.kind}:${i.tmdbId}`)).toEqual(['movie:1001', 'show:82728', 'show:4321']);
    expect(items[0]).toMatchObject({ title: 'A Deadly Affair', year: 2024, posterPath: '/abc.jpg' });

    // A public link name works too.
    const bySlug = (await owner.req('POST', '/api/lists', { name: 'Lifetime 2', url: `${WM}/list/lifetime-movies` })).json();
    expect(bySlug.sync).toMatchObject({ ok: true, items: 3 });

    // Another server's /list/ link never gets the saved token.
    const before = auth.length;
    expect((await owner.req('POST', '/api/lists', { name: 'Elsewhere', url: 'https://evil.example.com/list/68' })).statusCode).toBe(400);
    expect((await owner.req('POST', '/api/lists', { name: 'Downgrade', url: 'http://track.example.com/list/68' })).statusCode).toBe(400);
    expect(auth.length).toBe(before);
    // Managers may add lists; users may not.
    expect((await user.req('POST', '/api/lists', { name: 'Nope', url: `${WM}/list/68` })).statusCode).toBe(403);
  });

  it('reads only movies and shows with TMDB ids from Watchmask entries', () => {
    expect(entryFromWatchmask({ item: { media_id: '5', source: 'tmdb', media_type: 'movie', title: 'X', image: 'https://evil.example.com/p.jpg' } })).toEqual({ kind: 'movie', tmdbId: 5, title: 'X', year: null, posterPath: null });
    expect(entryFromWatchmask({ item: { media_id: '5', source: 'mal', media_type: 'anime', title: 'Y' } })).toBeNull();
    expect(entryFromWatchmask({ item: { media_id: 'x', source: 'tmdb', media_type: 'movie' } })).toBeNull();
  });
});
