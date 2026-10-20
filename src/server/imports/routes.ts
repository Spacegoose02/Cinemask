import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { badRequest } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { IMPORT_SOURCES, importRuns, startImport, testImport } from './service.js';

const sourceParam = z.object({ source: z.enum(IMPORT_SOURCES) });

/** Importing from Radarr, Sonarr and Overseerr. Admin only, since it adds titles and requests in bulk. */
export async function importRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.post('/api/import/:source/test', { config: { access: 'admin' } }, async (req) => {
    const { source } = parse(sourceParam, req.params);
    try {
      return { ok: true, message: await testImport(ctx, source) };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });

  app.post('/api/import/:source', { config: { access: 'admin' } }, async (req) => {
    const { source } = parse(sourceParam, req.params);
    let run;
    try {
      run = startImport(ctx, source, req.user!.id);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    audit(ctx.db, req, 'import.started', { target: source });
    return run;
  });

  app.get('/api/import/:source', { config: { access: 'admin' } }, async (req) => {
    const { source } = parse(sourceParam, req.params);
    return importRuns.get(source) ?? null;
  });
}
