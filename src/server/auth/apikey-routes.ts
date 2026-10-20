import { and, asc, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { API_KEY_ACCESS, apiKeys, users } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { generateApiKey } from './apikeys.js';

const MAX_KEYS = 20;
const DAY = 24 * 60 * 60 * 1000;
const idParam = z.object({ id: z.coerce.number().int().positive() });
export const THEME_NAMES = ['dark', 'light', 'retro', 'futuristic', '16bit'] as const;

const view = (k: typeof apiKeys.$inferSelect) => ({ id: k.id, name: k.name, prefix: k.prefix, access: k.access, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, expiresAt: k.expiresAt, expired: k.expiresAt !== null && k.expiresAt < Date.now() });

/** Personal API keys (Account → API keys) and the admin overview. Keys themselves can't reach any of these. */
export async function apiKeyRoutes(app: FastifyInstance) {
  const db = () => app.ctx.db;

  app.get('/api/auth/api-keys', { config: { access: 'user' } }, async (req) =>
    db().select().from(apiKeys).where(eq(apiKeys.userId, req.user!.id)).orderBy(desc(apiKeys.createdAt)).all().map(view),
  );

  app.post('/api/auth/api-keys', { config: { access: 'user' } }, async (req) => {
    if (!app.ctx.settings.get('auth').apiKeysEnabled) throw badRequest('An admin has turned API keys off');
    const body = parse(z.object({ name: z.string().trim().min(1).max(100), access: z.enum(API_KEY_ACCESS).default('read'), expiresDays: z.number().int().min(1).max(3650).nullable().default(null) }), req.body);
    if (db().select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.userId, req.user!.id)).all().length >= MAX_KEYS) throw badRequest(`You can have up to ${MAX_KEYS} keys. Delete one first.`);
    const { key, prefix, hash } = generateApiKey(app.ctx.secretKey);
    const now = Date.now();
    const row = db()
      .insert(apiKeys)
      .values({ userId: req.user!.id, name: body.name, prefix, keyHash: hash, access: body.access, createdAt: now, expiresAt: body.expiresDays ? now + body.expiresDays * DAY : null })
      .returning()
      .get();
    audit(db(), req, 'api_key.created', { target: body.name, details: { access: body.access, prefix } });
    return { ...view(row), key };
  });

  app.delete('/api/auth/api-keys/:id', { config: { access: 'user' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const row = db().select().from(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.userId, req.user!.id))).get();
    if (!row) throw notFound('Key not found');
    db().delete(apiKeys).where(eq(apiKeys.id, id)).run();
    audit(db(), req, 'api_key.deleted', { target: row.name, details: { prefix: row.prefix } });
    return { ok: true };
  });

  app.put('/api/auth/theme', { config: { access: 'user' } }, async (req) => {
    const { theme } = parse(z.object({ theme: z.enum(THEME_NAMES) }), req.body);
    db().update(users).set({ theme }).where(eq(users.id, req.user!.id)).run();
    return { ok: true };
  });

  /** Every key in the app, so admins can see what has access and revoke it. */
  app.get('/api/api-keys', { config: { access: 'admin' } }, async () =>
    db()
      .select({ k: apiKeys, username: users.username, role: users.role })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.userId))
      .orderBy(asc(users.username), desc(apiKeys.createdAt))
      .all()
      .map((r) => ({ ...view(r.k), username: r.username, role: r.role })),
  );

  app.delete('/api/api-keys/:id', { config: { access: 'admin' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const row = db().select().from(apiKeys).where(eq(apiKeys.id, id)).get();
    if (!row) throw notFound('Key not found');
    db().delete(apiKeys).where(eq(apiKeys.id, id)).run();
    audit(db(), req, 'api_key.revoked', { target: row.name, details: { prefix: row.prefix, userId: row.userId } });
    return { ok: true };
  });
}
