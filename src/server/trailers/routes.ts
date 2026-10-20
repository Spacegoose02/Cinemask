import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { MEDIA_KINDS, monitored } from '../db/schema.js';
import { upstream } from '../library/routes.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { downloadTrailer, existingTrailers, parseVideoUrl, removeTrailers, trailerCandidates, trailerJob, trailerMime } from './service.js';

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
    const body = parse(
      z.union([
        z.object({ key: z.string().regex(/^[\w-]{4,20}$/), site: z.enum(['YouTube', 'Vimeo']).default('YouTube') }),
        // A YouTube or Vimeo link pasted by hand, for a trailer TMDB doesn't list.
        z.object({ url: z.string().max(500) }),
      ]),
      req.body,
    );
    const video = 'url' in body ? parseVideoUrl(body.url) : body;
    if (!video) throw badRequest('Paste a YouTube or Vimeo link');
    const row = getRow(id);
    try {
      const job = downloadTrailer(ctx, row, video.key, video.site);
      audit(ctx.db, req, 'trailer.download', { target: row.title, details: video });
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

  // ---------------- Watching trailers already on disk ----------------
  const titleParams = z.object({ kind: z.enum(MEDIA_KINDS), tmdbId: z.coerce.number().int().positive() });
  const localTrailers = (kind: (typeof MEDIA_KINDS)[number], tmdbId: number) => {
    const row = ctx.db.select().from(monitored).where(and(eq(monitored.kind, kind), eq(monitored.tmdbId, tmdbId))).get();
    return row ? existingTrailers(ctx, row) : [];
  };

  /** Trailer files next to a title on the server, for anyone who can browse. Paths are not shown. */
  app.get('/api/trailers/:kind/:tmdbId', { config: { access: 'user' } }, async (req) => {
    const p = parse(titleParams, req.params);
    return localTrailers(p.kind, p.tmdbId).map((t, index) => ({ index, name: path.parse(t.path).name, size: t.size, type: trailerMime(t.path) }));
  });

  /** Streams one of those files, with range requests so the player can seek. */
  app.get('/api/trailers/:kind/:tmdbId/:index', { config: { access: 'user' } }, async (req, reply) => {
    const p = parse(titleParams.extend({ index: z.coerce.number().int().min(0).max(100) }), req.params);
    const file = localTrailers(p.kind, p.tmdbId)[p.index];
    if (!file) throw notFound('No such trailer');
    const size = fs.statSync(file.path).size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    reply.header('accept-ranges', 'bytes').header('content-type', trailerMime(file.path)).header('cache-control', 'private, max-age=3600');
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) return reply.code(416).header('content-range', `bytes */${size}`).send();
      reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1);
      return reply.send(fs.createReadStream(file.path, { start, end }));
    }
    reply.header('content-length', size);
    return reply.send(fs.createReadStream(file.path));
  });
}
