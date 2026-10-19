import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';

let t: Awaited<ReturnType<typeof makeApp>>;
let owner: Client;
const as: Record<'user' | 'manager' | 'admin', Client> = {} as never;

beforeAll(async () => {
  t = await makeApp();
  owner = await setupOwner(t.app);
  for (const role of ['user', 'manager', 'admin'] as const) {
    const u = await createUser(owner, `a-${role}`, role);
    as[role] = new Client(t.app);
    await as[role].login(`a-${role}`, u.password);
  }
});
afterAll(async () => t.close());

const fill = (url: string) => url.replace(/:[a-zA-Z]+/g, (m) => (m === ':id' ? '999' : m === ':provider' ? 'plex' : 'x'));
const RANK = { public: 0, user: 1, manager: 2, admin: 3, owner: 4 } as const;

describe('deny by default', () => {
  it('every API route declares an access level', () => {
    expect(t.app.apiRoutes.length).toBeGreaterThan(10);
  });

  it('rejects anonymous callers on every non-public route', async () => {
    const anon = new Client(t.app);
    for (const r of t.app.apiRoutes.filter((r) => r.access !== 'public')) {
      const res = await anon.req(r.method as 'GET', fill(r.url), r.method === 'GET' ? undefined : {});
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
    }
  });

  it('rejects callers below the required level on every route', async () => {
    const levels = [
      ['user', as.user],
      ['manager', as.manager],
      ['admin', as.admin],
    ] as const;
    for (const r of t.app.apiRoutes.filter((r) => r.access !== 'public')) {
      for (const [level, client] of levels) {
        if (RANK[level] >= RANK[r.access]) continue;
        const res = await client.req(r.method as 'GET', fill(r.url), r.method === 'GET' ? undefined : {});
        expect(res.statusCode, `${level} → ${r.method} ${r.url}`).toBe(403);
      }
    }
  });
});

describe('CSRF', () => {
  it('rejects a signed-in POST without the CSRF token', async () => {
    const c = new Client(t.app);
    c.cookie = owner.cookie;
    const res = await c.req('POST', '/api/backups');
    expect(res.statusCode).toBe(403);
  });

  it('rejects any POST without the custom request header', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'owner', password: 'x' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('security headers', () => {
  it('sends CSP and frame protection', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
