import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { fakeFetch, JELLYFIN, PLEX } from './fakes.js';
import { users } from '../src/server/db/schema.js';
import { eq } from 'drizzle-orm';

describe('invite links', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let owner: Client;
  let shared: { url: string; body: string }[] = [];
  let jfCreated: string[] = [];
  beforeEach(async () => {
    t = await makeApp();
    owner = await setupOwner(t.app);
    shared = [];
    jfCreated = [];
    fakeFetch({
      [`${PLEX}/library/sections`]: () => ({ MediaContainer: { Directory: [{ key: '1', type: 'movie', title: 'Movies' }, { key: '2', type: 'show', title: 'TV' }, { key: '3', type: 'artist', title: 'Music' }] } }),
      [`${JELLYFIN}/Users/New`]: (_u: URL, init?: RequestInit) => (jfCreated.push(String(init?.body)), { Id: 'jf-new' }),
      'https://plex.tv/api/v2/pins': (u: URL) => (u.pathname.endsWith('/pins') ? { id: 77, code: 'pin-code' } : { authToken: 'friend-token' }),
      'https://plex.tv/api/v2/user': () => ({ id: 4242, uuid: 'u', username: 'grandma', title: 'Grandma', email: 'grandma@example.com' }),
      'https://plex.tv/api/servers/srv-1': () => new Response('<MediaContainer><Server machineIdentifier="srv-1"><Section id="901" key="1" title="Movies"/><Section id="902" key="2" title="TV"/></Server></MediaContainer>'),
      'https://plex.tv/api/v2/shared_servers': (u: URL, init?: RequestInit) => (shared.push({ url: u.toString(), body: String(init?.body) }), { id: 1 }),
    });
    await owner.req('PUT', '/api/settings/plex', { enabled: true, url: PLEX, token: 'owner-token', machineId: 'srv-1' });
    await owner.req('PUT', '/api/settings/jellyfin', { enabled: true, url: JELLYFIN, apiKey: 'jf-key' });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  it('makes an account from a single-use link, with the invite’s settings and a Jellyfin account', async () => {
    const inv = (await owner.req('POST', '/api/invites', { label: 'Kids', maxAge: 9, uses: 1, jellyfinAccount: true })).json();
    expect(inv.path).toMatch(/^\/invite\/[\w-]{20,}$/);
    const code = inv.path.split('/').pop();
    // The code itself is never stored in the clear.
    expect(JSON.stringify(t.app.ctx.dbHandle.sqlite.prepare('SELECT * FROM invites').all())).not.toContain(code);

    const guest = new Client(t.app);
    expect((await guest.req('GET', `/api/invites/open/${code}`)).json()).toMatchObject({ valid: true, label: 'Kids', password: true, plex: true, jellyfin: true });
    expect((await guest.req('POST', `/api/invites/open/${code}`, { username: 'kiddo', password: 'short' })).statusCode).toBe(400);
    expect((await guest.req('POST', `/api/invites/open/${code}`, { username: 'owner', password: 'a-long-enough-password' })).statusCode).toBe(409);
    expect((await guest.req('POST', `/api/invites/open/${code}`, { username: 'kiddo', password: 'a-long-enough-password' })).json()).toEqual({ ok: true, notes: [] });
    await guest.refreshCsrf();
    expect((await guest.req('GET', '/api/auth/me')).json().user).toMatchObject({ username: 'kiddo', role: 'user' });
    const row = t.app.ctx.db.select().from(users).where(eq(users.username, 'kiddo')).get()!;
    expect(row).toMatchObject({ maxAge: 9, jellyfinUserId: 'jf-new' });
    expect(jfCreated[0]).toContain('"Name":"kiddo"');

    // Used up.
    expect((await new Client(t.app).req('GET', `/api/invites/open/${code}`)).json().valid).toBe(false);
    expect((await new Client(t.app).req('POST', `/api/invites/open/${code}`, { username: 'other', password: 'a-long-enough-password' })).statusCode).toBe(410);
    expect((await owner.req('GET', '/api/invites')).json().invites[0]).toMatchObject({ used: 1, usesLeft: 0, active: false, joined: [expect.objectContaining({ username: 'kiddo' })] });
  });

  it('joins with Plex and shares the chosen Plex libraries', async () => {
    expect((await owner.req('GET', '/api/invites/plex-libraries')).json().libraries.map((l: { key: string }) => l.key)).toEqual(['1', '2']);
    const inv = (await owner.req('POST', '/api/invites', { uses: null, plexShare: true, plexSections: ['2'] })).json();
    const code = inv.path.split('/').pop();
    const guest = new Client(t.app);
    const start = (await guest.req('POST', `/api/invites/open/${code}/plex`, {})).json();
    expect(start.authUrl).toContain('app.plex.tv/auth');
    const done = (await guest.req('POST', '/api/invites/plex/poll', { state: start.state })).json();
    expect(done).toMatchObject({ done: true, ok: true, plexShared: true });
    expect(JSON.parse(shared[0]!.body)).toEqual({ machineIdentifier: 'srv-1', librarySectionIds: [902], settings: { allowSync: true }, invitedEmail: 'grandma@example.com' });
    const row = t.app.ctx.db.select().from(users).where(eq(users.plexId, '4242')).get()!;
    expect(row.username).toBe('grandma');
    // A second go with the same Plex account doesn't make a second user.
    const again = (await new Client(t.app).req('POST', `/api/invites/open/${code}/plex`, {})).json();
    expect((await new Client(t.app).req('POST', '/api/invites/plex/poll', { state: again.state })).json()).toMatchObject({ ok: false, error: expect.stringMatching(/already have an account/) });
  });

  it('only admins make invites, and only the owner makes admin invites', async () => {
    const a = await createUser(owner, 'admin2', 'admin');
    const m = await createUser(owner, 'mgr', 'manager');
    const admin = new Client(t.app);
    await admin.login('admin2', a.password);
    const mgr = new Client(t.app);
    await mgr.login('mgr', m.password);
    expect((await mgr.req('POST', '/api/invites', {})).statusCode).toBe(403);
    expect((await admin.req('POST', '/api/invites', { role: 'admin' })).statusCode).toBe(403);
    expect((await admin.req('POST', '/api/invites', { role: 'manager' })).statusCode).toBe(200);
    const exp = (await owner.req('POST', '/api/invites', { role: 'admin', expiresInDays: 1 })).json();
    expect((await admin.req('DELETE', `/api/invites/${exp.id}`)).statusCode).toBe(403);
    // Expired links stop working.
    t.app.ctx.dbHandle.sqlite.prepare('UPDATE invites SET expires_at = 1 WHERE id = ?').run(exp.id);
    expect((await new Client(t.app).req('GET', `/api/invites/open/${exp.path.split('/').pop()}`)).json().valid).toBe(false);
    expect((await new Client(t.app).req('GET', '/api/invites/open/not-a-real-code-at-all')).json().valid).toBe(false);
  });
});
