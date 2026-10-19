import { desc, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditLog } from '../db/schema.js';
import { parse } from '../lib/validate.js';

export async function auditRoutes(app: FastifyInstance) {
  app.get('/api/audit', { config: { access: 'admin' } }, async (req) => {
    const q = parse(z.object({ before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const rows = app.ctx.db
      .select()
      .from(auditLog)
      .where(q.before ? lt(auditLog.id, q.before) : undefined)
      .orderBy(desc(auditLog.id))
      .limit(q.limit)
      .all();
    return rows.map((r) => ({ ...r, details: r.details ? (JSON.parse(r.details) as unknown) : null }));
  });
}

/** Keeps the audit log from growing forever. */
export function pruneAuditLog(app: FastifyInstance, days = 365): void {
  app.ctx.db.delete(auditLog).where(lt(auditLog.createdAt, Date.now() - days * 24 * 60 * 60 * 1000)).run();
}
