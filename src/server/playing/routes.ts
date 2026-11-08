import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { plays } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { mediaServers } from '../library/service.js';
import { upstream } from '../library/routes.js';
import { nowPlaying, trackPlays, watchStats } from './service.js';

/** Now playing (managers) and stopping a stream (admins). Viewers' names and devices aren't shown to users. */
export async function playingRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.get('/api/playing', { config: { access: 'manager' } }, async (req) => {
    const { fresh } = parse(z.object({ fresh: z.coerce.boolean().default(false) }), req.query);
    if (fresh) await trackPlays(ctx);
    return { sessions: nowPlaying(ctx), servers: mediaServers(ctx).filter((s) => s.client.sessions).map((s) => s.server) };
  });

  app.get('/api/playing/stats', { config: { access: 'manager' } }, async (req) => {
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), req.query);
    return watchStats(ctx, days);
  });

  app.post('/api/playing/:id/stop', { config: { access: 'admin' } }, async (req) => {
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().max(200).default('Stopped by the server admin.') }), req.body ?? {});
    const row = ctx.db.select().from(plays).where(and(eq(plays.id, id), eq(plays.active, true))).get();
    if (!row || !row.controlId) throw notFound('That stream has already finished');
    const server = mediaServers(ctx).find((s) => s.server === row.server);
    if (!server?.client.stopSession) throw badRequest("That server can't stop streams from here");
    await upstream(() => server.client.stopSession!(row.controlId!, reason));
    audit(ctx.db, req, 'playing.stopped', { target: row.kind === 'episode' ? `${row.show} ${row.title}` : row.title, details: { user: row.user, server: row.server } });
    return { ok: true };
  });
}
