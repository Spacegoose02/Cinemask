import { and, desc, eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { users, watchlistItems, type MediaKind } from '../db/schema.js';
import { toSessionUser } from '../auth/sessions.js';
import { plexHeadersFor } from '../auth/plex.js';
import { JellyfinClient } from '../integrations/jellyfin.js';
import * as plextv from '../integrations/plextv.js';
import { HttpError } from '../lib/errors.js';
import { openSecret } from '../arr/secrets.js';
import { submitRequest } from '../requests/submit.js';

/**
 * Watchlist sync: what someone adds to their Plex watchlist or marks as a favourite in Jellyfin
 * becomes a request, under the same rules as the request button (approval, limits, kids profiles).
 * Each title is only tried once per source, except when a request limit stopped it.
 */

/** New requests one sync may make for one person, so a long watchlist doesn't arrive all at once. */
const PER_RUN = 25;

type Source = 'plex' | 'jellyfin';
interface Entry {
  source: Source;
  kind: MediaKind;
  title: string;
  tmdbId: number | null;
}

/** Where a user's watchlist can come from. */
export function sourcesOf(ctx: AppContext, u: typeof users.$inferSelect): { plex: boolean; jellyfin: boolean } {
  const jf = ctx.settings.get('jellyfin');
  return { plex: Boolean(u.plexToken), jellyfin: Boolean(u.jellyfinUserId && jf.enabled && jf.url && jf.apiKey) };
}

async function entriesOf(ctx: AppContext, u: typeof users.$inferSelect): Promise<{ entries: Entry[]; errors: string[] }> {
  const entries: Entry[] = [];
  const errors: string[] = [];
  const src = sourcesOf(ctx, u);
  if (src.plex) {
    try {
      for (const e of await plextv.getWatchlist(plexHeadersFor(ctx), openSecret(ctx, u.plexToken))) entries.push({ source: 'plex', ...e });
    } catch (err) {
      errors.push(/401/.test((err as Error).message) ? 'Plex: sign in with Plex again to keep your watchlist in sync' : `Plex: ${(err as Error).message}`);
    }
  }
  if (src.jellyfin) {
    const jf = ctx.settings.get('jellyfin');
    try {
      for (const e of await new JellyfinClient(jf.url, jf.apiKey).favorites(u.jellyfinUserId!)) entries.push({ source: 'jellyfin', ...e });
    } catch (err) {
      errors.push(`Jellyfin: ${(err as Error).message}`);
    }
  }
  return { entries, errors };
}

export interface SyncResult {
  checked: number;
  requested: number;
  error: string | null;
}

/** Turns one user's new watchlist titles into requests. */
export async function syncWatchlist(ctx: AppContext, userId: number): Promise<SyncResult> {
  const u = ctx.db.select().from(users).where(eq(users.id, userId)).get();
  if (!u || u.disabled || !u.watchlistSync) return { checked: 0, requested: 0, error: null };
  const { entries, errors } = await entriesOf(ctx, u);
  const seen = new Set(
    ctx.db
      .select()
      .from(watchlistItems)
      .where(eq(watchlistItems.userId, userId))
      .all()
      .map((w) => `${w.source}:${w.kind}:${w.tmdbId}`),
  );
  const user = toSessionUser(u);
  let requested = 0;
  for (const e of entries) {
    if (e.tmdbId === null || seen.has(`${e.source}:${e.kind}:${e.tmdbId}`)) continue;
    // The same title on both Plex and Jellyfin only needs asking once.
    seen.add(`${e.source}:${e.kind}:${e.tmdbId}`);
    if (requested >= PER_RUN) break;
    let result: string;
    try {
      const r = await submitRequest(ctx, user, { kind: e.kind, tmdbId: e.tmdbId, via: 'watchlist' }, null);
      result = 'following' in r && r.following ? 'following' : r.status === 'approved' ? 'approved' : 'requested';
      requested++;
    } catch (err) {
      // Over the request limit: try again next time, when there may be room.
      if (err instanceof HttpError && err.statusCode === 429) continue;
      result = err instanceof HttpError && err.statusCode === 409 && /already on the server/i.test(err.message) ? 'on_server' : (err as Error).message.slice(0, 200);
    }
    ctx.db.insert(watchlistItems).values({ userId, source: e.source, kind: e.kind, tmdbId: e.tmdbId, title: e.title, result, createdAt: Date.now() }).onConflictDoNothing().run();
  }
  const error = errors.length ? errors.join('. ') : null;
  ctx.db.update(users).set({ watchlistSyncedAt: Date.now(), watchlistError: error }).where(eq(users.id, userId)).run();
  if (requested) ctx.live.publish({ topic: 'requests', access: 'user' });
  return { checked: entries.length, requested, error };
}

/** Background job: everyone who turned watchlist sync on. */
export async function syncAllWatchlists(ctx: AppContext): Promise<number> {
  const ids = ctx.db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.watchlistSync, true), eq(users.disabled, false)))
    .all();
  let n = 0;
  for (const { id } of ids) n += (await syncWatchlist(ctx, id).catch(() => ({ requested: 0 }))).requested;
  return n;
}

export function recentItems(ctx: AppContext, userId: number) {
  return ctx.db.select().from(watchlistItems).where(eq(watchlistItems.userId, userId)).orderBy(desc(watchlistItems.createdAt)).limit(50).all();
}
