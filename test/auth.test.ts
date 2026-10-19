import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, makeApp, OWNER, setupOwner } from './helpers.js';

let t: Awaited<ReturnType<typeof makeApp>>;
beforeEach(async () => (t = await makeApp()));
afterEach(async () => t.close());

describe('first-run setup', () => {
  it('reports that setup is needed on a fresh install', async () => {
    const res = await new Client(t.app).req('GET', '/api/auth/status');
    expect(res.json()).toMatchObject({ needsSetup: true, signedIn: false });
  });

  it('creates the owner once and refuses a second setup', async () => {
    const owner = await setupOwner(t.app);
    const me = await owner.req('GET', '/api/auth/me');
    expect(me.json().user).toMatchObject({ username: 'owner', role: 'admin', isOwner: true });
    const again = await new Client(t.app).req('POST', '/api/setup', { username: 'evil', password: 'another-long-password' });
    expect(again.statusCode).toBe(409);
  });

  it('rejects weak owner passwords', async () => {
    const res = await new Client(t.app).req('POST', '/api/setup', { username: 'owner', password: 'short' });
    expect(res.statusCode).toBe(400);
  });

  it('sets an httpOnly SameSite session cookie', async () => {
    const res = await new Client(t.app).req('POST', '/api/setup', OWNER);
    const cookie = res.cookies.find((c) => c.name === 'mm_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
  });
});

describe('login', () => {
  beforeEach(async () => {
    await setupOwner(t.app);
  });

  it('signs in with the right password, case-insensitive username', async () => {
    const c = new Client(t.app);
    expect((await c.login('OWNER', OWNER.password)).statusCode).toBe(200);
    expect((await c.req('GET', '/api/auth/me')).statusCode).toBe(200);
  });

  it('gives the same error for unknown users and wrong passwords', async () => {
    const a = await new Client(t.app).login('nobody', 'whatever-password');
    const b = await new Client(t.app).login('owner', 'wrong-password-here');
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json().error).toBe(b.json().error);
  });

  it('locks the account after 5 failures, even for the right password', async () => {
    const c = new Client(t.app);
    for (let i = 0; i < 5; i++) await c.login('owner', 'wrong-password-here');
    expect((await c.login('owner', OWNER.password)).statusCode).toBe(401);
  });

  it('logout ends the session', async () => {
    const c = new Client(t.app);
    await c.login('owner', OWNER.password);
    expect((await c.req('POST', '/api/auth/logout')).statusCode).toBe(200);
    c.cookie = c.cookie || 'mm_session=stale';
    expect((await c.req('GET', '/api/auth/me')).statusCode).toBe(401);
  });

  it('changing password signs out other sessions but keeps this one', async () => {
    const a = new Client(t.app);
    const b = new Client(t.app);
    await a.login('owner', OWNER.password);
    await b.login('owner', OWNER.password);
    const res = await a.req('POST', '/api/auth/password', { currentPassword: OWNER.password, newPassword: 'a-brand-new-passphrase' });
    expect(res.statusCode).toBe(200);
    expect((await a.req('GET', '/api/auth/me')).statusCode).toBe(200);
    expect((await b.req('GET', '/api/auth/me')).statusCode).toBe(401);
  });

  it('rate limits login attempts per IP', async () => {
    const c = new Client(t.app);
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await c.req('POST', '/api/auth/login', { username: `u${i}`, password: 'x' })).statusCode);
    expect(codes).toContain(429);
  });
});
