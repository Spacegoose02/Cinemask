import { and, desc, eq, gte } from 'drizzle-orm';
import fs from 'node:fs';
import type { AppContext } from '../context.js';
import { books, downloadClients, downloads, indexers, type DownloadClientType } from '../db/schema.js';
import { absClient, shelfmarkClient } from '../books/service.js';
import type { BackupService } from '../backup/service.js';
import { createClient } from '../arr/clients.js';
import { testIndexer } from '../arr/indexers.js';
import { openSecret } from '../arr/secrets.js';
import { JellyfinClient } from '../integrations/jellyfin.js';
import { PlexClient } from '../integrations/plex.js';
import { tmdbClient, type LibrarySync } from '../library/service.js';

export type HealthLevel = 'ok' | 'warning' | 'error';

export interface HealthCheck {
  id: string;
  group: 'Connections' | 'Storage' | 'Downloads' | 'Backups';
  name: string;
  level: HealthLevel;
  message: string;
  /** Settings tab that fixes it. */
  fix?: string;
}

export interface HealthReport {
  checkedAt: number;
  level: HealthLevel;
  checks: HealthCheck[];
  failedDownloads: { id: number; title: string; error: string | null; at: number }[];
}

const GB = 1024 ** 3;
const DAY = 24 * 60 * 60 * 1000;
const TIMEOUT = 15_000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Timed out')), TIMEOUT))]);
}

async function connection(id: string, name: string, fix: string, fn: () => Promise<string>): Promise<HealthCheck> {
  try {
    return { id, group: 'Connections', name, level: 'ok', message: await withTimeout(fn()), fix };
  } catch (err) {
    return { id, group: 'Connections', name, level: 'error', message: (err as Error).message, fix };
  }
}

export function formatSize(bytes: number): string {
  return bytes >= 1024 ** 4 ? `${(bytes / 1024 ** 4).toFixed(1)} TB` : `${(bytes / GB).toFixed(1)} GB`;
}

/** Free space and writability for a folder the app depends on. */
export function storageCheck(id: string, name: string, dir: string, fix: string): HealthCheck {
  const base = { id, group: 'Storage' as const, name, fix };
  if (!dir) return { ...base, level: 'warning', message: 'No folder set' };
  if (!fs.existsSync(dir)) return { ...base, level: 'error', message: `${dir} does not exist. Check the container's volume mappings.` };
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    return { ...base, level: 'error', message: `${dir} is not writable by the app (check PUID/PGID)` };
  }
  try {
    const s = fs.statfsSync(dir);
    const free = s.bavail * s.bsize;
    const total = s.blocks * s.bsize;
    const pct = total ? (free / total) * 100 : 100;
    const msg = `${formatSize(free)} free of ${formatSize(total)} (${pct.toFixed(0)}%)`;
    if (free < 5 * GB || pct < 2) return { ...base, level: 'error', message: `Almost full: ${msg}` };
    if (free < 50 * GB || pct < 10) return { ...base, level: 'warning', message: `Running low: ${msg}` };
    return { ...base, level: 'ok', message: msg };
  } catch {
    return { ...base, level: 'ok', message: `${dir} is writable` };
  }
}

/** Runs every check in parallel. Results are cached by the caller; a run takes a few seconds at most. */
export async function runHealthChecks(ctx: AppContext, deps: { backups: BackupService; librarySync: LibrarySync; configDir: string }): Promise<HealthReport> {
  const pending: Promise<HealthCheck>[] = [];
  const plex = ctx.settings.get('plex');
  if (plex.enabled && plex.url && plex.token) {
    pending.push(connection('plex', `Plex${plex.name ? ` (${plex.name})` : ''}`, 'media-servers', async () => {
      const i = await new PlexClient(plex.url, plex.token!).test();
      return `Connected to ${i.name} (Plex ${i.version})`;
    }));
  }
  const jf = ctx.settings.get('jellyfin');
  if (jf.enabled && jf.url && jf.apiKey) {
    pending.push(connection('jellyfin', `Jellyfin${jf.name ? ` (${jf.name})` : ''}`, 'media-servers', async () => {
      const i = await new JellyfinClient(jf.url, jf.apiKey!).test();
      return `Connected to ${i.name} (Jellyfin ${i.version})`;
    }));
  }
  const abs = absClient(ctx);
  if (abs) pending.push(connection('audiobookshelf', 'Audiobookshelf', 'books', () => abs.test()));
  const sm = shelfmarkClient(ctx);
  if (sm) pending.push(connection('shelfmark', 'Shelfmark', 'books', () => sm.test()));
  const meta = ctx.settings.get('metadata');
  pending.push(
    meta.tmdbApiKey
      ? connection('tmdb', 'TMDB', 'metadata', async () => {
          await tmdbClient(ctx).test();
          return 'Key works';
        })
      : Promise.resolve({ id: 'tmdb', group: 'Connections', name: 'TMDB', level: 'error', message: 'No TMDB key. Search, requests and posters need one.', fix: 'metadata' }),
  );
  for (const i of ctx.db.select().from(indexers).where(eq(indexers.enabled, true)).all()) {
    pending.push(connection(`indexer-${i.id}`, `Indexer: ${i.name}`, 'indexers', async () => {
      const n = await testIndexer({ id: i.id, name: i.name, type: i.type, url: i.url, apiKey: openSecret(ctx, i.apiKey), categories: JSON.parse(i.categories) as number[] });
      return `${n} recent releases`;
    }));
  }
  const clients = ctx.db.select().from(downloadClients).where(eq(downloadClients.enabled, true)).all();
  for (const c of clients) {
    pending.push(connection(`client-${c.id}`, `Download client: ${c.name}`, 'download-clients', () =>
      createClient({ type: c.type as DownloadClientType, name: c.name, url: c.url, username: c.username, password: openSecret(ctx, c.password) }).test(),
    ));
  }
  const checks = await Promise.all(pending);

  if (!ctx.db.select().from(indexers).where(eq(indexers.enabled, true)).all().length) {
    checks.push({ id: 'indexers', group: 'Downloads', name: 'Indexers', level: 'warning', message: 'No indexers are enabled, so nothing can be downloaded.', fix: 'indexers' });
  }
  if (!clients.length) checks.push({ id: 'clients', group: 'Downloads', name: 'Download clients', level: 'warning', message: 'No download client is enabled.', fix: 'download-clients' });

  for (const [server, r] of Object.entries(deps.librarySync.status.results)) {
    if (r && !r.ok) checks.push({ id: `sync-${server}`, group: 'Connections', name: `Library sync (${server})`, level: 'warning', message: r.error ?? 'Last sync failed', fix: 'media-servers' });
  }

  const m = ctx.settings.get('media');
  checks.push(storageCheck('config', 'App data (/config)', deps.configDir, 'general'));
  checks.push(storageCheck('movies', 'Movies folder', m.moviesPath, 'media-management'));
  checks.push(storageCheck('tv', 'TV folder', m.tvPath, 'media-management'));
  checks.push(storageCheck('downloads', 'Downloads folder', m.downloadsPath, 'media-management'));
  if (abs || sm || ctx.db.select({ id: books.id }).from(books).limit(1).get()) {
    checks.push(storageCheck('audiobooks', 'Audiobooks folder', m.audiobooksPath, 'media-management'));
    checks.push(storageCheck('books', 'Books folder', m.booksPath, 'media-management'));
  }
  if (m.importMode === 'hardlink' && fs.existsSync(m.downloadsPath)) {
    const dev = fs.statSync(m.downloadsPath).dev;
    const split = [m.moviesPath, m.tvPath].filter((p) => fs.existsSync(p) && fs.statSync(p).dev !== dev);
    if (split.length) {
      checks.push({ id: 'hardlink', group: 'Storage', name: 'Hardlinks', level: 'warning', message: `${split.join(' and ')} ${split.length > 1 ? 'are' : 'is'} on a different disk from downloads, so imports will copy instead of hardlink and use double the space. Map one share (e.g. /mnt/user/data) into the container.`, fix: 'media-management' });
    }
  }

  const since = Date.now() - 7 * DAY;
  const failed = ctx.db.select().from(downloads).where(and(eq(downloads.status, 'failed'), gte(downloads.addedAt, since))).orderBy(desc(downloads.addedAt)).limit(50).all();
  checks.push(
    failed.length
      ? { id: 'failed-downloads', group: 'Downloads', name: 'Failed downloads', level: 'warning', message: `${failed.length} failed in the last 7 days` }
      : { id: 'failed-downloads', group: 'Downloads', name: 'Failed downloads', level: 'ok', message: 'None in the last 7 days' },
  );

  const b = ctx.settings.get('backup');
  const st = deps.backups.status;
  const newest = deps.backups.list()[0]?.createdAt ?? st.lastBackupAt;
  if (st.lastError) checks.push({ id: 'backup', group: 'Backups', name: 'Database backup', level: 'error', message: `Last backup failed: ${st.lastError}`, fix: 'backups' });
  else if (!newest) checks.push({ id: 'backup', group: 'Backups', name: 'Database backup', level: 'warning', message: 'No backups yet', fix: 'backups' });
  else if (b.scheduleEnabled && Date.now() - newest > 8 * DAY) checks.push({ id: 'backup', group: 'Backups', name: 'Database backup', level: 'warning', message: `Newest backup is ${Math.floor((Date.now() - newest) / DAY)} days old`, fix: 'backups' });
  else checks.push({ id: 'backup', group: 'Backups', name: 'Database backup', level: 'ok', message: `Newest backup ${new Date(newest).toLocaleString()}`, fix: 'backups' });
  if (b.remote.type !== 'none') {
    checks.push(
      st.lastRemoteError
        ? { id: 'remote-backup', group: 'Backups', name: 'Remote backup', level: 'error', message: st.lastRemoteError, fix: 'backups' }
        : { id: 'remote-backup', group: 'Backups', name: 'Remote backup', level: 'ok', message: st.lastRemoteAt ? `Last copied ${new Date(st.lastRemoteAt).toLocaleString()}` : 'Waiting for the next backup', fix: 'backups' },
    );
  }

  const level: HealthLevel = checks.some((c) => c.level === 'error') ? 'error' : checks.some((c) => c.level === 'warning') ? 'warning' : 'ok';
  return { checkedAt: Date.now(), level, checks, failedDownloads: failed.map((f) => ({ id: f.id, title: f.title, error: f.error, at: f.addedAt })) };
}
