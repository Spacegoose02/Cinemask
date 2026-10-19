import { and, asc, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { collectionItems, collections, libraryItems, listItems, monitored, type MediaKind, type ServerType } from '../db/schema.js';
import { JellyfinClient } from '../integrations/jellyfin.js';
import { PlexClient } from '../integrations/plex.js';
import { TMDB_IMAGE } from '../integrations/tmdb.js';
import { availabilityFor, tmdbClient } from '../library/service.js';
import type { ListItem } from '../lists/service.js';
import { monitorTitle } from '../arr/monitor.js';
import { defaultProfileId } from '../arr/profiles.js';
import { autoSearch } from '../arr/search.js';

export type CollectionRow = typeof collections.$inferSelect;

export function plexClient(ctx: AppContext): PlexClient | null {
  const s = ctx.settings.get('plex');
  return s.enabled && s.url && s.token ? new PlexClient(s.url, s.token) : null;
}

export function jellyfinClient(ctx: AppContext): JellyfinClient | null {
  const s = ctx.settings.get('jellyfin');
  return s.enabled && s.url && s.apiKey ? new JellyfinClient(s.url, s.apiKey) : null;
}

/** A poster a media server can download: TMDB paths become full URLs; server-local images can't be pushed. */
export function pushablePosterUrl(poster: string | null): string | null {
  if (!poster) return null;
  if (poster.startsWith('/')) return `${TMDB_IMAGE}/original${poster}`;
  if (poster.startsWith('https://')) return poster;
  return null;
}

export function itemsOf(ctx: AppContext, id: number): ListItem[] {
  return ctx.db
    .select({ kind: collectionItems.kind, tmdbId: collectionItems.tmdbId, title: collectionItems.title, year: collectionItems.year, posterPath: collectionItems.posterPath })
    .from(collectionItems)
    .where(eq(collectionItems.collectionId, id))
    .orderBy(asc(collectionItems.position))
    .all();
}

export function setItems(ctx: AppContext, id: number, items: ListItem[]) {
  ctx.db.transaction((tx) => {
    tx.delete(collectionItems).where(eq(collectionItems.collectionId, id)).run();
    items.forEach((i, position) => tx.insert(collectionItems).values({ collectionId: id, ...i, position }).onConflictDoNothing().run());
  });
}

/** Server keys (Plex ratingKey / Jellyfin Id) for collection items that are on that server. */
function serverKeys(ctx: AppContext, server: ServerType, items: ListItem[]): Map<string, MediaKind> {
  const out = new Map<string, MediaKind>();
  for (const kind of ['movie', 'show'] as const) {
    const ids = items.filter((i) => i.kind === kind).map((i) => i.tmdbId);
    if (!ids.length) continue;
    for (const r of ctx.db.select({ key: libraryItems.externalKey }).from(libraryItems).where(and(eq(libraryItems.server, server), eq(libraryItems.kind, kind), inArray(libraryItems.tmdbId, ids))).all()) {
      out.set(r.key, kind);
    }
  }
  return out;
}

export interface PushResult {
  added: number;
  removed: number;
  notOnServer: number;
}

/**
 * Makes the Plex and/or Jellyfin collection match this one: adds missing items, removes
 * extras, renames it and sets its poster. Items not on a server are counted, not created.
 */
export async function pushCollection(ctx: AppContext, id: number): Promise<{ plex?: PushResult; jellyfin?: PushResult }> {
  const col = ctx.db.select().from(collections).where(eq(collections.id, id)).get();
  if (!col) throw new Error('Collection not found');
  const items = itemsOf(ctx, id);
  const result: { plex?: PushResult; jellyfin?: PushResult } = {};
  const errors: string[] = [];
  const poster = pushablePosterUrl(col.poster);

  if (col.syncPlex) {
    try {
      const plex = plexClient(ctx);
      if (!plex) throw new Error('Plex is not connected');
      const wanted = serverKeys(ctx, 'plex', items);
      const existing = (await plex.collections()).find((c) => (col.plexKey ? c.ratingKey === col.plexKey : c.title === col.name));
      const current = existing ? new Set(await plex.collectionChildren(existing.ratingKey)) : new Set<string>();
      // Plex collections are tags: tag under the collection's current name on the server.
      const tagName = existing?.title ?? col.name;
      const r: PushResult = { added: 0, removed: 0, notOnServer: items.length - wanted.size };
      for (const [key, kind] of wanted) {
        if (current.has(key)) continue;
        await plex.setCollectionTag(await plex.sectionOf(key), kind, key, tagName);
        r.added++;
      }
      for (const key of current) {
        if (wanted.has(key)) continue;
        const kind = ctx.db.select({ kind: libraryItems.kind }).from(libraryItems).where(and(eq(libraryItems.server, 'plex'), eq(libraryItems.externalKey, key))).get()?.kind ?? 'movie';
        await plex.setCollectionTag(await plex.sectionOf(key), kind, key, tagName, true);
        r.removed++;
      }
      const after = (await plex.collections()).find((c) => (existing ? c.ratingKey === existing.ratingKey : c.title === col.name));
      if (after) {
        if (after.title !== col.name) await plex.renameCollection(after.section, after.ratingKey, col.name);
        if (poster) await plex.setPosterUrl(after.ratingKey, poster);
        ctx.db.update(collections).set({ plexKey: after.ratingKey }).where(eq(collections.id, id)).run();
      }
      result.plex = r;
    } catch (err) {
      errors.push(`Plex: ${(err as Error).message}`);
    }
  }

  if (col.syncJellyfin) {
    try {
      const jf = jellyfinClient(ctx);
      if (!jf) throw new Error('Jellyfin is not connected');
      const wanted = [...serverKeys(ctx, 'jellyfin', items).keys()];
      const r: PushResult = { added: 0, removed: 0, notOnServer: items.length - wanted.length };
      let jfId = col.jellyfinId;
      if (jfId && !(await jf.boxSets()).some((b) => b.Id === jfId)) jfId = null; // deleted on the server
      if (!jfId) {
        if (!wanted.length) throw new Error('None of the items are on Jellyfin yet');
        jfId = await jf.createCollection(col.name, wanted);
        r.added = wanted.length;
      } else {
        const current = new Set(await jf.collectionItems(jfId));
        const add = wanted.filter((k) => !current.has(k));
        const remove = [...current].filter((k) => !wanted.includes(k));
        await jf.addToCollection(jfId, add);
        await jf.removeFromCollection(jfId, remove);
        r.added = add.length;
        r.removed = remove.length;
        const box = (await jf.boxSets()).find((b) => b.Id === jfId);
        if (box && box.Name !== col.name) await jf.renameItem(jfId, col.name);
      }
      if (poster) await jf.setPosterUrl(jfId, poster);
      ctx.db.update(collections).set({ jellyfinId: jfId }).where(eq(collections.id, id)).run();
      result.jellyfin = r;
    } catch (err) {
      errors.push(`Jellyfin: ${(err as Error).message}`);
    }
  }

  ctx.db.update(collections).set({ lastPushAt: Date.now(), lastError: errors.length ? errors.join('; ') : null }).where(eq(collections.id, id)).run();
  if (errors.length && !result.plex && !result.jellyfin) throw new Error(errors.join('; '));
  return result;
}

/** Copies the collections that already exist on Plex or Jellyfin into the app (matching items by TMDB id). */
export async function importServerCollections(ctx: AppContext, server: ServerType, userId: number): Promise<{ imported: number; updated: number }> {
  const byKey = (key: string) => ctx.db.select().from(libraryItems).where(and(eq(libraryItems.server, server), eq(libraryItems.externalKey, key))).get();
  const toItems = (keys: string[]) =>
    keys
      .map(byKey)
      .filter((r): r is NonNullable<typeof r> => Boolean(r?.tmdbId))
      .map((r) => ({ kind: r.kind, tmdbId: r.tmdbId!, title: r.title, year: r.year, posterPath: null }));
  let imported = 0;
  let updated = 0;
  const upsert = (sourceId: string, name: string, description: string | null, poster: string | null, items: ListItem[]) => {
    const existing = ctx.db.select().from(collections).where(and(eq(collections.source, server), eq(collections.sourceId, sourceId))).get();
    const values = { name, description, poster, ...(server === 'plex' ? { plexKey: sourceId, syncPlex: true } : { jellyfinId: sourceId, syncJellyfin: true }) };
    const id = existing
      ? ctx.db.update(collections).set(values).where(eq(collections.id, existing.id)).returning().get().id
      : ctx.db.insert(collections).values({ ...values, source: server, sourceId, createdBy: userId, createdAt: Date.now() }).returning().get().id;
    if (existing) updated++;
    else imported++;
    setItems(ctx, id, items);
  };
  if (server === 'plex') {
    const plex = plexClient(ctx);
    if (!plex) throw new Error('Plex is not connected');
    for (const c of await plex.collections()) upsert(c.ratingKey, c.title, c.summary ?? null, c.thumb ? `plex:${c.thumb}` : null, toItems(await plex.collectionChildren(c.ratingKey)));
  } else {
    const jf = jellyfinClient(ctx);
    if (!jf) throw new Error('Jellyfin is not connected');
    for (const b of await jf.boxSets()) upsert(b.Id, b.Name, b.Overview ?? null, `jellyfin:/Items/${b.Id}/Images/Primary`, toItems(await jf.collectionItems(b.Id)));
  }
  return { imported, updated };
}

/** Rebuilds the items of collections that follow a TMDB collection or one of the app's lists. */
export async function refreshCollectionItems(ctx: AppContext, id: number): Promise<number> {
  const col = ctx.db.select().from(collections).where(eq(collections.id, id)).get();
  if (!col) throw new Error('Collection not found');
  if (col.source === 'tmdb') {
    const c = await tmdbClient(ctx).collection(Number(col.sourceId));
    const parts = [...c.parts].sort((a, b) => (a.release_date ?? '9999').localeCompare(b.release_date ?? '9999'));
    setItems(ctx, id, parts.map((p) => ({ kind: 'movie', tmdbId: p.id, title: p.title ?? '', year: p.release_date ? Number(p.release_date.slice(0, 4)) : null, posterPath: p.poster_path ?? null })));
    if (!col.poster && c.poster_path) ctx.db.update(collections).set({ poster: c.poster_path }).where(eq(collections.id, id)).run();
  } else if (col.source === 'list') {
    const rows = ctx.db.select().from(listItems).where(eq(listItems.listId, Number(col.sourceId))).orderBy(asc(listItems.position)).all();
    setItems(ctx, id, rows);
  }
  return itemsOf(ctx, id).length;
}

/** Keeps followed collections current and pushes ones that sync to a server. Run daily. */
export async function syncCollections(ctx: AppContext): Promise<void> {
  for (const c of ctx.db.select().from(collections).all()) {
    try {
      if (c.source === 'tmdb' || c.source === 'list') await refreshCollectionItems(ctx, c.id);
      if (c.syncPlex || c.syncJellyfin) await pushCollection(ctx, c.id);
    } catch {
      // recorded in last_error by pushCollection; try again tomorrow
    }
  }
}

/** Starts downloading the collection's items that aren't on the server or already monitored. */
export async function downloadMissing(ctx: AppContext, id: number, userId: number): Promise<number> {
  let added = 0;
  const items = itemsOf(ctx, id);
  for (const kind of ['movie', 'show'] as const) {
    const ofKind = items.filter((i) => i.kind === kind);
    const avail = availabilityFor(ctx, kind, ofKind);
    for (const i of ofKind) {
      if (avail.get(i.tmdbId)?.status !== 'not_on_server') continue;
      if (ctx.db.select({ id: monitored.id }).from(monitored).where(and(eq(monitored.kind, kind), eq(monitored.tmdbId, i.tmdbId))).get()) continue;
      const row = await monitorTitle(ctx, { kind, tmdbId: i.tmdbId, profileId: defaultProfileId(ctx, kind), seasons: null, addedBy: userId });
      void autoSearch(ctx, row).catch(() => 0);
      added++;
    }
  }
  return added;
}
