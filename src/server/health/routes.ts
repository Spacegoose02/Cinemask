import type { FastifyInstance } from 'fastify';
import { notify } from '../notify/service.js';
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
      .then((r) => {
        // Tell the webhook when things go from fine (or unknown) to a problem, not on every hourly run.
        if (r.level !== 'ok' && r.level !== cached?.level) {
          const bad = r.checks.filter((c) => c.level !== 'ok');
          notify(app.ctx, { event: 'health.problem', title: 'Cinemask needs attention', message: bad.map((c) => `${c.name}: ${c.message}`).join('\n'), data: { level: r.level, problems: bad.length } });
        }
        return (cached = r);
      })
      .finally(() => (running = null));
    return running;
  };
  app.decorate('runHealth', run);

  app.get('/api/system/health', { config: { access: 'admin' } }, async (req) => {
    const { refresh } = parse(z.object({ refresh: z.coerce.boolean().default(false) }), req.query);
    if (refresh || !cached || Date.now() - cached.checkedAt > MAX_AGE) return run();
    return cached;
  });

  const summary = () => ({
    level: cached?.level ?? null,
    problems: cached?.checks.filter((c) => c.level !== 'ok').length ?? 0,
    checkedAt: cached?.checkedAt ?? null,
  });
  app.decorate('healthSummary', summary);

  /** Just the overall level, for the nav badge. Never triggers a run. */
  app.get('/api/system/health/summary', { config: { access: 'admin', apiKey: true } }, async () => summary());
}

declare module 'fastify' {
  interface FastifyInstance {
    runHealth: () => Promise<HealthReport>;
    healthSummary: () => { level: HealthReport['level'] | null; problems: number; checkedAt: number | null };
  }
}

// Register on the root instance (like fastify-plugin does) so runHealth and healthSummary are visible
// to the scheduler and other plugins. Without this, Fastify keeps decorations inside this plugin.
Object.assign(healthRoutes, { [Symbol.for('skip-override')]: true });
