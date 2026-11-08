import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { base32Decode, totpAt } from '../src/server/auth/twofactor.js';
import { Client, createUser, makeApp, OWNER, setupOwner } from './helpers.js';

const ORIGIN = 'http://localhost:7979';
const step = () => Math.floor(Date.now() / 30_000);

// ---- a tiny software authenticator (CBOR encoding, ES256 keys) for passkey tests
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor');
}

class Authenticator {
  keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  id = crypto.randomBytes(16);
  count = 0;
  rpHash = crypto.createHash('sha256').update('localhost').digest();

  register(challenge: string) {
    const jwk = this.keys.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([this.rpHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, this.id, cose]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN, crossOrigin: false }));
    const attestation = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    const id = this.id.toString('base64url');
    return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: clientData.toString('base64url'), attestationObject: attestation.toString('base64url'), transports: ['internal'] } };
  }

  sign(challenge: string, origin = ORIGIN) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(++this.count);
    const authData = Buffer.concat([this.rpHash, Buffer.from([0x05]), counter]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }));
    const signature = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(clientData).digest()]), this.keys.privateKey);
    const id = this.id.toString('base64url');
    return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: clientData.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: signature.toString('base64url') } };
  }
}

describe('two-factor sign-in', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let owner: Client;
  beforeEach(async () => {
    t = await makeApp();
    owner = await setupOwner(t.app);
    await owner.req('PUT', '/api/settings/general', { baseUrl: ORIGIN });
  });
  afterEach(async () => {
    await t.close();
  });

  async function enableTotp(c: Client, password: string) {
    const setup = (await c.req('POST', '/api/auth/2fa/totp/setup', {})).json() as { token: string; secret: string; uri: string; qr: string };
    expect(setup.uri).toContain(`secret=${setup.secret}`);
    expect(setup.qr).toContain('<svg');
    const secret = base32Decode(setup.secret);
    expect((await c.req('POST', '/api/auth/2fa/totp/enable', { token: setup.token, code: totpAt(secret, step()), password: 'wrong' })).statusCode).toBe(400);
    const res = await c.req('POST', '/api/auth/2fa/totp/enable', { token: setup.token, code: totpAt(secret, step()), password });
    expect(res.statusCode).toBe(200);
    return { secret, recovery: (res.json() as { recoveryCodes: string[] }).recoveryCodes };
  }

  it('asks for an authenticator code after the password, takes each code once, and accepts recovery codes once', async () => {
    const { secret, recovery } = await enableTotp(owner, OWNER.password);
    expect(recovery).toHaveLength(10);
    expect((await owner.req('GET', '/api/auth/2fa')).json()).toMatchObject({ totp: true, recoveryLeft: 10 });

    const c = new Client(t.app);
    const first = (await c.req('POST', '/api/auth/login', OWNER)).json();
    expect(first).toMatchObject({ ok: false, twoFactor: { methods: ['totp', 'recovery'] } });
    // No session yet.
    expect((await c.req('GET', '/api/auth/me')).statusCode).toBe(401);
    // The code used to turn it on can't be used again (replay), nor a wrong one.
    expect((await c.req('POST', '/api/auth/login/2fa', { token: first.twoFactor.token, code: totpAt(secret, step()) })).statusCode).toBe(401);
    expect((await c.req('POST', '/api/auth/login/2fa', { token: first.twoFactor.token, code: totpAt(secret, step() + 1) })).statusCode).toBe(200);
    expect((await c.req('GET', '/api/auth/me')).statusCode).toBe(200);

    const d = new Client(t.app);
    const again = (await d.req('POST', '/api/auth/login', OWNER)).json();
    expect((await d.req('POST', '/api/auth/login/2fa', { token: again.twoFactor.token, code: recovery[0]!.toUpperCase() })).statusCode).toBe(200);
    const e = new Client(t.app);
    const third = (await e.req('POST', '/api/auth/login', OWNER)).json();
    expect((await e.req('POST', '/api/auth/login/2fa', { token: third.twoFactor.token, code: recovery[0] })).statusCode).toBe(401);
    expect((await owner.req('GET', '/api/auth/2fa')).json().recoveryLeft).toBe(9);
  });

  it('gives up on a challenge after five wrong codes', async () => {
    await enableTotp(owner, OWNER.password);
    const c = new Client(t.app);
    const { twoFactor } = (await c.req('POST', '/api/auth/login', OWNER)).json();
    for (let i = 0; i < 5; i++) expect((await c.req('POST', '/api/auth/login/2fa', { token: twoFactor.token, code: '000000' })).statusCode).toBe(401);
    const last = await c.req('POST', '/api/auth/login/2fa', { token: twoFactor.token, code: '000000' });
    expect(last.json().message ?? last.body).toMatch(/Sign in again/);
  });

  it('adds a passkey, uses it as the second step and on its own, and refuses another origin', async () => {
    const auth = new Authenticator();
    const opts = (await owner.req('POST', '/api/auth/passkeys/options', {})).json();
    expect(opts.options.rp).toEqual({ name: 'Cinemask', id: 'localhost' });
    const added = await owner.req('POST', '/api/auth/passkeys', { token: opts.token, name: 'Laptop', response: auth.register(opts.options.challenge), password: OWNER.password });
    expect(added.statusCode).toBe(200);
    expect(added.json().passkeys).toEqual([expect.objectContaining({ name: 'Laptop' })]);
    expect(added.json().recoveryCodes).toHaveLength(10);

    // Second step after the password.
    const c = new Client(t.app);
    const { twoFactor } = (await c.req('POST', '/api/auth/login', OWNER)).json();
    expect(twoFactor.methods).toEqual(['passkey', 'recovery']);
    const o2 = (await c.req('POST', '/api/auth/passkey/options', { token: twoFactor.token })).json();
    expect(o2.options.allowCredentials).toHaveLength(1);
    expect((await c.req('POST', '/api/auth/passkey', { state: o2.state, response: auth.sign(o2.options.challenge) })).statusCode).toBe(200);
    expect((await c.req('GET', '/api/auth/me')).statusCode).toBe(200);

    // On its own, without a password.
    const d = new Client(t.app);
    const o3 = (await d.req('POST', '/api/auth/passkey/options', {})).json();
    expect((await d.req('POST', '/api/auth/passkey', { state: o3.state, response: auth.sign(o3.options.challenge, 'https://evil.example') })).statusCode).toBe(401);
    const o4 = (await d.req('POST', '/api/auth/passkey/options', {})).json();
    expect((await d.req('POST', '/api/auth/passkey', { state: o4.state, response: auth.sign(o4.options.challenge) })).statusCode).toBe(200);
    // A challenge is good for one try.
    expect((await new Client(t.app).req('POST', '/api/auth/passkey', { state: o4.state, response: auth.sign(o4.options.challenge) })).statusCode).toBe(401);
  });

  it('lets admins reset a user, and only the owner reset an admin', async () => {
    const u = await createUser(owner, 'kid', 'user');
    const a = await createUser(owner, 'admin2', 'admin');
    const kid = new Client(t.app);
    await kid.login('kid', u.password);
    await enableTotp(kid, u.password);
    const admin = new Client(t.app);
    await admin.login('admin2', a.password);
    expect((await kid.req('DELETE', `/api/users/${a.id}/2fa`)).statusCode).toBe(403);
    expect((await admin.req('DELETE', `/api/users/1/2fa`)).statusCode).toBe(403);
    expect((await admin.req('DELETE', `/api/users/${u.id}/2fa`)).statusCode).toBe(200);
    expect((await owner.req('DELETE', `/api/users/${a.id}/2fa`)).statusCode).toBe(200);
    const again = new Client(t.app);
    expect((await again.req('POST', '/api/auth/login', { username: 'kid', password: u.password })).json()).toEqual({ ok: true });
  });
});
