import cron, { type ScheduledTask } from 'node-cron';
import type { FastifyInstance } from 'fastify';
import { lt } from 'drizzle-orm';
import { purgeExpiredSessions } from '../auth/sessions.js';
import { pruneAuditLog } from '../audit/routes.js';
import { audit } from '../audit/log.js';
import { authStates } from '../db/schema.js';
import type { BackupService } from '../backup/service.js';
import { rssSync, searchMissing } from '../arr/rss.js';
import { trackDownloads } from '../arr/tracker.js';
import { refreshMonitored } from '../calendar/service.js';
import { pollShelfmark, syncAudiobookshelf } from '../books/service.js';
import { syncCollections } from '../collections/service.js';
import { syncDueLists } from '../lists/service.js';
import { purgeHttpCache } from '../integrations/tmdb.js';
import type { LibrarySync } from '../library/service.js';

/** Background jobs. Kept in-process: a household install doesn't need a separate worker. */
export class Scheduler {
  private backupTask: ScheduledTask | null = null;
  private housekeeping: ScheduledTask | null = null;
  private libraryTask: ScheduledTask | null = null;
  private downloadTasks: ScheduledTask[] = [];
  private maintenance: ScheduledTask[] = [];
  private busy = new Set<string>();

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
    this.maintenance = [
      // Hourly health checks so problems show in the nav without opening Settings.
      cron.schedule('45 * * * *', this.once('health', () => this.app.runHealth())),
      // New episodes and changed release dates for the calendar.
      cron.schedule('20 */12 * * *', this.once('refresh-monitored', () => refreshMonitored(this.app.ctx))),
      // Lists sync on their own interval (checked hourly); collections follow their sources nightly.
      cron.schedule('10 * * * *', this.once('lists', () => syncDueLists(this.app.ctx))),
      cron.schedule('40 4 * * *', this.once('collections', () => syncCollections(this.app.ctx))),
      // Audiobookshelf's library every few hours; Shelfmark's queue every couple of minutes while books download.
      cron.schedule('25 */4 * * *', this.once('audiobookshelf', async () => (this.app.ctx.settings.get('audiobookshelf').enabled ? syncAudiobookshelf(this.app.ctx) : null))),
      cron.schedule('*/2 * * * *', this.once('shelfmark', () => pollShelfmark(this.app.ctx))),
    ];
    // First health run shortly after start, so the nav badge is right without waiting an hour.
    setTimeout(() => void this.once('health', () => this.app.runHealth())(), 30_000).unref();
    this.rescheduleBackups();
    this.rescheduleLibrarySync();
    this.rescheduleDownloading();
  }

  /** Runs a job unless the previous run of the same job is still going. */
  private once(name: string, fn: () => Promise<unknown>) {
    return async () => {
      if (this.busy.has(name)) return;
      this.busy.add(name);
      try {
        await fn();
      } catch (err) {
        this.app.log.error({ err }, `Job ${name} failed`);
      } finally {
        this.busy.delete(name);
      }
    };
  }

  rescheduleDownloading(): void {
    for (const t of this.downloadTasks) void t.destroy();
    const s = this.app.ctx.settings.get('downloading');
    const rss = s.rssSyncMinutes >= 60 ? `0 */${Math.min(23, Math.round(s.rssSyncMinutes / 60))} * * *` : `*/${s.rssSyncMinutes} * * * *`;
    this.downloadTasks = [
      cron.schedule('* * * * *', this.once('track', () => trackDownloads(this.app.ctx))),
      cron.schedule(rss, this.once('rss', () => rssSync(this.app.ctx))),
      cron.schedule('30 * * * *', this.once('missing', () => searchMissing(this.app.ctx, s.searchMissingHours))),
    ];
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
    for (const t of [...this.downloadTasks, ...this.maintenance]) await t.destroy();
  }
}
