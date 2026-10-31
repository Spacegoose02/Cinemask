import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { topicForRoute } from '../src/server/live/bus.js';

let t: Awaited<ReturnType<typeof makeApp>>;
let owner: Client;
let kid: Client;
let manager: Client;
let base: string;

beforeAll(async () => {
  t = await makeApp();
  owner = await setupOwner(t.app);
  const k = await createUser(owner, 'kid', 'user');
  kid = new Client(t.app);
  await kid.login('kid', k.password);
  const m = await createUser(owner, 'boss', 'manager');
  manager = new Client(t.app);
  await manager.login('boss', m.password);
  base = await t.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => t.close());

/** Opens /api/events as a browser would and collects the topics it hears. */
function listen(client: Client) {
  return new Promise<{ res: http.IncomingMessage; topics: string[]; close: () => Promise<void> }>((resolve, reject) => {
    const topics: string[] = [];
    let text = '';
    let resolved = false;
    // A fresh connection per stream (no keep-alive pool), closed for good when the "tab" goes away.
    const req = http.get(`${base}/api/events`, { headers: { cookie: client.cookie }, agent: false }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
        for (const m of text.matchAll(/^data: (\{"topic".*\})$/gm)) topics.push(JSON.parse(m[1]!).topic);
        if (!resolved && text.includes('event: ready')) {
          resolved = true;
          resolve({ res, topics, close: async () => void req.destroy() });
        }
        text = text.slice(text.lastIndexOf('\n\n') + 2);
      });
    });
    req.on('error', (e) => !resolved && reject(e));
  });
}

/** Status code of a one-off request to the real server. */
function statusOf(headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const req = http.get(`${base}/api/events`, { headers, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on('error', reject);
  });
}

const settle = () => new Promise((r) => setTimeout(r, 100));

describe('live updates', () => {
  it('needs a signed-in browser session, not an API key', async () => {
    expect(await statusOf()).toBe(401);
    const key = (await kid.req('POST', '/api/auth/api-keys', { name: 'Script', access: 'full' })).json().key as string;
    expect(await statusOf({ 'x-api-key': key })).toBe(403);
  });

  it('streams as text/event-stream with the security headers', async () => {
    const s = await listen(kid);
    expect(s.res.headers['content-type']).toContain('text/event-stream');
    expect(s.res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    // Left open on purpose: shutting the server down must not wait for it.
  });

  it('only tells each user about changes their role can see', async () => {
    const kidStream = await listen(kid);
    const bossStream = await listen(manager);

    t.app.ctx.live.publish({ topic: 'downloads', access: 'manager' });
    t.app.ctx.live.publish({ topic: 'health', access: 'admin' });
    t.app.ctx.live.publish({ topic: 'backups', access: 'owner' });
    t.app.ctx.live.publish({ topic: 'library', access: 'user' });
    await settle();

    expect(kidStream.topics).toEqual(['library']);
    expect(bossStream.topics).toEqual(['downloads', 'library']);
    await kidStream.close();
    await bossStream.close();
  });

  it('announces successful writes, at the access level of the route', async () => {
    const kidStream = await listen(kid);
    const bossStream = await listen(manager);

    // A manager-only write: the kid isn't told.
    expect((await manager.req('POST', '/api/lists', { name: 'Halloween', source: 'manual' })).statusCode).toBeLessThan(500);
    // A user-level write: everyone is told.
    expect((await kid.req('PUT', '/api/home/layout', { rows: [{ type: 'featured' }] })).statusCode).toBe(200);
    // Failed writes and reads say nothing.
    expect((await kid.req('PUT', '/api/home/layout', { rows: 'nope' })).statusCode).toBe(400);
    await kid.req('GET', '/api/home/layout');
    await settle();

    expect(kidStream.topics).toEqual(['home']);
    expect(bossStream.topics.filter((x) => x === 'home')).toHaveLength(1);
    await kidStream.close();
    await bossStream.close();
  });

  it('stops listening when the tab goes away', async () => {
    await settle();
    const before = t.app.ctx.live.listeners;
    const s = await listen(kid);
    expect(t.app.ctx.live.listeners).toBe(before + 1);
    await s.close();
    await settle();
    expect(t.app.ctx.live.listeners).toBe(before);
  });

  it('keeps sign-in and the stream itself quiet', () => {
    expect(topicForRoute('/api/auth/login')).toBeNull();
    expect(topicForRoute('/api/events')).toBeNull();
    expect(topicForRoute('/api/requests/:id/approve')).toBe('requests');
  });
});
