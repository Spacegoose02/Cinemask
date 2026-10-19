import type { FastifyRequest } from 'fastify';
import { auditLog } from '../db/schema.js';
import type { Orm } from '../db/database.js';

export function audit(
  db: Orm,
  req: FastifyRequest | null,
  action: string,
  opts: { target?: string; details?: Record<string, unknown>; user?: { id: number; username: string } | null } = {},
): void {
  const user = opts.user !== undefined ? opts.user : req?.user;
  db.insert(auditLog)
    .values({
      userId: user?.id ?? null,
      username: user?.username ?? null,
      action,
      target: opts.target ?? null,
      details: opts.details ? JSON.stringify(opts.details) : null,
      ip: req?.ip ?? null,
      createdAt: Date.now(),
    })
    .run();
}
