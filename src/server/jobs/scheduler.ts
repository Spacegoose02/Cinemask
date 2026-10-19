import cron, { type ScheduledTask } from 'node-cron';
import type { FastifyInstance } from 'fastify';
import { lt } from 'drizzle-orm';
import { purgeExpiredSessions } from '../auth/sessions.js';
import { pruneAuditLog } from '../audit/routes.js';
import { audit } from '../audit/log.js';
import { authStates } from '../db/schema.js';
import type { BackupService } from '../backup/service.js';
import { purgeHttpCache } from '../integrations/tmdb.js';
import type { LibrarySync } from '../library/service.js';

/** Background jobs. Kept in-process: a household install doesn't need a separate worker. */
export class Scheduler {
  private backupTask: ScheduledTask | null = null;
  private housekeeping: ScheduledTask | null = null;
  private libraryTask: ScheduledTask | null = null;

  constructor(
    private readonly app: FastifyInstance,
    private readonly backups: BackupService,
    private readonly librarySync: LibrarySync,
  ) {}

  start(): void {
    this.housekeeping = cron.schedule('17 * * * *', () => {
      purgeExpiredSessions(this.app.ctx.db);
      this.app.ctx.db.delete(authStates).where(lt(authStates.expiresAt, Date.now())).run();
      pruneAuditLog(this.app);
      purgeHttpCache(this.app.ctx.db);
    });
    this.rescheduleBackups();
    this.rescheduleLibrarySync();
  }

  rescheduleLibrarySync(): void {
    void this.libraryTask?.destroy();
    this.libraryTask = null;
    const s = this.app.ctx.settings.get('library');
    if (!s.syncEnabled) return;
    const hours = s.syncIntervalHours >= 24 ? '3' : `*/${s.syncIntervalHours}`;
    this.libraryTask = cron.schedule(`5 ${hours} * * *`, async () => {
      await this.librarySync.run();
      await this.librarySync.backfillMetadata(200);
    });
  }

  rescheduleBackups(): void {
    void this.backupTask?.destroy();
    this.backupTask = null;
    const s = this.app.ctx.settings.get('backup');
    if (!s.scheduleEnabled) return;
    if (!cron.validate(s.cron)) {
      this.app.log.error({ cron: s.cron }, 'Invalid backup schedule; scheduled backups are off');
      return;
    }
    this.backupTask = cron.schedule(s.cron, async () => {
      try {
        const info = await this.backups.create('scheduled');
        audit(this.app.ctx.db, null, 'backup.created', { target: info.name, user: null, details: { scheduled: true } });
      } catch (err) {
        this.app.log.error({ err }, 'Scheduled backup failed');
      }
    });
  }

  nextBackup(): Date | null {
    return this.backupTask?.getNextRun() ?? null;
  }

  async stop(): Promise<void> {
    await this.backupTask?.destroy();
    await this.housekeeping?.destroy();
    await this.libraryTask?.destroy();
  }
}
