import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { usernameSchema } from '../auth/routes.js';
import { revokeUserSessions, type SessionUser } from '../auth/sessions.js';
import { ROLES, users } from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { hashPassword, passwordProblem } from '../security/passwords.js';

type UserRow = typeof users.$inferSelect;

function toPublic(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    email: u.email,
    role: u.role,
    isOwner: u.isOwner,
    disabled: u.disabled,
    autoApproveMovies: u.autoApproveMovies,
    autoApproveShows: u.autoApproveShows,
    hasPassword: Boolean(u.passwordHash),
    linked: { oidc: Boolean(u.oidcSubject), plex: Boolean(u.plexId) },
    locked: u.lockedUntil !== null && u.lockedUntil > Date.now(),
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  };
}

/** Only the owner may create, change or remove admins; nobody may change the owner except themselves. */
function assertCanManage(actor: SessionUser, target: UserRow | { role: string; isOwner: boolean }, nextRole?: string) {
  if (target.isOwner && !actor.isOwner) throw forbidden('Only the owner can change the owner account');
  if ((target.role === 'admin' || nextRole === 'admin') && !actor.isOwner) throw forbidden('Only the owner can manage admins');
}

const idParam = z.object({ id: z.coerce.number().int().positive() });
const emailSchema = z.union([z.literal(''), z.email().max(254)]);

export async function userRoutes(app: FastifyInstance) {
  const db = () => app.ctx.db;
  const getUser = (id: number) => {
    const u = db().select().from(users).where(eq(users.id, id)).get();
    if (!u) throw notFound('User not found');
    return u;
  };

  app.get('/api/users', { config: { access: 'admin' } }, async () => db().select().from(users).orderBy(asc(users.username)).all().map(toPublic));

  app.post('/api/users', { config: { access: 'admin' } }, async (req: FastifyRequest) => {
    const body = parse(
      z.object({
        username: usernameSchema,
        displayName: z.string().trim().max(100).optional(),
        email: emailSchema.optional(),
        role: z.enum(ROLES).default('user'),
        password: z.string(),
      }),
      req.body,
    );
    assertCanManage(req.user!, { role: body.role, isOwner: false });
    const problem = passwordProblem(body.password, body.username);
    if (problem) throw badRequest(problem);
    if (db().select({ id: users.id }).from(users).where(eq(users.username, body.username)).get()) throw conflict('Username is taken');
    const created = db()
      .insert(users)
      .values({
        username: body.username,
        displayName: body.displayName || null,
        email: body.email || null,
        role: body.role,
        passwordHash: await hashPassword(body.password),
        createdAt: Date.now(),
      })
      .returning()
      .get();
    audit(db(), req, 'user.created', { target: created.username, details: { role: created.role } });
    return toPublic(created);
  });

  app.patch('/api/users/:id', { config: { access: 'admin' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        displayName: z.string().trim().max(100).nullable().optional(),
        email: emailSchema.nullable().optional(),
        role: z.enum(ROLES).optional(),
        disabled: z.boolean().optional(),
        password: z.string().optional(),
        unlock: z.boolean().optional(),
        autoApproveMovies: z.boolean().optional(),
        autoApproveShows: z.boolean().optional(),
      }),
      req.body,
    );
    const target = getUser(id);
    assertCanManage(req.user!, target, body.role);
    if (target.isOwner && (body.role !== undefined && body.role !== 'admin')) throw badRequest('The owner must stay an admin');
    if (target.isOwner && body.disabled) throw badRequest('The owner cannot be disabled');
    if (target.id === req.user!.id && body.disabled) throw badRequest('You cannot disable yourself');

    const patch: Partial<UserRow> = {};
    if (body.displayName !== undefined) patch.displayName = body.displayName || null;
    if (body.email !== undefined) patch.email = body.email || null;
    if (body.role !== undefined) patch.role = body.role;
    if (body.disabled !== undefined) patch.disabled = body.disabled;
    if (body.autoApproveMovies !== undefined) patch.autoApproveMovies = body.autoApproveMovies;
    if (body.autoApproveShows !== undefined) patch.autoApproveShows = body.autoApproveShows;
    if (body.unlock) Object.assign(patch, { failedLogins: 0, lockedUntil: null });
    if (body.password !== undefined) {
      const problem = passwordProblem(body.password, target.username);
      if (problem) throw badRequest(problem);
      patch.passwordHash = await hashPassword(body.password);
    }
    if (Object.keys(patch).length) db().update(users).set(patch).where(eq(users.id, id)).run();
    // Any change to role, status or password signs the user out of their other sessions.
    if (body.role !== undefined || body.disabled || body.password !== undefined) {
      revokeUserSessions(db(), id, id === req.user!.id ? req.session!.id : undefined);
    }
    audit(db(), req, 'user.updated', {
      target: target.username,
      details: { ...body, password: body.password !== undefined ? '[changed]' : undefined },
    });
    return toPublic(getUser(id));
  });

  app.delete('/api/users/:id', { config: { access: 'admin' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const target = getUser(id);
    assertCanManage(req.user!, target);
    if (target.isOwner) throw badRequest('The owner account cannot be deleted');
    if (target.id === req.user!.id) throw badRequest('You cannot delete yourself');
    db().delete(users).where(eq(users.id, id)).run();
    audit(db(), req, 'user.deleted', { target: target.username });
    return { ok: true };
  });
}
