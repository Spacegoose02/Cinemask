import { eq, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authStates, users, type Role } from '../db/schema.js';
import { randomToken } from '../security/crypto.js';

const STATE_TTL = 10 * 60 * 1000;

/** Short-lived server-side state for SSO round trips (OIDC state/PKCE, Plex PIN). Single use. */
export function putAuthState(app: FastifyInstance, kind: string, data: Record<string, unknown>): string {
  const state = randomToken(24);
  app.ctx.db.delete(authStates).where(lt(authStates.expiresAt, Date.now())).run();
  app.ctx.db.insert(authStates).values({ state, kind, data: JSON.stringify(data), expiresAt: Date.now() + STATE_TTL }).run();
  return state;
}

export function peekAuthState<T>(app: FastifyInstance, kind: string, state: string): T | null {
  const row = app.ctx.db.select().from(authStates).where(eq(authStates.state, state)).get();
  if (!row || row.kind !== kind || row.expiresAt < Date.now()) return null;
  return JSON.parse(row.data) as T;
}

export function takeAuthState<T>(app: FastifyInstance, kind: string, state: string): T | null {
  const data = peekAuthState<T>(app, kind, state);
  app.ctx.db.delete(authStates).where(eq(authStates.state, state)).run();
  return data;
}

function uniqueUsername(app: FastifyInstance, wanted: string): string {
  const base = wanted.replace(/[^a-zA-Z0-9._@-]/g, '').slice(0, 56) || 'user';
  let name = base;
  for (let i = 2; app.ctx.db.select({ id: users.id }).from(users).where(eq(users.username, name)).get(); i++) name = `${base}${i}`;
  return name;
}

export interface ExternalIdentity {
  provider: 'oidc' | 'plex';
  externalId: string;
  username: string;
  displayName?: string | null;
  email?: string | null;
}

export type ExternalResult = { ok: true; userId: number; username: string } | { ok: false; reason: string };

/**
 * Resolves an SSO identity to a local user. Accounts are matched only by the provider's stable id,
 * never by email, so an attacker can't claim an account by setting someone else's email upstream.
 */
export function resolveExternalUser(
  app: FastifyInstance,
  id: ExternalIdentity,
  opts: { autoCreate: boolean; role: Role | null; defaultRole: Role; linkUserId?: number },
): ExternalResult {
  const col = id.provider === 'oidc' ? users.oidcSubject : users.plexId;
  const field = id.provider === 'oidc' ? 'oidcSubject' : 'plexId';
  const existing = app.ctx.db.select().from(users).where(eq(col, id.externalId)).get();

  if (opts.linkUserId !== undefined) {
    if (existing && existing.id !== opts.linkUserId) return { ok: false, reason: 'already_linked' };
    app.ctx.db.update(users).set({ [field]: id.externalId }).where(eq(users.id, opts.linkUserId)).run();
    const u = app.ctx.db.select().from(users).where(eq(users.id, opts.linkUserId)).get()!;
    return { ok: true, userId: u.id, username: u.username };
  }

  if (existing) {
    if (existing.disabled) return { ok: false, reason: 'account_disabled' };
    if (opts.role && !existing.isOwner && existing.role !== opts.role) {
      app.ctx.db.update(users).set({ role: opts.role }).where(eq(users.id, existing.id)).run();
    }
    return { ok: true, userId: existing.id, username: existing.username };
  }

  if (!opts.autoCreate) return { ok: false, reason: 'no_account' };
  const created = app.ctx.db
    .insert(users)
    .values({
      username: uniqueUsername(app, id.username),
      displayName: id.displayName ?? null,
      email: id.email ?? null,
      role: opts.role ?? opts.defaultRole,
      [field]: id.externalId,
      createdAt: Date.now(),
    })
    .returning()
    .get();
  return { ok: true, userId: created.id, username: created.username };
}
