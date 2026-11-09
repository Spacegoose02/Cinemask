import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { MEDIA_KINDS } from '../db/schema.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import type { WatchmaskClient } from '../integrations/watchmask.js';
import { watchmaskClient } from './service.js';

const titleParams = z.object({ kind: z.enum(MEDIA_KINDS), tmdbId: z.coerce.number().int().positive() });
const listParams = titleParams.extend({ listId: z.coerce.number().int().positive() });
/** The title's name, only so the audit log reads well; Watchmask looks the title up by its TMDB id. */
const titleBody = z.object({ title: z.string().trim().max(300).optional() });

/**
 * Adding titles to Watchmask lists. Managers and up, because the lists belong to whoever's
 * Watchmask token is saved, not to the person clicking.
 */
export async function watchmaskRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const client = (): WatchmaskClient => {
    const c = watchmaskClient(ctx);
    if (!c) throw badRequest('Connect Watchmask in Settings → Metadata first', 'watchmask_off');
    return c;
  };
  /** Watchmask's own failures come back as 502 so they aren't mistaken for Cinemask refusing. */
  const relay = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, (err as Error).message, 'watchmask_failed');
    }
  };

  /** Whether Watchmask is connected, its lists, and the default list for one-tap adds. */
  app.get('/api/watchmask/lists', { config: { access: 'manager' } }, async () => {
    const c = watchmaskClient(ctx);
    if (!c) return { connected: false, defaultListId: null, lists: [] };
    const lists = await relay(() => c.lists());
    return { connected: true, defaultListId: ctx.settings.get('watchmask').defaultListId, lists };
  });

  /** Which Watchmask lists already have this title. */
  app.get('/api/watchmask/titles/:kind/:tmdbId', { config: { access: 'manager' } }, async (req) => {
    const { kind, tmdbId } = parse(titleParams, req.params);
    const c = client();
    return { listIds: await relay(() => c.memberships(kind, tmdbId)) };
  });

  app.put('/api/watchmask/titles/:kind/:tmdbId/lists/:listId', { config: { access: 'manager' } }, async (req) => {
    const { kind, tmdbId, listId } = parse(listParams, req.params);
    const { title } = parse(titleBody, req.body ?? {});
    const c = client();
    const added = await relay(() => c.add(kind, tmdbId, listId));
    if (added) audit(ctx.db, req, 'watchmask.added', { target: title || `${kind} ${tmdbId}`, details: { kind, tmdbId, listId } });
    return { ok: true, added };
  });

  app.delete('/api/watchmask/titles/:kind/:tmdbId/lists/:listId', { config: { access: 'manager' } }, async (req) => {
    const { kind, tmdbId, listId } = parse(listParams, req.params);
    const { title } = parse(titleBody, req.body ?? {});
    const c = client();
    const removed = await relay(() => c.remove(kind, tmdbId, listId));
    if (removed) audit(ctx.db, req, 'watchmask.removed', { target: title || `${kind} ${tmdbId}`, details: { kind, tmdbId, listId } });
    return { ok: true, removed };
  });
}
