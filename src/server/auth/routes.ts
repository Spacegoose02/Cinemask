import { count, eq, desc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { sessions, users } from '../db/schema.js';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { burnPasswordCheck, hashPassword, passwordProblem, verifyPassword } from '../security/passwords.js';
import { createSession, destroySession, revokeUserSessions } from './sessions.js';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;
const GENERIC_LOGIN_ERROR = 'Invalid username or password, or too many attempts. Try again later.';

export const usernameSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-zA-Z0-9._@-]+$/, 'Use letters, numbers and . _ @ - only');

export function needsSetup(app: FastifyInstance): boolean {
  return app.ctx.db.select({ n: count() }).from(users).get()!.n === 0;
}

export async function authRoutes(app: FastifyInstance) {
  const loginRateLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  app.get('/api/auth/status', { config: { access: 'public' } }, async (req) => {
    const auth = app.ctx.settings.get('auth');
    return {
      needsSetup: needsSetup(app),
      signedIn: Boolean(req.user),
      methods: {
        local: auth.localLoginEnabled,
        oidc: auth.oidc.enabled ? { label: auth.oidc.buttonLabel } : null,
        plex: auth.plex.enabled,
      },
    };
  });

  app.post('/api/setup', { config: { access: 'public', ...loginRateLimit } }, async (req, reply) => {
    const body = parse(z.object({ username: usernameSchema, password: z.string() }), req.body);
    const problem = passwordProblem(body.password, body.username);
    if (problem) throw badRequest(problem);
    const passwordHash = await hashPassword(body.password);
    // Check and insert in one synchronous transaction so two concurrent setups can't both win.
    const id = app.ctx.dbHandle.sqlite.transaction(() => {
      if (!needsSetup(app)) return null;
      return app.ctx.db
        .insert(users)
        .values({ username: body.username, passwordHash, role: 'admin', isOwner: true, createdAt: Date.now() })
        .returning({ id: users.id })
        .get().id;
    })();
    if (id === null) throw conflict('Setup has already been completed');
    audit(app.ctx.db, req, 'setup.owner_created', { user: { id, username: body.username } });
    createSession(app.ctx.db, req, reply, id, app.ctx.settings.get('auth').sessionDays);
    return { ok: true };
  });

  app.post('/api/auth/login', { config: { access: 'public', ...loginRateLimit } }, async (req, reply) => {
    const body = parse(z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(1024) }), req.body);
    const auth = app.ctx.settings.get('auth');
    const user = app.ctx.db.select().from(users).where(eq(users.username, body.username)).get();

    if (!user || !user.passwordHash) {
      await burnPasswordCheck(body.password);
      audit(app.ctx.db, req, 'auth.login_failed', { target: body.username, user: null });
      throw new HttpError(401, GENERIC_LOGIN_ERROR, 'invalid_credentials');
    }
    // The owner can always sign in locally so a broken SSO setup can't lock everyone out.
    const localAllowed = auth.localLoginEnabled || user.isOwner;
    const locked = user.lockedUntil !== null && user.lockedUntil > Date.now();
    if (locked || user.disabled || !localAllowed) {
      await burnPasswordCheck(body.password);
      audit(app.ctx.db, req, 'auth.login_blocked', { target: user.username, user: null, details: { locked, disabled: user.disabled } });
      throw new HttpError(401, GENERIC_LOGIN_ERROR, 'invalid_credentials');
    }
    if (!(await verifyPassword(user.passwordHash, body.password))) {
      const failed = user.failedLogins + 1;
      const lock = failed >= MAX_FAILED_LOGINS;
      app.ctx.db
        .update(users)
        .set({ failedLogins: lock ? 0 : failed, lockedUntil: lock ? Date.now() + LOCKOUT_MS : null })
        .where(eq(users.id, user.id))
        .run();
      audit(app.ctx.db, req, lock ? 'auth.account_locked' : 'auth.login_failed', { target: user.username, user: null });
      throw new HttpError(401, GENERIC_LOGIN_ERROR, 'invalid_credentials');
    }
    createSession(app.ctx.db, req, reply, user.id, auth.sessionDays);
    audit(app.ctx.db, req, 'auth.login', { user: { id: user.id, username: user.username }, details: { method: 'local' } });
    return { ok: true };
  });

  app.post('/api/auth/logout', { config: { access: 'user' } }, async (req, reply) => {
    destroySession(app.ctx.db, reply, req.session?.id);
    audit(app.ctx.db, req, 'auth.logout');
    return { ok: true };
  });

  app.get('/api/auth/me', { config: { access: 'user' } }, async (req) => ({ user: req.user, csrfToken: req.session?.csrfToken ?? null }));

  app.post('/api/auth/password', { config: { access: 'user', ...loginRateLimit } }, async (req) => {
    const body = parse(z.object({ currentPassword: z.string().max(1024).optional(), newPassword: z.string() }), req.body);
    const user = app.ctx.db.select().from(users).where(eq(users.id, req.user!.id)).get()!;
    if (user.passwordHash && !(await verifyPassword(user.passwordHash, body.currentPassword ?? ''))) {
      throw badRequest('Current password is incorrect');
    }
    const problem = passwordProblem(body.newPassword, user.username);
    if (problem) throw badRequest(problem);
    app.ctx.db.update(users).set({ passwordHash: await hashPassword(body.newPassword) }).where(eq(users.id, user.id)).run();
    revokeUserSessions(app.ctx.db, user.id, req.session!.id);
    audit(app.ctx.db, req, 'auth.password_changed');
    return { ok: true };
  });

  app.get('/api/auth/sessions', { config: { access: 'user' } }, async (req) => {
    const rows = app.ctx.db.select().from(sessions).where(eq(sessions.userId, req.user!.id)).orderBy(desc(sessions.lastSeenAt)).all();
    return rows.map((s) => ({
      // Expose a short prefix of the hashed id as a handle; never the cookie token.
      id: s.id.slice(0, 16),
      current: s.id === req.session!.id,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      ip: s.ip,
      userAgent: s.userAgent,
    }));
  });

  app.delete('/api/auth/sessions/:id', { config: { access: 'user' } }, async (req) => {
    const { id } = parse(z.object({ id: z.string().regex(/^[a-f0-9]{16}$/) }), req.params);
    const mine = app.ctx.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, req.user!.id)).all();
    const match = mine.find((s) => s.id.startsWith(id));
    if (!match) throw notFound();
    app.ctx.db.delete(sessions).where(eq(sessions.id, match.id)).run();
    audit(app.ctx.db, req, 'auth.session_revoked');
    return { ok: true };
  });
}
