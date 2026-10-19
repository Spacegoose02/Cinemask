import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';

let t: Awaited<ReturnType<typeof makeApp>>;
let owner: Client;
beforeEach(async () => {
  t = await makeApp();
  owner = await setupOwner(t.app);
});
afterEach(async () => t.close());

async function signIn(username: string, password: string) {
  const c = new Client(t.app);
  await c.login(username, password);
  return c;
}

describe('user management', () => {
  it('only the owner can create admins', async () => {
    const admin = await createUser(owner, 'second-admin', 'admin');
    const c = await signIn('second-admin', admin.password);
    const res = await c.req('POST', '/api/users', { username: 'third', password: 'third-long-password', role: 'admin' });
    expect(res.statusCode).toBe(403);
    const ok = await c.req('POST', '/api/users', { username: 'kid', password: 'family-tv-night-2026', role: 'user' });
    expect(ok.statusCode).toBe(200);
  });

  it('admins cannot change or delete the owner', async () => {
    const admin = await createUser(owner, 'second-admin', 'admin');
    const c = await signIn('second-admin', admin.password);
    expect((await c.req('PATCH', '/api/users/1', { disabled: true })).statusCode).toBe(403);
    expect((await c.req('DELETE', '/api/users/1')).statusCode).toBe(403);
  });

  it('the owner cannot be demoted, disabled or deleted', async () => {
    expect((await owner.req('PATCH', '/api/users/1', { role: 'user' })).statusCode).toBe(400);
    expect((await owner.req('PATCH', '/api/users/1', { disabled: true })).statusCode).toBe(400);
    expect((await owner.req('DELETE', '/api/users/1')).statusCode).toBe(400);
  });

  it('a demotion takes effect on the very next request', async () => {
    const m = await createUser(owner, 'mgr', 'manager');
    const c = await signIn('mgr', m.password);
    await owner.req('PATCH', `/api/users/${m.id}`, { role: 'user' });
    // Role changes also sign the user out, so the old session is gone.
    expect((await c.req('GET', '/api/auth/me')).statusCode).toBe(401);
  });

  it('disabling a user ends their sessions and blocks login', async () => {
    const u = await createUser(owner, 'kid', 'user');
    const c = await signIn('kid', u.password);
    await owner.req('PATCH', `/api/users/${u.id}`, { disabled: true });
    expect((await c.req('GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await new Client(t.app).login('kid', u.password)).statusCode).toBe(401);
  });

  it('never returns password hashes', async () => {
    await createUser(owner, 'kid', 'user');
    const res = await owner.req('GET', '/api/users');
    expect(res.body).not.toContain('argon2');
    expect(res.body).not.toContain('passwordHash');
  });

  it('rejects duplicate usernames regardless of case', async () => {
    await createUser(owner, 'kid', 'user');
    const res = await owner.req('POST', '/api/users', { username: 'KID', password: 'family-tv-night-2027', role: 'user' });
    expect(res.statusCode).toBe(409);
  });
});
