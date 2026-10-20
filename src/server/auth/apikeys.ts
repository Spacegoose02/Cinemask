import { and, eq } from 'drizzle-orm';
import type { Orm } from '../db/database.js';
import { apiKeys, users, type API_KEY_ACCESS } from '../db/schema.js';
import { keyedSlowHash, randomToken } from '../security/crypto.js';
import { toSessionUser, type SessionUser } from './sessions.js';

export const API_KEY_HEADER = 'x-api-key';
const PREFIX = 'cmk_';
const TOUCH_INTERVAL = 60 * 1000;

export type ApiKeyAccess = (typeof API_KEY_ACCESS)[number];

export interface ApiKeyInfo {
  id: number;
  access: ApiKeyAccess;
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKey: ApiKeyInfo | null;
  }
}

/** A new key. Only its hash is stored, so this is the one time anyone sees it. */
export function generateApiKey(secretKey: Buffer): { key: string; prefix: string; hash: string } {
  const key = `${PREFIX}${randomToken(30)}`;
  return { key, prefix: key.slice(0, PREFIX.length + 6), hash: hashApiKey(secretKey, key) };
}

// Hashing is slow on purpose, so recent results are kept in memory: a Home Assistant poll every few
// seconds shouldn't pay for scrypt each time. Keys are 240-bit random, so light scrypt settings are enough.
const hashCache = new Map<string, string>();
const CACHE_MAX = 200;

function hashApiKey(secretKey: Buffer, key: string): string {
  const hit = hashCache.get(key);
  if (hit) return hit;
  const hash = keyedSlowHash(secretKey, 'api-key', key);
  if (hashCache.size >= CACHE_MAX) hashCache.delete(hashCache.keys().next().value!);
  hashCache.set(key, hash);
  return hash;
}

/** The key from `X-Api-Key` or `Authorization: Bearer`. Query strings are never read, since they end up in logs. */
export function apiKeyFrom(headers: Record<string, string | string[] | undefined>): string | null {
  const direct = headers[API_KEY_HEADER];
  if (typeof direct === 'string' && direct) return direct.trim();
  const auth = headers.authorization;
  if (typeof auth === 'string' && /^Bearer cmk_/i.test(auth)) return auth.slice(7).trim();
  return null;
}

/** The user behind a key, or null if it's unknown, expired, or its user is disabled. */
export function loadApiKey(db: Orm, secretKey: Buffer, key: string): { user: SessionUser; apiKey: ApiKeyInfo } | null {
  if (!key.startsWith(PREFIX) || key.length > 100) return null;
  const row = db.select({ k: apiKeys, u: users }).from(apiKeys).innerJoin(users, eq(users.id, apiKeys.userId)).where(eq(apiKeys.keyHash, hashApiKey(secretKey, key))).get();
  if (!row || row.u.disabled) return null;
  const now = Date.now();
  if (row.k.expiresAt && row.k.expiresAt < now) return null;
  if (!row.k.lastUsedAt || now - row.k.lastUsedAt > TOUCH_INTERVAL) db.update(apiKeys).set({ lastUsedAt: now }).where(and(eq(apiKeys.id, row.k.id))).run();
  return { user: toSessionUser(row.u), apiKey: { id: row.k.id, access: row.k.access } };
}
