import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { putAuthState } from '../src/server/auth/external.js';
import { Client, makeApp, setupOwner } from './helpers.js';

let t: Awaited<ReturnType<typeof makeApp>>;
let owner: Client;
beforeEach(async () => {
  t = await makeApp();
  owner = await setupOwner(t.app);
  await owner.req('PUT', '/api/settings/general', { baseUrl: 'https://media.example.com' });
  await owner.req('PUT', '/api/settings/auth', { oidc: { enabled: true, issuer: 'https://idp.example.com', clientId: 'mm' } });
});
afterEach(async () => t.close());

describe('OIDC callback', () => {
  it('rejects a callback whose state was not started in this browser', async () => {
    const state = putAuthState(t.app, 'oidc', { codeVerifier: 'v', nonce: 'n' });
    const res = await t.app.inject({ method: 'GET', url: `/api/auth/oidc/callback?state=${state}&code=abc` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login?error=sso_state');
  });

  it('rejects unknown state even with a matching cookie', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/oidc/callback?state=forged&code=abc', cookies: { mm_oidc_state: 'forged' } });
    expect(res.headers.location).toBe('/login?error=sso_state');
  });

  it('refuses to start without a public URL', async () => {
    await owner.req('PUT', '/api/settings/general', { baseUrl: '' });
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/oidc/start' });
    expect(res.headers.location).toBe('/login?error=base_url_missing');
  });
});

describe('Plex sign-in', () => {
  it('is refused while turned off', async () => {
    const res = await new Client(t.app).req('POST', '/api/auth/plex/start', {});
    expect(res.statusCode).toBe(400);
  });
});
