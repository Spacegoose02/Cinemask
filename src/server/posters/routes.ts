import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { checkPosterUrl, posterValue } from '../collections/routes.js';
import { MEDIA_KINDS } from '../db/schema.js';
import { upstream } from '../library/routes.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { applyPoster, posterOptions, resetPoster } from './service.js';
import { applyOverlays, lastOverlayRun, overlaySample, overlayCount, overlaysRunning, previewOverlay, removeOverlays } from './overlays.js';

const params = z.object({ kind: z.enum(MEDIA_KINDS), tmdbId: z.coerce.number().int().positive() });
const MAX_UPLOAD = 10 * 1024 * 1024;

export async function posterRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  // Raw image uploads arrive as bytes; the type is checked from the content, not this header.
  for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
    app.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: MAX_UPLOAD }, (_req, body, done) => done(null, body));
  }

  app.get('/api/posters/:kind/:tmdbId', { config: { access: 'manager' } }, async (req) => {
    const p = parse(params, req.params);
    return upstream(() => posterOptions(ctx, p.kind, p.tmdbId));
  });

  /** Sets the poster from a TMDB/ThePosterDB/https choice (JSON) or an uploaded image (raw body). */
  app.post('/api/posters/:kind/:tmdbId', { config: { access: 'manager' }, bodyLimit: MAX_UPLOAD }, async (req) => {
    const p = parse(params, req.params);
    let input: { value: string } | { data: Buffer };
    if (Buffer.isBuffer(req.body)) input = { data: req.body };
    else {
      const { value } = parse(z.object({ value: posterValue }), req.body);
      await checkPosterUrl(value);
      input = { value };
    }
    try {
      const result = await applyPoster(ctx, p.kind, p.tmdbId, input);
      audit(ctx.db, req, 'poster.changed', { target: `${p.kind}:${p.tmdbId}`, details: { upload: 'data' in input, servers: result.servers } });
      // With overlays on, the new poster gets its badges straight away.
      if (!overlaysRunning(ctx)) void applyOverlays(ctx, p).catch(() => undefined);
      return result;
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  });

  app.delete('/api/posters/:kind/:tmdbId', { config: { access: 'manager' } }, async (req) => {
    const p = parse(params, req.params);
    resetPoster(ctx, p.kind, p.tmdbId);
    audit(ctx.db, req, 'poster.reset', { target: `${p.kind}:${p.tmdbId}` });
    return { ok: true };
  });

  // ---------------- Overlays: badges on posters, pushed to the servers ----------------

  app.get('/api/overlays', { config: { access: 'admin' } }, async () => ({
    enabled: ctx.settings.get('overlays').enabled,
    applied: overlayCount(ctx),
    running: overlaysRunning(ctx),
    lastRun: lastOverlayRun(ctx),
    sample: overlaySample(ctx),
  }));

  /** The poster as it would look, drawn here and never sent to a server. */
  app.get('/api/overlays/preview/:kind/:tmdbId', { config: { access: 'admin' } }, async (req, reply) => {
    const p = parse(params, req.params);
    const img = await upstream(() => previewOverlay(ctx, p.kind, p.tmdbId));
    if (!img) throw new HttpError(404, 'That title has no poster to draw on', 'not_found');
    return reply.header('cache-control', 'no-store').type('image/jpeg').send(img);
  });

  /** Redraws badges now instead of waiting for the nightly run. Runs in the background. */
  app.post('/api/overlays/run', { config: { access: 'admin' } }, async (req) => {
    if (!ctx.settings.get('overlays').enabled) throw badRequest('Turn overlays on first');
    if (overlaysRunning(ctx)) throw new HttpError(409, 'Overlays are already being updated', 'conflict');
    audit(ctx.db, req, 'overlays.run');
    void applyOverlays(ctx)
      .catch(() => undefined)
      .finally(() => ctx.live.publish({ topic: 'overlays', access: 'admin' }));
    return { started: true };
  });

  /** Puts the clean posters back on every title that has badges. */
  app.post('/api/overlays/remove', { config: { access: 'admin' } }, async (req) => {
    if (overlaysRunning(ctx)) throw new HttpError(409, 'Overlays are already being updated', 'conflict');
    audit(ctx.db, req, 'overlays.removed', { details: { titles: overlayCount(ctx) } });
    void removeOverlays(ctx)
      .catch(() => undefined)
      .finally(() => ctx.live.publish({ topic: 'overlays', access: 'admin' }));
    return { started: true };
  });
}
