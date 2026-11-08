import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { inviteUses, invites, users, type Role } from '../db/schema.js';
import { JellyfinClient } from '../integrations/jellyfin.js';
import { PlexClient } from '../integrations/plex.js';
import * as plextv from '../integrations/plextv.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { upstream } from '../library/routes.js';
import { openSecret, sealSecret } from '../arr/secrets.js';
import { hashPassword, passwordProblem } from '../security/passwords.js';
import { randomToken, sha256 } from '../security/crypto.js';
import { peekAuthState, putAuthState, takeAuthState } from './external.js';
import { plexHeadersFor } from './plex.js';
import { usernameSchema } from './routes.js';
import { createSession } from './sessions.js';

/**
 * Invite links, in the spirit of Wizarr: an admin makes a link, and whoever opens it makes their
 * own account, either with a username and password or by signing in with Plex. The invite can set
 * their role and kids age limit, share the Plex server with their Plex account, and make them a
 * Jellyfin account with the same name and password. A link can be single-use or shared, and expire.
 */
type InviteRow = typeof invites.$inferSelect;

const INVALID = "This invite link isn't valid any more. Ask whoever sent it for a new one.";

function findInvite(app: FastifyInstance, code: string): InviteRow | null {
  if (!/^[\w-]{10,64}$/.test(code)) return null;
  const row = app.ctx.db.select().from(invites).where(eq(invites.codeHash, sha256(code))).get();
  if (!row) return null;
  if (row.expiresAt !== null && row.expiresAt < Date.now()) return null;
  if (row.usesLeft !== null && row.usesLeft <= 0) return null;
  return row;
}

/** Takes one use of an invite, atomically, so two people can't both take its last use. */
function consume(app: FastifyInstance, id: number): boolean {
  const res = app.ctx.dbHandle.sqlite
    .prepare('UPDATE invites SET used = used + 1, uses_left = CASE WHEN uses_left IS NULL THEN NULL ELSE uses_left - 1 END WHERE id = ? AND (uses_left IS NULL OR uses_left > 0) AND (expires_at IS NULL OR expires_at > ?)')
    .run(id, Date.now());
  return res.changes === 1;
}

const plexReady = (app: FastifyInstance) => {
  const p = app.ctx.settings.get('plex');
  return Boolean(p.enabled && p.url && p.token && (p.machineId || app.ctx.settings.get('auth').plex.serverMachineId));
};
const jellyfinReady = (app: FastifyInstance) => {
  const j = app.ctx.settings.get('jellyfin');
  return Boolean(j.enabled && j.url && j.apiKey);
};

function uniqueUsername(app: FastifyInstance, wanted: string): string {
  const base = wanted.replace(/[^a-zA-Z0-9._@-]/g, '').slice(0, 56) || 'user';
  let name = base.length >= 2 ? base : `${base}user`;
  for (let i = 2; app.ctx.db.select({ id: users.id }).from(users).where(eq(users.username, name)).get(); i++) name = `${base}${i}`;
  return name;
}

export async function inviteRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const rate = { rateLimit: { max: 20, timeWindow: '1 minute' } };

  const view = (r: InviteRow) => {
    const code = openSecret(ctx, r.code);
    const base = ctx.settings.get('general').baseUrl.replace(/\/+$/, '');
    const joined = ctx.db.select({ username: users.username, usedAt: inviteUses.usedAt, note: inviteUses.note }).from(inviteUses).innerJoin(users, eq(users.id, inviteUses.userId)).where(eq(inviteUses.inviteId, r.id)).all();
    return {
      id: r.id,
      label: r.label,
      role: r.role,
      maxAge: r.maxAge,
      canRequest4k: r.canRequest4k,
      usesLeft: r.usesLeft,
      used: r.used,
      expiresAt: r.expiresAt,
      plexShare: r.plexShare,
      plexSections: r.plexSections ? (JSON.parse(r.plexSections) as string[]) : null,
      jellyfinAccount: r.jellyfinAccount,
      createdAt: r.createdAt,
      path: `/invite/${code}`,
      url: base ? `${base}/invite/${code}` : null,
      active: (r.expiresAt === null || r.expiresAt > Date.now()) && (r.usesLeft === null || r.usesLeft > 0),
      joined,
    };
  };

  // ---- admins
  app.get('/api/invites', { config: { access: 'admin' } }, async () => ({
    invites: ctx.db.select().from(invites).orderBy(desc(invites.createdAt)).all().map(view),
    plex: plexReady(app),
    jellyfin: jellyfinReady(app),
  }));

  /** The Plex libraries an invite can share. */
  app.get('/api/invites/plex-libraries', { config: { access: 'admin' } }, async () => {
    if (!plexReady(app)) return { libraries: [] };
    const p = ctx.settings.get('plex');
    const all = await upstream(() => new PlexClient(p.url, p.token).sections());
    return { libraries: all.filter((s) => s.type === 'movie' || s.type === 'show') };
  });

  app.post('/api/invites', { config: { access: 'admin' } }, async (req) => {
    const b = parse(
      z.object({
        label: z.string().trim().max(100).optional(),
        role: z.enum(['user', 'manager', 'admin']).default('user'),
        maxAge: z.union([z.literal(7), z.literal(9), z.literal(12), z.literal(14), z.literal(16)]).nullable().default(null),
        canRequest4k: z.boolean().default(false),
        uses: z.number().int().min(1).max(100).nullable().default(1),
        expiresInDays: z.number().int().min(1).max(365).nullable().default(7),
        plexShare: z.boolean().default(false),
        plexSections: z.array(z.string().regex(/^\d{1,10}$/)).max(50).nullable().default(null),
        jellyfinAccount: z.boolean().default(false),
      }),
      req.body,
    );
    // Same rule as Settings → Users: only the owner can make admins.
    if (b.role === 'admin' && !req.user!.isOwner) throw forbidden('Only the owner can invite admins');
    if (b.plexShare && !plexReady(app)) throw badRequest('Connect Plex in Settings → Media servers first');
    if (b.jellyfinAccount && !jellyfinReady(app)) throw badRequest('Connect Jellyfin in Settings → Media servers first');
    const code = randomToken(16);
    const row = ctx.db
      .insert(invites)
      .values({
        codeHash: sha256(code),
        code: sealSecret(ctx, code)!,
        label: b.label || null,
        role: b.role,
        maxAge: b.role === 'user' ? b.maxAge : null,
        canRequest4k: b.canRequest4k,
        usesLeft: b.uses,
        expiresAt: b.expiresInDays ? Date.now() + b.expiresInDays * 24 * 60 * 60 * 1000 : null,
        plexShare: b.plexShare,
        plexSections: b.plexShare && b.plexSections ? JSON.stringify(b.plexSections) : null,
        jellyfinAccount: b.jellyfinAccount,
        createdBy: req.user!.id,
        createdAt: Date.now(),
      })
      .returning()
      .get();
    audit(ctx.db, req, 'invite.created', { target: b.label ?? `#${row.id}`, details: { role: b.role, uses: b.uses, plex: b.plexShare, jellyfin: b.jellyfinAccount } });
    return view(row);
  });

  app.delete('/api/invites/:id', { config: { access: 'admin' } }, async (req) => {
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const row = ctx.db.select().from(invites).where(eq(invites.id, id)).get();
    if (!row) throw notFound();
    if (row.role === 'admin' && !req.user!.isOwner) throw forbidden('Only the owner can manage admin invites');
    ctx.db.delete(invites).where(eq(invites.id, id)).run();
    audit(ctx.db, req, 'invite.deleted', { target: row.label ?? `#${row.id}` });
    return { ok: true };
  });

  // ---- whoever has the link
  app.get('/api/invites/open/:code', { config: { access: 'public', ...rate } }, async (req) => {
    const { code } = parse(z.object({ code: z.string().max(100) }), req.params);
    const row = findInvite(app, code);
    if (!row) return { valid: false, message: INVALID };
    const auth = ctx.settings.get('auth');
    return {
      valid: true,
      label: row.label,
      // A password account only helps when people can sign in with one.
      password: auth.localLoginEnabled,
      plex: plexReady(app),
      plexShare: row.plexShare,
      jellyfin: row.jellyfinAccount,
    };
  });

  /** Makes the account, sets it up as the invite says and signs it in. */
  async function join(req: FastifyRequest, row: InviteRow, values: Partial<typeof users.$inferInsert> & { username: string }, extras: { password?: string; plexInvitee?: string }) {
    if (!consume(app, row.id)) throw new HttpError(410, INVALID, 'gone');
    const user = ctx.db
      .insert(users)
      .values({ ...values, role: row.role as Role, maxAge: row.maxAge, canRequest4k: row.canRequest4k, createdAt: Date.now() })
      .returning()
      .get();
    const notes: string[] = [];
    if (row.jellyfinAccount && extras.password && jellyfinReady(app)) {
      const j = ctx.settings.get('jellyfin');
      try {
        const id = await new JellyfinClient(j.url, j.apiKey).createUser(user.username, extras.password);
        ctx.db.update(users).set({ jellyfinUserId: id }).where(eq(users.id, user.id)).run();
      } catch (err) {
        notes.push(`Jellyfin account: ${(err as Error).message}`);
      }
    }
    if (row.plexShare && extras.plexInvitee && plexReady(app)) {
      const p = ctx.settings.get('plex');
      try {
        await plextv.shareServer(plexHeadersFor(ctx), p.token, p.machineId || ctx.settings.get('auth').plex.serverMachineId, extras.plexInvitee, row.plexSections ? (JSON.parse(row.plexSections) as string[]) : null);
      } catch (err) {
        notes.push(`Plex share: ${(err as Error).message}`);
      }
    }
    ctx.db.insert(inviteUses).values({ inviteId: row.id, userId: user.id, usedAt: Date.now(), note: notes.join('. ') || null }).run();
    audit(ctx.db, req, 'invite.used', { user: { id: user.id, username: user.username }, target: row.label ?? `#${row.id}`, details: { role: row.role, problems: notes.length ? notes : undefined } });
    ctx.live.publish({ topic: 'users', access: 'admin' });
    return { user, notes };
  }

  app.post('/api/invites/open/:code', { config: { access: 'public', ...rate } }, async (req, reply) => {
    const { code } = parse(z.object({ code: z.string().max(100) }), req.params);
    const b = parse(z.object({ username: usernameSchema, password: z.string().max(1024), email: z.union([z.literal(''), z.email().max(254)]).optional() }), req.body);
    const row = findInvite(app, code);
    if (!row) throw new HttpError(410, INVALID, 'gone');
    if (!ctx.settings.get('auth').localLoginEnabled) throw badRequest('Use Plex to join');
    const problem = passwordProblem(b.password, b.username);
    if (problem) throw badRequest(problem);
    if (ctx.db.select({ id: users.id }).from(users).where(eq(users.username, b.username)).get()) throw conflict('That username is taken. Try another.');
    const passwordHash = await hashPassword(b.password);
    const { user, notes } = await join(req, row, { username: b.username, passwordHash, email: b.email || null }, { password: b.password });
    createSession(ctx.db, req, reply, user.id, ctx.settings.get('auth').sessionDays);
    return { ok: true, notes };
  });

  /** Joining with Plex: the same PIN sign-in as Sign in with Plex, but it makes the account. */
  app.post('/api/invites/open/:code/plex', { config: { access: 'public', ...rate } }, async (req) => {
    const { code } = parse(z.object({ code: z.string().max(100) }), req.params);
    const row = findInvite(app, code);
    if (!row) throw new HttpError(410, INVALID, 'gone');
    const h = plexHeadersFor(ctx);
    const pin = await plextv.createPin(h).catch(() => {
      throw new HttpError(502, "Couldn't reach plex.tv", 'upstream');
    });
    const state = putAuthState(app, 'plex-invite', { pinId: pin.id, inviteId: row.id, codeHash: row.codeHash });
    return { state, authUrl: plextv.authAppUrl(h, pin.code) };
  });

  app.post('/api/invites/plex/poll', { config: { access: 'public', rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { state } = parse(z.object({ state: z.string().max(200) }), req.body);
    const saved = peekAuthState<{ pinId: number; inviteId: number; codeHash: string }>(app, 'plex-invite', state);
    if (!saved) throw badRequest('That took too long. Start again.');
    const h = plexHeadersFor(ctx);
    const token = await plextv.checkPin(h, saved.pinId).catch(() => null);
    if (!token) return { done: false };
    takeAuthState(app, 'plex-invite', state);
    const row = ctx.db.select().from(invites).where(and(eq(invites.id, saved.inviteId), eq(invites.codeHash, saved.codeHash))).get();
    if (!row || (row.expiresAt !== null && row.expiresAt < Date.now()) || (row.usesLeft !== null && row.usesLeft <= 0)) return { done: true, ok: false, error: INVALID };
    const account = await plextv.getAccount(h, token).catch(() => null);
    if (!account) return { done: true, ok: false, error: "Couldn't read your Plex account. Try again." };
    if (ctx.db.select({ id: users.id }).from(users).where(eq(users.plexId, String(account.id))).get()) {
      return { done: true, ok: false, error: 'You already have an account here. Use Sign in with Plex.' };
    }
    const { user, notes } = await join(
      req,
      row,
      { username: uniqueUsername(app, account.username), displayName: account.title || null, email: account.email || null, plexId: String(account.id), plexToken: sealSecret(ctx, token) },
      { plexInvitee: account.email || account.username },
    );
    createSession(ctx.db, req, reply, user.id, ctx.settings.get('auth').sessionDays);
    return { done: true, ok: true, notes, plexShared: row.plexShare && !notes.some((n) => n.startsWith('Plex')) };
  });

}
