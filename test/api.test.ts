import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { notify } from '../src/server/notify/service.js';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { fakeFetch } from './fakes.js';

let t: Awaited<ReturnType<typeof makeApp>>;
let owner: Client;
let kid: Client;
let adminKey: string;
let kidRead: string;
let kidFull: string;
let kidPassword: string;

const fill = (url: string) => url.replace(/:[a-zA-Z]+/g, (m) => (m === ':id' ? '999' : m === ':provider' ? 'plex' : 'x'));
const withKey = (key: string, method: string, url: string, body?: unknown) =>
  // No cookie and no CSRF header: what a script or Home Assistant sends.
  t.app.inject({ method: method as 'GET', url, payload: body as never, headers: { 'x-api-key': key } });

beforeAll(async () => {
  t = await makeApp();
  owner = await setupOwner(t.app);
  const u = await createUser(owner, 'kid', 'user');
  kidPassword = u.password;
  kid = new Client(t.app);
  await kid.login('kid', u.password);
  adminKey = (await owner.req('POST', '/api/auth/api-keys', { name: 'Home Assistant', access: 'full' })).json().key;
  kidRead = (await kid.req('POST', '/api/auth/api-keys', { name: 'Read only' })).json().key;
  kidFull = (await kid.req('POST', '/api/auth/api-keys', { name: 'Script', access: 'full' })).json().key;
});
afterAll(async () => t.close());
afterEach(() => vi.unstubAllGlobals());

describe('API keys', () => {
  it('are shown once, stored only as a hash, and listed by prefix', async () => {
    expect(adminKey).toMatch(/^cmk_[\w-]{30,}$/);
    const raw = JSON.stringify(t.app.ctx.dbHandle.sqlite.prepare('SELECT * FROM api_keys').all());
    expect(raw).not.toContain(adminKey);
    const listed = (await owner.req('GET', '/api/auth/api-keys')).json();
    expect(listed).toEqual([expect.objectContaining({ name: 'Home Assistant', prefix: adminKey.slice(0, 10), access: 'full' })]);
    expect(JSON.stringify(listed)).not.toContain(adminKey);
  });

  it('authenticate as their owner, by header only', async () => {
    expect((await withKey(kidRead, 'GET', '/api/auth/me')).json().user.username).toBe('kid');
    const bearer = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${kidRead}` } });
    expect(bearer.json().user.username).toBe('kid');
    expect((await t.app.inject({ method: 'GET', url: `/api/auth/me?api_key=${kidRead}` })).statusCode).toBe(401);
    expect((await withKey('cmk_not-a-real-key-000000000000000000', 'GET', '/api/auth/me')).statusCode).toBe(401);
  });

  it('never reach account, key, settings or user management routes, on any route', async () => {
    for (const r of t.app.apiRoutes) {
      const res = await withKey(adminKey, r.method, fill(r.url), r.method === 'GET' ? undefined : {});
      if (!r.apiKey) expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
      else expect([401, 403].includes(res.statusCode) && res.json().error === 'API keys cannot use this endpoint', `${r.method} ${r.url}`).toBe(false);
    }
    for (const url of ['/api/auth/api-keys', '/api/auth/sessions', '/api/settings/plex', '/api/users', '/api/backups']) {
      expect((await withKey(adminKey, 'GET', url)).statusCode, url).toBe(403);
    }
    expect((await withKey(adminKey, 'POST', '/api/auth/api-keys', { name: 'x' })).statusCode).toBe(403);
  });

  it("follow the owner's role and the key's read/full access", async () => {
    expect((await withKey(kidFull, 'GET', '/api/downloads')).statusCode).toBe(403); // kid is a user, downloads need manager
    expect((await withKey(kidRead, 'GET', '/api/requests')).statusCode).toBe(200);
    expect((await withKey(kidRead, 'POST', '/api/requests', { kind: 'movie', tmdbId: 1 })).json().error).toBe('This API key is read-only');
    // A full key can write without CSRF headers (it reached validation, not the CSRF check).
    expect((await withKey(kidFull, 'POST', '/api/books', { workKey: 'bad', format: 'ebook' })).statusCode).toBe(400);
  });

  it('stop working when revoked, disabled, expired or turned off', async () => {
    const temp = (await kid.req('POST', '/api/auth/api-keys', { name: 'Temp', expiresDays: 1 })).json();
    expect((await withKey(temp.key, 'GET', '/api/stats')).statusCode).toBe(200);
    t.app.ctx.dbHandle.sqlite.prepare('UPDATE api_keys SET expires_at = 1 WHERE id = ?').run(temp.id);
    expect((await withKey(temp.key, 'GET', '/api/stats')).statusCode).toBe(401);

    const all = (await owner.req('GET', '/api/api-keys')).json();
    expect(all.map((k: { username: string }) => k.username).sort()).toEqual(['kid', 'kid', 'kid', 'owner']);
    expect((await kid.req('GET', '/api/api-keys')).statusCode).toBe(403);
    const script = all.find((k: { name: string }) => k.name === 'Script');
    expect((await kid.req('DELETE', `/api/auth/api-keys/${all.find((k: { name: string }) => k.name === 'Home Assistant').id}`)).statusCode).toBe(404);
    expect((await owner.req('DELETE', `/api/api-keys/${script.id}`)).statusCode).toBe(200);
    expect((await withKey(kidFull, 'GET', '/api/stats')).statusCode).toBe(401);

    await owner.req('PUT', '/api/settings/auth', { apiKeysEnabled: false });
    expect((await withKey(kidRead, 'GET', '/api/stats')).statusCode).toBe(401);
    await owner.req('PUT', '/api/settings/auth', { apiKeysEnabled: true });
    const kidId = (await owner.req('GET', '/api/users')).json().find((u: { username: string }) => u.username === 'kid').id;
    await owner.req('PATCH', `/api/users/${kidId}`, { disabled: true });
    expect((await withKey(kidRead, 'GET', '/api/stats')).statusCode).toBe(401);
    await owner.req('PATCH', `/api/users/${kidId}`, { disabled: false });
    await kid.login('kid', kidPassword); // disabling signed kid out
  });
});

describe('stats, OpenAPI and themes', () => {
  it('stats hide health from non-admins', async () => {
    // The scheduler calls these on the root app, so they must not be hidden inside the health plugin.
    expect(typeof t.app.runHealth).toBe('function');
    await t.app.runHealth();
    const mine = (await withKey(kidRead, 'GET', '/api/stats')).json();
    expect(mine).toMatchObject({ library: { movies: 0, shows: 0 }, requests: { pending: 0 }, downloads: { active: 0 }, health: null });
    const adminStats = await withKey(adminKey, 'GET', '/api/stats');
    expect(adminStats.json().health).toMatchObject({ level: 'error', problems: expect.any(Number) }); // no TMDB key or folders in a test install
    expect((await withKey(adminKey, 'GET', '/api/system/health/summary')).statusCode).toBe(200);
  });

  it('describes every route in OpenAPI', async () => {
    const spec = (await withKey(kidRead, 'GET', '/api/openapi.json')).json();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.paths['/api/requests/{id}/approve'].post['x-access']).toBe('manager');
    expect(spec.paths['/api/auth/api-keys'].get['x-api-key']).toBe(false);
    const ops = Object.values(spec.paths as Record<string, object>).reduce((n, p) => n + Object.keys(p).length, 0);
    expect(ops).toBe(t.app.apiRoutes.length);
  });

  it('saves a theme per user', async () => {
    expect((await kid.req('PUT', '/api/auth/theme', { theme: 'retro' })).statusCode).toBe(200);
    expect((await kid.req('GET', '/api/auth/me')).json().user.theme).toBe('retro');
    expect((await kid.req('PUT', '/api/auth/theme', { theme: '<script>' })).statusCode).toBe(400);
  });
});

describe('webhook notifications', () => {
  it('posts chosen events as JSON, keeps the URL secret, and can be tested', async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    fakeFetch({
      'http://homeassistant.local:8123/api/webhook/': (url: URL, init?: RequestInit) => {
        sent.push({ url: url.toString(), body: JSON.parse(String(init?.body)) });
        return { ok: true };
      },
    });
    const hook = 'http://homeassistant.local:8123/api/webhook/cinemask-secret-id';
    await owner.req('PUT', '/api/settings/notifications', { enabled: true, webhookUrl: hook, events: ['request.created'] });
    expect((await owner.req('GET', '/api/settings/notifications')).body).not.toContain('secret-id');
    expect((await kid.req('POST', '/api/notifications/test')).statusCode).toBe(403);
    expect((await owner.req('POST', '/api/notifications/test')).json()).toEqual({ ok: true, message: 'Sent a test event' });

    notify(t.app.ctx, { event: 'request.created', title: 'New request', message: 'kid requested Paddington' });
    notify(t.app.ctx, { event: 'download.failed', title: 'Download failed', message: 'not subscribed' });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.body).toMatchObject({ source: 'cinemask', event: 'request.created', message: 'kid requested Paddington' });
    expect(sent.some((s) => s.body.event === 'download.failed')).toBe(false);
  });
});
