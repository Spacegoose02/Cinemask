import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { blocklist, downloadClients, downloads, monitored, type DownloadClientType } from '../db/schema.js';
import { JellyfinClient } from '../integrations/jellyfin.js';
import { createClient, type ClientItem } from './clients.js';
import { importDownload } from './importer.js';
import { autoSearch } from './search.js';
import { autoTrailer } from '../trailers/service.js';
import { openSecret } from './secrets.js';

const ACTIVE = ['queued', 'downloading', 'paused', 'completed', 'importing'] as const;

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
  if (!active.length) return;
  const clientIds = [...new Set(active.map((d) => d.clientId!))];
  let imported = false;
  for (const cid of clientIds) {
    const c = ctx.db.select().from(downloadClients).where(eq(downloadClients.id, cid)).get();
    if (!c) continue;
    let items: ClientItem[];
    try {
      items = await createClient({ type: c.type as DownloadClientType, name: c.name, url: c.url, username: c.username, password: openSecret(ctx, c.password) }).list(c.category);
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
        continue;
      }
      ctx.db.update(downloads).set({ status: 'importing', progress: 1, completedAt: d.completedAt ?? Date.now() }).where(eq(downloads.id, d.id)).run();
      if (!d.monitoredId || !item.outputPath) {
        ctx.db.update(downloads).set({ status: 'completed' }).where(eq(downloads.id, d.id)).run();
        continue;
      }
      try {
        const r = importDownload(ctx, d.id, item.outputPath);
        if (r.imported.length) {
          imported = true;
          const row = ctx.db.select().from(monitored).where(eq(monitored.id, d.monitoredId)).get();
          if (row) void autoTrailer(ctx, row).catch(() => undefined);
          if (ctx.settings.get('media').removeCompletedDownloads) {
            const client = createClient({ type: c.type as DownloadClientType, name: c.name, url: c.url, username: c.username, password: openSecret(ctx, c.password) });
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
  if (!d.monitoredId) return;
  ctx.db.insert(blocklist).values({ monitoredId: d.monitoredId, releaseTitle: d.title, indexer: d.indexer, reason, createdAt: Date.now() }).run();
  const row = ctx.db.select().from(monitored).where(eq(monitored.id, d.monitoredId)).get();
  if (row && retry) {
    const ep = d.episodes ? (JSON.parse(d.episodes) as { season: number; episodes: number[] }) : null;
    await autoSearch(ctx, row, ep ? { season: ep.season } : undefined).catch(() => 0);
  }
}
