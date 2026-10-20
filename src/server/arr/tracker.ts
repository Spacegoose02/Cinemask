import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { notify } from '../notify/service.js';
import type { AppContext } from '../context.js';
import { blocklist, downloadClients, downloads, monitored, type DownloadClientType } from '../db/schema.js';
import { JellyfinClient } from '../integrations/jellyfin.js';
import { createClient, type ClientItem } from './clients.js';
import { importDownload, mapRemotePath } from './importer.js';
import { deliverLink } from './direct.js';
import { autoSearch } from './search.js';
import { autoTrailer } from '../trailers/service.js';
import { failBook, importBook } from '../books/service.js';
import { openSecret } from './secrets.js';

const ACTIVE = ['queued', 'downloading', 'paused', 'completed', 'importing'] as const;

/** Speed and time left from the last poll, by download id. Only kept in memory; it changes every poll. */
export const liveStats = new Map<number, { speed: number | null; eta: number | null }>();

/** Asks Plex/Jellyfin to rescan after an import so new files show up quickly. Best effort. */
export async function refreshMediaServers(ctx: AppContext) {
  const plex = ctx.settings.get('plex');
  if (plex.enabled && plex.url && plex.token) {
    try {
      const base = plex.url.replace(/\/+$/, '');
      const res = await fetch(`${base}/library/sections`, { headers: { 'X-Plex-Token': plex.token, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      const body = (await res.json()) as { MediaContainer: { Directory?: { key: string; type: string }[] } };
      for (const d of body.MediaContainer.Directory ?? []) {
        if (d.type === 'movie' || d.type === 'show') {
          await fetch(`${base}/library/sections/${d.key}/refresh`, { headers: { 'X-Plex-Token': plex.token }, signal: AbortSignal.timeout(10_000) });
        }
      }
    } catch {
      // the next scheduled library sync catches up
    }
  }
  const jf = ctx.settings.get('jellyfin');
  if (jf.enabled && jf.url && jf.apiKey) {
    await new JellyfinClient(jf.url, jf.apiKey).refresh().catch(() => undefined);
  }
}

/** Polls download clients, updates progress, imports finished downloads and retries failed ones. */
export async function trackDownloads(ctx: AppContext): Promise<void> {
  const active = ctx.db.select().from(downloads).where(and(inArray(downloads.status, [...ACTIVE]), isNotNull(downloads.clientId))).all();
  for (const id of liveStats.keys()) if (!active.some((d) => d.id === id)) liveStats.delete(id);
  if (!active.length) return;
  const clientIds = [...new Set(active.map((d) => d.clientId!))];
  let imported = false;
  for (const cid of clientIds) {
    const c = ctx.db.select().from(downloadClients).where(eq(downloadClients.id, cid)).get();
    if (!c) continue;
    // Root folders can send downloads under their own category, so ask for each one in use.
    const categories = [...new Set(active.filter((x) => x.clientId === cid).map((x) => x.category ?? c.category))];
    const client = createClient({ type: c.type as DownloadClientType, name: c.name, url: c.url, username: c.username, password: openSecret(ctx, c.password) });
    let items: ClientItem[];
    try {
      const ids = active.filter((x) => x.clientId === cid && x.downloadId).map((x) => x.downloadId!);
      items = (await Promise.all(categories.map((cat, i) => client.list(cat, i === 0 ? ids : [])))).flat();
    } catch {
      continue; // client offline; try next time
    }
    for (const d of active.filter((x) => x.clientId === cid)) {
      const tag = `mm-${d.id}`;
      const item = items.find((i) => (d.downloadId && i.id.toLowerCase() === d.downloadId.toLowerCase()) || i.tags.includes(tag));
      if (!item) {
        // Removed in the client by hand before finishing.
        if (Date.now() - d.addedAt > 10 * 60 * 1000 && d.status !== 'completed') {
          ctx.db.update(downloads).set({ status: 'removed', error: 'No longer in the download client' }).where(eq(downloads.id, d.id)).run();
        } else if (d.status === 'completed' && d.monitoredId && Date.now() - (d.completedAt ?? d.addedAt) > 30 * 60 * 1000) {
          // Finished but never imported, and the client has dropped it: say so instead of waiting forever.
          ctx.db.update(downloads).set({ status: 'failed', error: `Finished but not imported, and ${c.name} no longer lists it. Import the files from Downloads → Import.` }).where(eq(downloads.id, d.id)).run();
        }
        continue;
      }
      if (!d.downloadId) ctx.db.update(downloads).set({ downloadId: item.id }).where(eq(downloads.id, d.id)).run();
      if (item.status === 'failed') {
        await failDownload(ctx, d.id, item.error ?? 'Download failed in the client');
        continue;
      }
      if (item.status !== 'completed') {
        ctx.db.update(downloads).set({ status: item.status, progress: item.progress }).where(eq(downloads.id, d.id)).run();
        liveStats.set(d.id, { speed: item.status === 'downloading' ? (item.speed ?? null) : 0, eta: item.eta ?? null });
        continue;
      }
      liveStats.delete(d.id);
      ctx.db.update(downloads).set({ status: 'importing', progress: 1, completedAt: d.completedAt ?? Date.now() }).where(eq(downloads.id, d.id)).run();
      if (d.bookId && item.outputPath) {
        try {
          importBook(ctx, d.bookId, mapRemotePath(ctx, item.outputPath));
          ctx.db.update(downloads).set({ status: 'imported', importedAt: Date.now(), outputPath: item.outputPath }).where(eq(downloads.id, d.id)).run();
        } catch (err) {
          ctx.db.update(downloads).set({ status: 'failed', error: (err as Error).message }).where(eq(downloads.id, d.id)).run();
          failBook(ctx, d.bookId, (err as Error).message);
        }
        continue;
      }
      if (!d.monitoredId && !d.bookId && d.destination && item.outputPath) {
        deliverLink(ctx, d.id, mapRemotePath(ctx, item.outputPath), ctx.settings.get('media').importMode);
        const media = ctx.settings.get('media');
        // Only once it's safely in its folder: left in the downloads folder, or not delivered, the client's copy is the only one.
        const delivered = ctx.db.select({ status: downloads.status }).from(downloads).where(eq(downloads.id, d.id)).get()?.status === 'imported';
        if (delivered && media.removeCompletedDownloads) await client.remove(item.id, media.importMode !== 'hardlink').catch(() => undefined);
        continue;
      }
      if (!d.monitoredId || !item.outputPath) {
        // A client that never says where it saved a finished download would leave it here forever.
        const stuck = d.monitoredId && Date.now() - (d.completedAt ?? Date.now()) > 30 * 60 * 1000;
        ctx.db
          .update(downloads)
          .set(stuck ? { status: 'failed', error: `${c.name} finished it but didn't say where the files are. Import them from Downloads → Import.` } : { status: 'completed' })
          .where(eq(downloads.id, d.id))
          .run();
        continue;
      }
      try {
        const r = importDownload(ctx, d.id, item.outputPath);
        if (r.imported.length) {
          imported = true;
          const row = ctx.db.select().from(monitored).where(eq(monitored.id, d.monitoredId)).get();
          if (row) void autoTrailer(ctx, row).catch(() => undefined);
          if (ctx.settings.get('media').removeCompletedDownloads) {
            // With hardlinks the library copy survives; with copy/move the client data is no longer needed.
            await client.remove(item.id, ctx.settings.get('media').importMode !== 'hardlink').catch(() => undefined);
          }
        }
      } catch (err) {
        ctx.db.update(downloads).set({ status: 'failed', error: (err as Error).message }).where(eq(downloads.id, d.id)).run();
      }
    }
  }
  if (imported) await refreshMediaServers(ctx);
}

/** Marks a download failed, blocklists the release, and looks for another one. */
export async function failDownload(ctx: AppContext, id: number, reason: string, retry = true) {
  const d = ctx.db.select().from(downloads).where(eq(downloads.id, id)).get();
  if (!d) return;
  ctx.db.update(downloads).set({ status: 'failed', error: reason }).where(eq(downloads.id, id)).run();
  notify(ctx, { event: 'download.failed', title: 'Download failed', message: `${d.title}: ${reason}`, data: { downloadId: id } });
  if (d.bookId) failBook(ctx, d.bookId, reason);
  if (!d.monitoredId) return;
  ctx.db.insert(blocklist).values({ monitoredId: d.monitoredId, releaseTitle: d.title, indexer: d.indexer, reason, createdAt: Date.now() }).run();
  const row = ctx.db.select().from(monitored).where(eq(monitored.id, d.monitoredId)).get();
  if (row && retry) {
    const ep = d.episodes ? (JSON.parse(d.episodes) as { season: number; episodes: number[] }) : null;
    await autoSearch(ctx, row, ep ? { season: ep.season } : undefined).catch(() => 0);
  }
}
