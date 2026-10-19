import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BackupService } from '../backup/service.js';
import type { LibrarySync } from '../library/service.js';
import { parse } from '../lib/validate.js';
import { runHealthChecks, type HealthReport } from './service.js';

const MAX_AGE = 5 * 60 * 1000;

/** Health section of Settings. Results are cached so opening the page doesn't hammer every service. */
export async function healthRoutes(app: FastifyInstance, opts: { backups: BackupService; librarySync: LibrarySync }) {
  let cached: HealthReport | null = null;
  let running: Promise<HealthReport> | null = null;
  const run = () => {
    running ??= runHealthChecks(app.ctx, { ...opts, configDir: app.ctx.config.configDir })
      .then((r) => (cached = r))
      .finally(() => (running = null));
    return running;
  };
  app.decorate('runHealth', run);

  app.get('/api/system/health', { config: { access: 'admin' } }, async (req) => {
    const { refresh } = parse(z.object({ refresh: z.coerce.boolean().default(false) }), req.query);
    if (refresh || !cached || Date.now() - cached.checkedAt > MAX_AGE) return run();
    return cached;
  });

  /** Just the overall level, for the nav badge. Never triggers a run. */
  app.get('/api/system/health/summary', { config: { access: 'admin' } }, async () => ({
    level: cached?.level ?? null,
    problems: cached?.checks.filter((c) => c.level !== 'ok').length ?? 0,
    checkedAt: cached?.checkedAt ?? null,
  }));
}

declare module 'fastify' {
  interface FastifyInstance {
    runHealth: () => Promise<HealthReport>;
  }
}
