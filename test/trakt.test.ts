import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { fakeFetch, tmdbRoutes } from './fakes.js';
import { watchlistItems } from '../src/server/db/schema.js';

const T = 'https://api.trakt.tv';

describe('Trakt', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let owner: Client;
  let kid: Client;
  let polls = 0;
  let headers: Record<string, string>[] = [];
  beforeEach(async () => {
    t = await makeApp();
    owner = await setupOwner(t.app);
    polls = 0;
    headers = [];
    const seen = (init?: RequestInit) => headers.push(Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)));
    fakeFetch({
      ...tmdbRoutes,
      [`${T}/oauth/device/code`]: () => ({ device_code: 'dev-123', user_code: 'ABCD1234', verification_url: 'https://trakt.tv/activate', expires_in: 600, interval: 5 }),
      [`${T}/oauth/device/token`]: () => (++polls < 2 ? new Response('', { status: 400 }) : { access_token: 'acc', refresh_token: 'ref', expires_in: 7776000, created_at: Math.floor(Date.now() / 1000) }),
      [`${T}/users/settings`]: () => ({ user: { username: 'Kiddo', ids: { slug: 'kiddo' } } }),
      [`${T}/sync/watchlist/movies`]: (_u: URL, init?: RequestInit) => (seen(init), [{ type: 'movie', movie: { title: 'Paddington', year: 2014, ids: { tmdb: 116149 } } }]),
      [`${T}/sync/watchlist/shows`]: () => [{ type: 'show', show: { title: 'Bluey', year: 2018, ids: { tmdb: 82728 } } }],
      [`${T}/users/someone/lists/family-night/items`]: () => [{ type: 'movie', movie: { title: 'Paddington', year: 2014, ids: { tmdb: 116149 } } }, { type: 'episode', episode: {} }],
      [`${T}/movies/popular`]: () => [{ title: 'Future Film', year: 2099, ids: { tmdb: 555 } }],
    });
    await owner.req('PUT', '/api/settings/metadata', { tmdbApiKey: 'k' });
    const u = await createUser(owner, 'kid', 'user');
    kid = new Client(t.app);
    await kid.login('kid', u.password);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  it('links with a device code and turns the Trakt watchlist into requests', async () => {
    expect((await kid.req('POST', '/api/trakt/link', {})).statusCode).toBe(502); // no Trakt app yet
    await owner.req('PUT', '/api/settings/trakt', { clientId: 'client-1', clientSecret: 'shh' });
    expect((await owner.req('GET', '/api/settings/trakt')).body).not.toContain('shh');
    const link = (await kid.req('POST', '/api/trakt/link', {})).json();
    expect(link).toMatchObject({ userCode: 'ABCD1234', url: 'https://trakt.tv/activate' });
    expect(JSON.stringify(link)).not.toContain('dev-123');
    // Someone else can't use the token.
    expect((await owner.req('POST', '/api/trakt/link/poll', { token: link.token })).json()).toEqual({ status: 'expired' });
    expect((await kid.req('POST', '/api/trakt/link/poll', { token: link.token })).json().status).toBe('pending');
    expect((await kid.req('POST', '/api/trakt/link/poll', { token: link.token })).json()).toEqual({ status: 'linked', username: 'kiddo' });
    expect((await kid.req('GET', '/api/trakt/me')).json()).toEqual({ configured: true, linked: true, username: 'kiddo' });
    expect(JSON.stringify(t.app.ctx.dbHandle.sqlite.prepare('SELECT trakt_token FROM users').all())).not.toContain('acc');

    const on = (await kid.req('PUT', '/api/watchlist/me', { sync: true })).json();
    expect(on.sources.trakt).toBe(true);
    await vi.waitFor(() => expect(t.app.ctx.db.select().from(watchlistItems).all().map((i) => `${i.source}:${i.kind}:${i.tmdbId}`).sort()).toEqual(['trakt:movie:116149', 'trakt:show:82728']));
    expect(headers[0]).toMatchObject({ Authorization: 'Bearer acc', 'trakt-api-key': 'client-1', 'trakt-api-version': '2' });

    expect((await kid.req('DELETE', '/api/trakt/link')).statusCode).toBe(200);
    expect((await kid.req('GET', '/api/trakt/me')).json().linked).toBe(false);
  });

  it('adds Trakt lists and charts on Lists', async () => {
    await owner.req('PUT', '/api/settings/trakt', { clientId: 'client-1', clientSecret: 'shh' });
    const list = (await owner.req('POST', '/api/lists', { name: 'Family night', url: 'https://trakt.tv/users/someone/lists/family-night' })).json();
    expect(list).toMatchObject({ source: 'trakt', sync: { ok: true, items: 1 } });
    const chart = (await owner.req('POST', '/api/lists', { name: 'Popular', url: 'https://trakt.tv/movies/popular' })).json();
    expect(chart.sync).toMatchObject({ ok: true, items: 1 });
    expect((await owner.req('POST', '/api/lists', { name: 'Bad', url: 'https://trakt.tv/users/../../oauth' })).statusCode).toBe(400);
  });
});
