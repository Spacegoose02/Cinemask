import crypto from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { audit } from '../audit/log.js';
import type { AppContext } from '../context.js';
import { authStates, passkeys, users } from '../db/schema.js';
import { badRequest, HttpError, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { openSecret, sealSecret } from '../arr/secrets.js';
import { randomToken, sha256 } from '../security/crypto.js';
import { verifyPassword } from '../security/passwords.js';
import { createSession } from './sessions.js';

/**
 * Two-factor sign-in: an authenticator app (TOTP, RFC 6238), passkeys (WebAuthn) and one-time
 * recovery codes. With either set up, a correct password only gets a short-lived challenge; the
 * session comes after the second step. A passkey can also sign in on its own, since it already is
 * two factors (the device, and the fingerprint or PIN that unlocks it). OIDC and Plex sign-ins
 * leave the second step to the identity provider.
 */

// ---------------------------------------------------------------- TOTP

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error('Not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The six-digit code for a secret at a 30-second step. */
export function totpAt(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', secret).update(counter).digest();
  const offset = h[h.length - 1]! & 15;
  const n = (h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, '0');
}

/** The step a code matches (one step either side allows for clock drift), or null. */
export function matchTotp(secret: Buffer, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 1000 / STEP);
  for (const s of [step, step - 1, step + 1]) {
    if (crypto.timingSafeEqual(Buffer.from(totpAt(secret, s)), Buffer.from(code))) return s;
  }
  return null;
}

// ---------------------------------------------------------------- recovery codes

const RECOVERY_COUNT = 10;

/**
 * Recovery codes are stored as salted scrypt hashes ("scrypt:salt:hash"), so a copy of the
 * database doesn't give them away. One salt per set keeps checking a code to a single scrypt run.
 */
const recoveryHash = (code: string, salt: string) => crypto.scryptSync(normalizeRecovery(code), Buffer.from(salt, 'base64url'), 32).toString('base64url');

function newRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: RECOVERY_COUNT }, () => {
    const raw = base32Encode(crypto.randomBytes(7)).slice(0, 10).toLowerCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  const salt = crypto.randomBytes(16).toString('base64url');
  return { codes, hashes: codes.map((c) => `scrypt:${salt}:${recoveryHash(c, salt)}`) };
}

/** The stored entry a recovery code matches, if any. */
function findRecovery(stored: string[], code: string): string | null {
  const hashed = new Map<string, Buffer>();
  for (const entry of stored) {
    const [kind, salt, hash] = entry.split(':');
    if (kind !== 'scrypt' || !salt || !hash) continue;
    if (!hashed.has(salt)) hashed.set(salt, Buffer.from(recoveryHash(code, salt)));
    const want = Buffer.from(hash);
    const got = hashed.get(salt)!;
    if (want.length === got.length && crypto.timingSafeEqual(want, got)) return entry;
  }
  return null;
}

const normalizeRecovery = (c: string) => c.toLowerCase().replace(/[^a-z2-7]/g, '');

// ---------------------------------------------------------------- per-user state

type UserRow = typeof users.$inferSelect;

export function twoFactorOf(ctx: AppContext, userId: number) {
  const u = ctx.db.select().from(users).where(eq(users.id, userId)).get();
  const keys = ctx.db.select().from(passkeys).where(eq(passkeys.userId, userId)).all();
  return {
    totp: Boolean(u?.totpSecret),
    passkeys: keys.map((k) => ({ id: k.id, name: k.name, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt })),
    recoveryLeft: u?.recoveryCodes ? (JSON.parse(u.recoveryCodes) as string[]).length : 0,
  };
}

export function hasTwoFactor(ctx: AppContext, user: UserRow): boolean {
  return Boolean(user.totpSecret) || Boolean(ctx.db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.userId, user.id)).get());
}

/** Turns two-factor off for someone (used by admins helping a person who lost their phone). */
export function resetTwoFactor(ctx: AppContext, userId: number) {
  ctx.db.update(users).set({ totpSecret: null, totpLastStep: null, recoveryCodes: null }).where(eq(users.id, userId)).run();
  ctx.db.delete(passkeys).where(eq(passkeys.userId, userId)).run();
}

/** Checks an authenticator code or a recovery code, using up the recovery code. */
function checkCode(ctx: AppContext, user: UserRow, code: string): 'totp' | 'recovery' | null {
  const trimmed = code.trim();
  if (user.totpSecret && /^\d{6}$/.test(trimmed.replace(/\s/g, ''))) {
    const step = matchTotp(base32Decode(openSecret(ctx, user.totpSecret)), trimmed.replace(/\s/g, ''));
    if (step === null || (user.totpLastStep !== null && step <= user.totpLastStep)) return null;
    ctx.db.update(users).set({ totpLastStep: step }).where(eq(users.id, user.id)).run();
    return 'totp';
  }
  const hashes: string[] = user.recoveryCodes ? JSON.parse(user.recoveryCodes) : [];
  const h = normalizeRecovery(trimmed).length === 10 ? findRecovery(hashes, trimmed) : null;
  if (!h) return null;
  ctx.db
    .update(users)
    .set({ recoveryCodes: JSON.stringify(hashes.filter((x) => x !== h)) })
    .where(eq(users.id, user.id))
    .run();
  return 'recovery';
}

// ---------------------------------------------------------------- challenges

const CHALLENGE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function putState(ctx: AppContext, kind: string, data: object, token = randomToken(24)): string {
  ctx.db.delete(authStates).where(lt(authStates.expiresAt, Date.now())).run();
  ctx.db.insert(authStates).values({ state: sha256(token), kind, data: JSON.stringify(data), expiresAt: Date.now() + CHALLENGE_MS }).run();
  return token;
}

function getState<T>(ctx: AppContext, kind: string, token: string): T | null {
  const row = ctx.db.select().from(authStates).where(and(eq(authStates.state, sha256(token)), eq(authStates.kind, kind))).get();
  if (!row || row.expiresAt < Date.now()) return null;
  return JSON.parse(row.data) as T;
}

const dropState = (ctx: AppContext, token: string) => ctx.db.delete(authStates).where(eq(authStates.state, sha256(token))).run();
const updateState = (ctx: AppContext, token: string, data: object) => ctx.db.update(authStates).set({ data: JSON.stringify(data) }).where(eq(authStates.state, sha256(token))).run();

/** After a correct password: a challenge for the second step, or null when the person has no two-factor. */
export function startSecondStep(ctx: AppContext, user: UserRow): { token: string; methods: ('totp' | 'passkey' | 'recovery')[] } | null {
  if (!hasTwoFactor(ctx, user)) return null;
  const tf = twoFactorOf(ctx, user.id);
  const methods: ('totp' | 'passkey' | 'recovery')[] = [];
  if (tf.totp) methods.push('totp');
  if (tf.passkeys.length) methods.push('passkey');
  if (tf.recoveryLeft) methods.push('recovery');
  return { token: putState(ctx, 'mfa', { userId: user.id, attempts: 0 }), methods };
}

// ---------------------------------------------------------------- WebAuthn

/** Where the page is served from, as the browser sees it: the public URL when set, else the request's own origin. */
function relyingParty(ctx: AppContext, req: FastifyRequest): { rpID: string; origin: string } {
  const base = ctx.settings.get('general').baseUrl;
  if (base) {
    const u = new URL(base);
    return { rpID: u.hostname, origin: u.origin };
  }
  const origin = String(req.headers.origin ?? '');
  try {
    const u = new URL(origin);
    // The Origin header must name this host; anything else is someone else's page.
    if (u.host === req.host) return { rpID: u.hostname, origin: u.origin };
  } catch {
    // fall through
  }
  const host = req.host;
  return { rpID: host.replace(/:\d+$/, '').replace(/^\[|\]$/g, ''), origin: `${req.protocol}://${host}` };
}

async function verifyPasskey(ctx: AppContext, req: FastifyRequest, response: AuthenticationResponseJSON, challenge: string, userId: number | null) {
  const cred = ctx.db.select().from(passkeys).where(eq(passkeys.id, response.id)).get();
  if (!cred || (userId !== null && cred.userId !== userId)) return null;
  const { rpID, origin } = relyingParty(ctx, req);
  try {
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: { id: cred.id, publicKey: Buffer.from(cred.publicKey, 'base64url'), counter: cred.counter, transports: cred.transports ? (JSON.parse(cred.transports) as AuthenticatorTransportFuture[]) : undefined },
      requireUserVerification: true,
    });
    if (!v.verified) return null;
    ctx.db.update(passkeys).set({ counter: v.authenticationInfo.newCounter, lastUsedAt: Date.now() }).where(eq(passkeys.id, cred.id)).run();
    return cred.userId;
  } catch {
    return null;
  }
}

const passkeyResponse = z
  .object({ id: z.string().max(1000), rawId: z.string().max(1000), type: z.literal('public-key'), response: z.record(z.string(), z.unknown()), clientExtensionResults: z.record(z.string(), z.unknown()).default({}) })
  .passthrough();

const GENERIC = 'That code is not right, or it has expired. Try again.';

// ---------------------------------------------------------------- routes

export async function twoFactorRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const userOf = (id: number) => ctx.db.select().from(users).where(eq(users.id, id)).get()!;
  const rate = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  /** Re-checks who's at the keyboard before changing sign-in settings: the password, or a code for people without one. */
  async function confirmIdentity(user: UserRow, b: { password?: string; code?: string }) {
    if (user.passwordHash) {
      if (!(await verifyPassword(user.passwordHash, b.password ?? ''))) throw badRequest('Your password is not right');
      return;
    }
    if (hasTwoFactor(ctx, user) && !(b.code && checkCode(ctx, user, b.code))) throw badRequest('Enter a code from your authenticator app or a recovery code');
  }

  const finish = (req: FastifyRequest, reply: FastifyReply, userId: number, method: string) => {
    const user = userOf(userId);
    if (user.disabled) throw new HttpError(401, GENERIC, 'invalid_credentials');
    createSession(ctx.db, req, reply, user.id, ctx.settings.get('auth').sessionDays);
    audit(ctx.db, req, 'auth.login', { user: { id: user.id, username: user.username }, details: { method } });
    return { ok: true };
  };

  // ---- Account → Sign-in security
  app.get('/api/auth/2fa', { config: { access: 'user' } }, async (req) => twoFactorOf(ctx, req.user!.id));

  /** A new authenticator secret to scan. It only takes effect once a code from it is entered. */
  app.post('/api/auth/2fa/totp/setup', { config: { access: 'user', ...rate } }, async (req) => {
    const secret = base32Encode(crypto.randomBytes(20));
    const label = encodeURIComponent(`Cinemask:${req.user!.username}`);
    const uri = `otpauth://totp/${label}?secret=${secret}&issuer=Cinemask&algorithm=SHA1&digits=6&period=30`;
    const token = putState(ctx, 'totp-setup', { userId: req.user!.id, secret: sealSecret(ctx, secret) });
    return { token, secret, uri, qr: await QRCode.toString(uri, { type: 'svg', margin: 1 }) };
  });

  app.post('/api/auth/2fa/totp/enable', { config: { access: 'user', ...rate } }, async (req) => {
    const b = parse(z.object({ token: z.string().max(100), code: z.string().max(20), password: z.string().max(1024).optional() }), req.body);
    const pending = getState<{ userId: number; secret: string }>(ctx, 'totp-setup', b.token);
    if (!pending || pending.userId !== req.user!.id) throw badRequest('Start again: that setup has expired');
    const user = userOf(req.user!.id);
    if (user.passwordHash && !(await verifyPassword(user.passwordHash, b.password ?? ''))) throw badRequest('Your password is not right');
    const step = matchTotp(base32Decode(openSecret(ctx, pending.secret)), b.code.replace(/\s/g, ''));
    if (step === null) throw badRequest("That code doesn't match. Check the time on your phone and try the next one.");
    dropState(ctx, b.token);
    const { codes, hashes } = newRecoveryCodes();
    ctx.db.update(users).set({ totpSecret: pending.secret, totpLastStep: step, recoveryCodes: user.recoveryCodes ?? JSON.stringify(hashes) }).where(eq(users.id, user.id)).run();
    audit(ctx.db, req, 'auth.2fa_enabled', { details: { method: 'totp' } });
    return { recoveryCodes: user.recoveryCodes ? null : codes };
  });

  app.post('/api/auth/2fa/totp/disable', { config: { access: 'user', ...rate } }, async (req) => {
    const b = parse(z.object({ password: z.string().max(1024).optional(), code: z.string().max(20).optional() }), req.body);
    const user = userOf(req.user!.id);
    await confirmIdentity(user, b);
    ctx.db.update(users).set({ totpSecret: null, totpLastStep: null }).where(eq(users.id, user.id)).run();
    if (!hasTwoFactor(ctx, userOf(user.id))) ctx.db.update(users).set({ recoveryCodes: null }).where(eq(users.id, user.id)).run();
    audit(ctx.db, req, 'auth.2fa_disabled', { details: { method: 'totp' } });
    return twoFactorOf(ctx, user.id);
  });

  app.post('/api/auth/2fa/recovery', { config: { access: 'user', ...rate } }, async (req) => {
    const b = parse(z.object({ password: z.string().max(1024).optional(), code: z.string().max(20).optional() }), req.body);
    const user = userOf(req.user!.id);
    if (!hasTwoFactor(ctx, user)) throw badRequest('Set up an authenticator app or a passkey first');
    await confirmIdentity(user, b);
    const { codes, hashes } = newRecoveryCodes();
    ctx.db.update(users).set({ recoveryCodes: JSON.stringify(hashes) }).where(eq(users.id, user.id)).run();
    audit(ctx.db, req, 'auth.recovery_codes_created');
    return { recoveryCodes: codes };
  });

  // ---- passkeys
  app.post('/api/auth/passkeys/options', { config: { access: 'user', ...rate } }, async (req) => {
    const user = userOf(req.user!.id);
    const { rpID } = relyingParty(ctx, req);
    const existing = ctx.db.select().from(passkeys).where(eq(passkeys.userId, user.id)).all();
    const options = await generateRegistrationOptions({
      rpName: 'Cinemask',
      rpID,
      userName: user.username,
      userDisplayName: user.displayName ?? user.username,
      userID: new TextEncoder().encode(`cinemask-user-${user.id}`),
      attestationType: 'none',
      excludeCredentials: existing.map((k) => ({ id: k.id, transports: k.transports ? (JSON.parse(k.transports) as AuthenticatorTransportFuture[]) : undefined })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const token = putState(ctx, 'passkey-reg', { userId: user.id, challenge: options.challenge });
    return { token, options };
  });

  app.post('/api/auth/passkeys', { config: { access: 'user', ...rate } }, async (req) => {
    const b = parse(z.object({ token: z.string().max(100), name: z.string().trim().min(1).max(60).default('Passkey'), response: passkeyResponse, password: z.string().max(1024).optional(), code: z.string().max(20).optional() }), req.body);
    const pending = getState<{ userId: number; challenge: string }>(ctx, 'passkey-reg', b.token);
    if (!pending || pending.userId !== req.user!.id) throw badRequest('Start again: that has expired');
    const user = userOf(req.user!.id);
    await confirmIdentity(user, b);
    dropState(ctx, b.token);
    const { rpID, origin } = relyingParty(ctx, req);
    let v;
    try {
      v = await verifyRegistrationResponse({ response: b.response as unknown as RegistrationResponseJSON, expectedChallenge: pending.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
    } catch (err) {
      throw badRequest(`The passkey couldn't be checked: ${(err as Error).message}`);
    }
    if (!v.verified || !v.registrationInfo) throw badRequest("The passkey couldn't be checked");
    const c = v.registrationInfo.credential;
    if (ctx.db.select().from(passkeys).where(eq(passkeys.id, c.id)).get()) throw badRequest('That passkey is already added');
    ctx.db
      .insert(passkeys)
      .values({ id: c.id, userId: user.id, publicKey: Buffer.from(c.publicKey).toString('base64url'), counter: c.counter, transports: c.transports ? JSON.stringify(c.transports) : null, name: b.name, createdAt: Date.now() })
      .run();
    let recoveryCodes: string[] | null = null;
    if (!user.recoveryCodes) {
      const fresh = newRecoveryCodes();
      ctx.db.update(users).set({ recoveryCodes: JSON.stringify(fresh.hashes) }).where(eq(users.id, user.id)).run();
      recoveryCodes = fresh.codes;
    }
    audit(ctx.db, req, 'auth.2fa_enabled', { details: { method: 'passkey', name: b.name } });
    return { ...twoFactorOf(ctx, user.id), recoveryCodes };
  });

  app.delete('/api/auth/passkeys/:id', { config: { access: 'user', ...rate } }, async (req) => {
    const { id } = parse(z.object({ id: z.string().max(1000) }), req.params);
    const b = parse(z.object({ password: z.string().max(1024).optional(), code: z.string().max(20).optional() }), req.body ?? {});
    const user = userOf(req.user!.id);
    const key = ctx.db.select().from(passkeys).where(and(eq(passkeys.id, id), eq(passkeys.userId, user.id))).get();
    if (!key) throw notFound('That passkey was not found');
    await confirmIdentity(user, b);
    ctx.db.delete(passkeys).where(eq(passkeys.id, id)).run();
    if (!hasTwoFactor(ctx, userOf(user.id))) ctx.db.update(users).set({ recoveryCodes: null }).where(eq(users.id, user.id)).run();
    audit(ctx.db, req, 'auth.2fa_disabled', { details: { method: 'passkey', name: key.name } });
    return twoFactorOf(ctx, user.id);
  });

  // ---- sign-in: second step after a password
  app.post('/api/auth/login/2fa', { config: { access: 'public', ...rate } }, async (req, reply) => {
    const b = parse(z.object({ token: z.string().max(100), code: z.string().max(20) }), req.body);
    const pending = getState<{ userId: number; attempts: number }>(ctx, 'mfa', b.token);
    if (!pending) throw new HttpError(401, 'Sign in again: that took too long', 'invalid_credentials');
    const method = checkCode(ctx, userOf(pending.userId), b.code);
    if (!method) {
      const attempts = pending.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) dropState(ctx, b.token);
      else updateState(ctx, b.token, { ...pending, attempts });
      audit(ctx.db, req, 'auth.2fa_failed', { target: userOf(pending.userId).username, user: null });
      throw new HttpError(401, attempts >= MAX_ATTEMPTS ? 'Too many tries. Sign in again.' : GENERIC, 'invalid_credentials');
    }
    dropState(ctx, b.token);
    if (method === 'recovery') audit(ctx.db, req, 'auth.recovery_code_used', { target: userOf(pending.userId).username, user: null });
    return finish(req, reply, pending.userId, `local+${method}`);
  });

  /** A passkey as the second step, or as the only one (no token: the person picks a passkey on their device). */
  app.post('/api/auth/passkey/options', { config: { access: 'public', ...rate } }, async (req) => {
    const b = parse(z.object({ token: z.string().max(100).optional() }), req.body ?? {});
    let userId: number | null = null;
    if (b.token) {
      const pending = getState<{ userId: number }>(ctx, 'mfa', b.token);
      if (!pending) throw new HttpError(401, 'Sign in again: that took too long', 'invalid_credentials');
      userId = pending.userId;
    } else if (!ctx.settings.get('auth').localLoginEnabled) {
      throw new HttpError(403, 'Passkey sign-in is off along with password sign-in', 'forbidden');
    }
    const { rpID } = relyingParty(ctx, req);
    const allow = userId === null ? [] : ctx.db.select().from(passkeys).where(eq(passkeys.userId, userId)).all();
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: allow.map((k) => ({ id: k.id, transports: k.transports ? (JSON.parse(k.transports) as AuthenticatorTransportFuture[]) : undefined })) });
    const state = putState(ctx, 'passkey-auth', { userId, challenge: options.challenge, pendingLogin: b.token ?? null });
    return { state, options };
  });

  app.post('/api/auth/passkey', { config: { access: 'public', ...rate } }, async (req, reply) => {
    const b = parse(z.object({ state: z.string().max(100), response: passkeyResponse }), req.body);
    const pending = getState<{ userId: number | null; challenge: string; pendingLogin: string | null }>(ctx, 'passkey-auth', b.state);
    dropState(ctx, b.state);
    if (!pending) throw new HttpError(401, 'Try again: that took too long', 'invalid_credentials');
    const userId = await verifyPasskey(ctx, req, b.response as unknown as AuthenticationResponseJSON, pending.challenge, pending.userId);
    if (userId === null) {
      audit(ctx.db, req, 'auth.passkey_failed', { user: null });
      throw new HttpError(401, "That passkey wasn't accepted", 'invalid_credentials');
    }
    if (pending.pendingLogin) dropState(ctx, pending.pendingLogin);
    return finish(req, reply, userId, pending.pendingLogin ? 'local+passkey' : 'passkey');
  });

  // ---- admins: help someone who lost their phone
  app.delete('/api/users/:id/2fa', { config: { access: 'admin' } }, async (req) => {
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const target = ctx.db.select().from(users).where(eq(users.id, id)).get();
    if (!target) throw notFound();
    if ((target.isOwner || target.role === 'admin') && !req.user!.isOwner && target.id !== req.user!.id) throw new HttpError(403, 'Only the owner can manage admins', 'forbidden');
    resetTwoFactor(ctx, id);
    audit(ctx.db, req, 'auth.2fa_reset', { target: target.username });
    return { ok: true };
  });
}
