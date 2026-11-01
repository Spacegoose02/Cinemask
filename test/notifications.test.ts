import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import webpush from 'web-push';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { fakeFetch, tmdbRoutes } from './fakes.js';
import { notify } from '../src/server/notify/service.js';
import { allowedPushEndpoint } from '../src/server/notify/personal.js';

let t: Awaited<ReturnType<typeof makeApp>>;
let owner: Client;
let kid: Client;
let sib: Client;
let pushed: { endpoint: string; payload: Record<string, string> }[];
let posted: { url: string; body: string }[];

const flush = () => new Promise((r) => setTimeout(r, 30));
const sub = (n: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' }, device: 'Chrome on Android' });

beforeEach(async () => {
  t = await makeApp();
  owner = await setupOwner(t.app);
  posted = [];
  const record = (url: URL, init?: RequestInit) => (posted.push({ url: url.toString(), body: String(init?.body) }), { ok: true });
  fakeFetch({ ...tmdbRoutes, 'https://discord.com/api/webhooks/': record, 'https://api.telegram.org/': record, 'https://ntfy.example/': record });
  await owner.req('PUT', '/api/settings/metadata', { tmdbApiKey: 'k' });
  for (const [name, set] of [
    ['kid', (c: Client) => (kid = c)],
    ['sib', (c: Client) => (sib = c)],
  ] as const) {
    const u = await createUser(owner, name, 'user');
    const c = new Client(t.app);
    await c.login(name, u.password);
    set(c);
  }
  pushed = [];
  vi.spyOn(webpush, 'sendNotification').mockImplementation(async (s, payload) => {
    pushed.push({ endpoint: s.endpoint, payload: JSON.parse(String(payload)) });
    return { statusCode: 201, body: '', headers: {} };
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await t.close();
});

describe('push notifications', () => {
  it('only accepts subscriptions from real browser push services', async () => {
    expect(allowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(allowedPushEndpoint('https://web.push.apple.com/x')).toBe(true);
    expect(allowedPushEndpoint('http://fcm.googleapis.com/x')).toBe(false);
    expect(allowedPushEndpoint('https://192.168.1.10/x')).toBe(false);
    expect(allowedPushEndpoint('https://fcm.googleapis.com.evil.example/x')).toBe(false);
    expect((await kid.req('POST', '/api/notifications/push', { ...sub('a'), endpoint: 'https://router.local/push' })).statusCode).toBe(400);
    expect((await kid.req('POST', '/api/notifications/push', sub('a'))).statusCode).toBe(200);
    const me = (await kid.req('GET', '/api/notifications/me')).json();
    expect(me.publicKey).toMatch(/^[\w-]{80,}$/);
    expect(me.devices).toEqual([expect.objectContaining({ device: 'Chrome on Android' })]);
  });

  it("tells the requester and everyone who said me too when it's declined, and not others", async () => {
    await kid.req('POST', '/api/notifications/push', sub('kid'));
    await sib.req('POST', '/api/notifications/push', sub('sib'));
    const r = (await kid.req('POST', '/api/requests', { kind: 'movie', tmdbId: 116149 })).json();
    await flush();
    pushed = [];
    await owner.req('POST', `/api/requests/${r.id}/decline`, { reason: 'Already on Netflix' });
    await flush();
    expect(pushed).toEqual([{ endpoint: sub('kid').endpoint, payload: expect.objectContaining({ title: 'Request declined', url: '/movie/116149' }) }]);
    expect(pushed[0]!.payload.body).toMatch(/Already on Netflix/);
  });

  it('managers hear about new requests; people can turn events off', async () => {
    await kid.req('POST', '/api/notifications/push', sub('kid'));
    await owner.req('POST', '/api/notifications/push', sub('owner'));
    await kid.req('POST', '/api/requests', { kind: 'movie', tmdbId: 116149 });
    await flush();
    expect(pushed.map((p) => p.endpoint)).toEqual([sub('owner').endpoint]);
    pushed = [];
    await owner.req('PUT', '/api/notifications/me', { push: true, email: false, off: ['request.created'] });
    await sib.req('POST', '/api/requests', { kind: 'movie', tmdbId: 555 });
    await flush();
    expect(pushed.map((p) => p.payload.title)).toEqual([]);
  });

  it('forgets a device the push service says is gone', async () => {
    await kid.req('POST', '/api/notifications/push', sub('kid'));
    vi.mocked(webpush.sendNotification).mockRejectedValueOnce(Object.assign(new Error('Gone'), { statusCode: 410 }));
    notify(t.app.ctx, { event: 'movie_night.created', title: 'Movie night', message: 'Friday' });
    await flush();
    expect((await kid.req('GET', '/api/notifications/me')).json().devices).toEqual([]);
  });

  it("people can only remove their own devices, and a test needs somewhere to go", async () => {
    await kid.req('POST', '/api/notifications/push', sub('kid'));
    const [dev] = (await kid.req('GET', '/api/notifications/me')).json().devices;
    expect((await sib.req('DELETE', `/api/notifications/push/${dev.id}`)).statusCode).toBe(404);
    expect((await sib.req('POST', '/api/notifications/me/test', {})).json()).toMatchObject({ ok: false });
    expect((await kid.req('POST', '/api/notifications/me/test', {})).json()).toMatchObject({ ok: true, message: 'Sent to 1 device.' });
    expect((await kid.req('DELETE', `/api/notifications/push/${dev.id}`)).statusCode).toBe(200);
  });

  it("people can set their own email address and choices, but only for events they can hear about", async () => {
    const res = await kid.req('PUT', '/api/notifications/me', { push: false, email: true, off: ['health.problem', 'request.approved'], address: 'kid@example.com' });
    expect(res.json().off).toEqual(['request.approved']);
    expect((await kid.req('PUT', '/api/notifications/me', { push: true, email: false, off: [], address: 'not-an-email' })).statusCode).toBe(400);
    const me = (await kid.req('GET', '/api/notifications/me')).json();
    expect(me.email).toBe('kid@example.com');
    expect(me.events).not.toContain('health.problem');
    expect(me.events).toContain('request.available');
  });
});

describe('shared channels', () => {
  it('sends chosen events to Discord, Telegram and ntfy, and keeps their secrets', async () => {
    await owner.req('PUT', '/api/settings/general', { baseUrl: 'https://media.example.com' });
    await owner.req('PUT', '/api/settings/notifications', {
      enabled: true,
      events: ['request.created'],
      discordWebhookUrl: 'https://discord.com/api/webhooks/1/secret-token',
      telegramBotToken: '123:bot-secret',
      telegramChatId: '-1001234',
      ntfyUrl: 'https://ntfy.example/family-secret',
    });
    expect((await owner.req('GET', '/api/settings/notifications')).body).not.toMatch(/secret-token|bot-secret|family-secret/);
    await kid.req('POST', '/api/requests', { kind: 'movie', tmdbId: 116149 });
    await flush();
    const discord = posted.find((p) => {
      try {
        const u = new URL(p.url);
        return u.protocol === 'https:' && u.hostname === 'discord.com';
      } catch {
        return false;
      }
    })!;
    expect(JSON.parse(discord.body).embeds[0]).toMatchObject({ title: 'New request', url: 'https://media.example.com/movie/116149' });
    expect(posted.find((p) => p.url.includes('api.telegram.org/bot123'))!.body).toContain('-1001234');
    expect(posted.find((p) => p.url.startsWith('https://ntfy.example/'))!.body).toMatch(/requested Paddington/);
    posted = [];
    notify(t.app.ctx, { event: 'download.failed', title: 'x', message: 'not chosen' });
    await flush();
    expect(posted).toEqual([]);
  });

  it('tests one channel at a time, admins only', async () => {
    await owner.req('PUT', '/api/settings/notifications', { discordWebhookUrl: 'https://discord.com/api/webhooks/1/secret-token' });
    expect((await kid.req('POST', '/api/notifications/test', { channel: 'discord' })).statusCode).toBe(403);
    expect((await owner.req('POST', '/api/notifications/test', { channel: 'gotify' })).statusCode).toBe(400);
    expect((await owner.req('POST', '/api/notifications/test', { channel: 'discord' })).json()).toEqual({ ok: true, message: 'Sent a test to Discord' });
    expect((await kid.req('POST', '/api/notifications/email/test', {})).statusCode).toBe(403);
  });
});
