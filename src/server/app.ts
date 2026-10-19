import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { seedProfiles } from './arr/profiles.js';
import { bookRoutes } from './books/routes.js';
import { calendarRoutes } from './calendar/routes.js';
import { collectionRoutes } from './collections/routes.js';
import { discoverRoutes } from './discover/routes.js';
import { homeRoutes } from './home/routes.js';
import { listRoutes } from './lists/routes.js';
import { posterRoutes } from './posters/routes.js';
import { trailerRoutes } from './trailers/routes.js';
import { fileRoutes } from './files/routes.js';
import { healthRoutes } from './health/routes.js';
import { arrRoutes } from './arr/routes.js';
import { auditRoutes } from './audit/routes.js';
import { registerGuard } from './auth/guard.js';
import { oidcRoutes } from './auth/oidc.js';
import { plexAuthRoutes } from './auth/plex.js';
import { authRoutes } from './auth/routes.js';
import { backupRoutes } from './backup/routes.js';
import { BackupService, writeBackupArchive } from './backup/service.js';
import type { AppConfig } from './config.js';
import type { AppContext } from './context.js';
import { databasePath, migrate, openDatabase, pendingMigrations, schemaVersion } from './db/database.js';
import { integrationRoutes } from './integrations/routes.js';
import { Scheduler } from './jobs/scheduler.js';
import { libraryRoutes } from './library/routes.js';
import { LibrarySync } from './library/service.js';
import { HttpError } from './lib/errors.js';
import { loadOrCreateSecretKey } from './security/crypto.js';
import { settingsRoutes } from './settings/routes.js';
import { SettingsStore } from './settings/store.js';
import { userRoutes } from './users/routes.js';

export interface BuiltApp {
  app: FastifyInstance;
  backups: BackupService;
  scheduler: Scheduler;
  librarySync: LibrarySync;
}

export async function buildApp(config: AppConfig, opts: { logger?: boolean } = {}): Promise<BuiltApp> {
  fs.mkdirSync(config.configDir, { recursive: true, mode: 0o700 });
  const secretKey = loadOrCreateSecretKey(config.configDir);
  const dbHandle = openDatabase(databasePath(config.configDir));

  // Snapshot an existing database before changing its schema, so a bad upgrade can be rolled back.
  if (schemaVersion(dbHandle.sqlite) > 0 && pendingMigrations(dbHandle.sqlite).length > 0) {
    await writeBackupArchive(config.configDir, dbHandle.sqlite, { reason: 'pre-upgrade', version: config.version });
  }
  migrate(dbHandle.sqlite);

  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel, redact: ['req.headers.cookie', 'req.headers["x-csrf-token"]', 'req.headers["x-backup-passphrase"]'] },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  const ctx: AppContext = {
    config,
    dbHandle,
    get db() {
      return this.dbHandle.orm;
    },
    secretKey,
    settings: undefined as unknown as SettingsStore,
  };
  ctx.settings = new SettingsStore(() => ctx.db, () => ctx.secretKey);
  seedProfiles(ctx);
  app.decorate('ctx', ctx);

  const backups = new BackupService(ctx);
  const librarySync = new LibrarySync(ctx);
  const scheduler = new Scheduler(app, backups, librarySync);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    if (err instanceof ZodError) {
      const detail = err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
      return reply.code(400).send({ error: detail, code: 'validation' });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status < 500) return reply.code(status).send({ error: (err as Error).message });
    req.log.error({ err }, 'Unhandled error');
    return reply.code(500).send({ error: 'Something went wrong. Check the server logs.' });
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameSrc: ['https://www.youtube-nocookie.com'],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    // Many home setups serve over plain HTTP on the LAN; HSTS is the reverse proxy's job.
    strictTransportSecurity: false,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  registerGuard(app);

  app.get('/api/health', { config: { access: 'public' } }, async () => ({ status: 'ok' }));
  await app.register(authRoutes);
  await app.register(oidcRoutes);
  await app.register(plexAuthRoutes);
  await app.register(userRoutes);
  await app.register(auditRoutes);
  await app.register(settingsRoutes, {
    onChange: (section: string) => {
      if (section === 'backup') scheduler.rescheduleBackups();
      if (section === 'library') scheduler.rescheduleLibrarySync();
      if (section === 'downloading') scheduler.rescheduleDownloading();
    },
  });
  await app.register(backupRoutes, { backups, nextRun: () => scheduler.nextBackup() });
  await app.register(integrationRoutes);
  await app.register(libraryRoutes, { sync: librarySync });
  await app.register(arrRoutes);
  await app.register(fileRoutes);
  await app.register(calendarRoutes);
  await app.register(healthRoutes, { backups, librarySync });
  await app.register(discoverRoutes);
  await app.register(listRoutes);
  await app.register(collectionRoutes);
  await app.register(posterRoutes);
  await app.register(trailerRoutes);
  await app.register(homeRoutes);
  await app.register(bookRoutes);

  if (config.webDir && fs.existsSync(config.webDir)) {
    await app.register(fastifyStatic, { root: path.resolve(config.webDir), wildcard: false });
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || !config.webDir || req.method !== 'GET') {
      return reply.code(404).send({ error: 'Not found', code: 'not_found' });
    }
    return reply.sendFile('index.html');
  });

  app.addHook('onClose', async () => {
    await scheduler.stop();
    ctx.dbHandle.sqlite.close();
  });

  return { app, backups, scheduler, librarySync };
}
