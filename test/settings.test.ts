import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, makeApp, setupOwner } from './helpers.js';

let t: Awaited<ReturnType<typeof makeApp>>;
let owner: Client;
beforeEach(async () => {
  t = await makeApp();
  owner = await setupOwner(t.app);
});
afterEach(async () => t.close());

describe('settings', () => {
  it('returns defaults for every section', async () => {
    const res = await owner.req('GET', '/api/settings');
    expect(res.json().auth.values.localLoginEnabled).toBe(true);
    expect(res.json().backup.values.remote.type).toBe('none');
  });

  it('encrypts secrets at rest and never sends them back', async () => {
    const res = await owner.req('PUT', '/api/settings/auth', { oidc: { clientSecret: 'super-secret-value', clientId: 'mm' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().values.oidc.clientSecret).toBe('');
    expect(res.json().secretsSet['oidc.clientSecret']).toBe(true);
    const raw = t.app.ctx.dbHandle.sqlite.prepare("SELECT value FROM settings WHERE key = 'auth'").get() as { value: string };
    expect(raw.value).not.toContain('super-secret-value');
    expect(t.app.ctx.settings.get('auth').oidc.clientSecret).toBe('super-secret-value');
  });

  it('keeps a secret when it is omitted and clears it on null', async () => {
    await owner.req('PUT', '/api/settings/auth', { oidc: { clientSecret: 'keep-me' } });
    await owner.req('PUT', '/api/settings/auth', { oidc: { enabled: false } });
    expect(t.app.ctx.settings.get('auth').oidc.clientSecret).toBe('keep-me');
    await owner.req('PUT', '/api/settings/auth', { oidc: { clientSecret: null } });
    expect(t.app.ctx.settings.get('auth').oidc.clientSecret).toBe('');
  });

  it('validates values', async () => {
    expect((await owner.req('PUT', '/api/settings/backup', { cron: 'every day' })).statusCode).toBe(400);
    expect((await owner.req('PUT', '/api/settings/general', { baseUrl: 'javascript:alert(1)' })).statusCode).toBe(400);
    expect((await owner.req('PUT', '/api/settings/nope', {})).statusCode).toBe(400);
  });
});

describe('settings hardening', () => {
  it('rejects prototype keys at the API and ignores them in the store', async () => {
    const res = await owner.req('PUT', '/api/settings/auth', '{"__proto__": {"localLoginEnabled": false}}', { headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(400);
    t.app.ctx.settings.update('auth', JSON.parse('{"__proto__": {"localLoginEnabled": false}, "constructor": {"x": 1}}'));
    expect(t.app.ctx.settings.get('auth').localLoginEnabled).toBe(true);
    expect(({} as Record<string, unknown>).localLoginEnabled).toBeUndefined();
  });
});
