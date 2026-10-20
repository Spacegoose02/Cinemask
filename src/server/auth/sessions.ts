import { and, eq, lt, ne } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Orm } from '../db/database.js';
import { sessions, users, type Role } from '../db/schema.js';
import { randomToken, sha256 } from '../security/crypto.js';

export const SESSION_COOKIE = 'mm_session';
const DAY = 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL = 60 * 1000;

export interface SessionUser {
  id: number;
  username: string;
  displayName: string | null;
  email: string | null;
  role: Role;
  isOwner: boolean;
  hasPassword: boolean;
  theme: string | null;
}

export function toSessionUser(u: typeof users.$inferSelect): SessionUser {
  return { id: u.id, username: u.username, displayName: u.displayName, email: u.email, role: u.role, isOwner: u.isOwner, hasPassword: Boolean(u.passwordHash), theme: u.theme };
}

export interface SessionInfo {
  id: string;
  csrfToken: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    session: SessionInfo | null;
  }
}

export function createSession(db: Orm, req: FastifyRequest, reply: FastifyReply, userId: number, sessionDays: number): void {
  const token = randomToken(32);
  const now = Date.now();
  db.insert(sessions)
    .values({
      id: sha256(token),
      userId,
      csrfToken: randomToken(24),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + sessionDays * DAY,
      ip: req.ip,
      userAgent: (req.headers['user-agent'] ?? '').slice(0, 300),
    })
    .run();
  db.update(users).set({ lastLoginAt: now, failedLogins: 0, lockedUntil: null }).where(eq(users.id, userId)).run();
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto',
    maxAge: sessionDays * 24 * 60 * 60,
  });
}

export function loadSession(db: Orm, token: string | undefined, sessionDays: number): { user: SessionUser; session: SessionInfo } | null {
  if (!token || token.length > 100) return null;
  const id = sha256(token);
  const row = db
    .select({ s: sessions, u: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .get();
  if (!row) return null;
  const now = Date.now();
  if (row.s.expiresAt < now || row.u.disabled) {
    db.delete(sessions).where(eq(sessions.id, id)).run();
    return null;
  }
  if (now - row.s.lastSeenAt > TOUCH_INTERVAL) {
    db.update(sessions).set({ lastSeenAt: now, expiresAt: now + sessionDays * DAY }).where(eq(sessions.id, id)).run();
  }
  return {
    user: toSessionUser(row.u),
    session: { id, csrfToken: row.s.csrfToken },
  };
}

export function destroySession(db: Orm, reply: FastifyReply, sessionId: string | undefined): void {
  if (sessionId) db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Signs a user out everywhere, optionally keeping one session (e.g. the one changing the password). */
export function revokeUserSessions(db: Orm, userId: number, keepSessionId?: string): void {
  const cond = keepSessionId ? and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)) : eq(sessions.userId, userId);
  db.delete(sessions).where(cond).run();
}

export function purgeExpiredSessions(db: Orm): void {
  db.delete(sessions).where(lt(sessions.expiresAt, Date.now())).run();
}
