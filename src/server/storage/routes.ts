import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { badRequest } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { refreshMediaServers } from '../arr/tracker.js';
import { purge, restore } from '../files/recycle.js';
import { diskUse, forgetSizes, freeUp, recycled, rootPaths, suggestions, titleSizes } from './service.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const nameOf = (u: { displayName: string | null; username: string }) => u.displayName || u.username;

/** Settings → Storage: disk use, the biggest titles, suggestions and the recycle bin. */
export async function storageRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.get('/api/storage', { config: { access: 'manager' } }, async (req) => {
    const { fresh } = parse(z.object({ fresh: z.coerce.boolean().default(false) }), req.query);
    const titles = titleSizes(ctx, fresh);
    const bin = recycled(ctx);
    return {
      disks: diskUse(ctx),
      used: titles.reduce((n, t) => n + t.size, 0),
      largest: [...titles].sort((a, b) => b.size - a.size).slice(0, 25),
      kept: titles.filter((t) => t.keep),
      suggestions: suggestions(ctx, titles).slice(0, 100),
      recycleBin: { items: bin, size: bin.reduce((n, r) => n + r.size, 0) },
    };
  });

  /** Removes titles' files (into the recycle bin) and stops monitoring them. */
  app.post('/api/storage/free-up', { config: { access: 'manager' } }, async (req) => {
    const { ids } = parse(z.object({ ids: z.array(z.number().int().positive()).min(1).max(200) }), req.body);
    const r = freeUp(ctx, ids, nameOf(req.user!), 'Freed up space');
    audit(ctx.db, req, 'storage.freed', { details: { ids, ...r } });
    if (r.removed) void refreshMediaServers(ctx);
    return r;
  });

  app.post('/api/storage/recycle/:id/restore', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    try {
      const r = restore(ctx, id, rootPaths(ctx));
      audit(ctx.db, req, 'storage.restored', { target: r.path });
      forgetSizes();
      void refreshMediaServers(ctx);
      return { ok: true, ...r, hint: 'Rescan the title (Files → Rescan) so Cinemask tracks it again.' };
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  });

  /** Deletes something from the recycle bin for good. */
  app.delete('/api/storage/recycle/:id', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const freed = purge(ctx, id, rootPaths(ctx));
    audit(ctx.db, req, 'storage.purged', { details: { id, freed } });
    return { ok: true, freed };
  });
}
