import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { monitored } from '../db/schema.js';
import { upstream } from '../library/routes.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { downloadTrailer, existingTrailers, removeTrailers, trailerCandidates, trailerJob } from './service.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

/** Trailer management for monitored titles (they have a folder to put trailers in). */
export async function trailerRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const getRow = (id: number) => {
    const r = ctx.db.select().from(monitored).where(eq(monitored.id, id)).get();
    if (!r) throw notFound('Not monitored');
    return r;
  };

  app.get('/api/monitored/:id/trailers', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const row = getRow(id);
    const s = ctx.settings.get('extras');
    return {
      enabled: s.trailersEnabled,
      files: existingTrailers(ctx, row),
      job: trailerJob(id),
      candidates: await upstream(() => trailerCandidates(ctx, row)),
    };
  });

  app.post('/api/monitored/:id/trailers', { config: { access: 'manager', rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { key } = parse(z.object({ key: z.string().regex(/^[\w-]{6,20}$/) }), req.body);
    const row = getRow(id);
    try {
      const job = downloadTrailer(ctx, row, key);
      audit(ctx.db, req, 'trailer.download', { target: row.title, details: { key } });
      return job;
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  });

  app.delete('/api/monitored/:id/trailers', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const row = getRow(id);
    const removed = removeTrailers(ctx, row);
    audit(ctx.db, req, 'trailer.removed', { target: row.title, details: { removed } });
    return { removed };
  });
}
