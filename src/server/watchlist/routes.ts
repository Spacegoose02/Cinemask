import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { users } from '../db/schema.js';
import { JellyfinClient } from '../integrations/jellyfin.js';
import { badRequest } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { upstream } from '../library/routes.js';
import { recentItems, sourcesOf, syncWatchlist } from './service.js';

export async function watchlistRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const me = (id: number) => ctx.db.select().from(users).where(eq(users.id, id)).get()!;
  const view = (id: number) => {
    const u = me(id);
    return { sync: u.watchlistSync, sources: sourcesOf(ctx, u), syncedAt: u.watchlistSyncedAt, error: u.watchlistError, items: recentItems(ctx, id) };
  };

  /** The signed-in user's watchlist sync: on or off, where it reads from, and what it requested. */
  app.get('/api/watchlist/me', { config: { access: 'user' } }, async (req) => view(req.user!.id));

  app.put('/api/watchlist/me', { config: { access: 'user' } }, async (req) => {
    const { sync } = parse(z.object({ sync: z.boolean() }), req.body);
    const u = me(req.user!.id);
    const src = sourcesOf(ctx, u);
    if (sync && !src.plex && !src.jellyfin) throw badRequest('Sign in with Plex (or link Plex on your profile) first, or ask an admin to link your Jellyfin account.');
    ctx.db.update(users).set({ watchlistSync: sync }).where(eq(users.id, u.id)).run();
    audit(ctx.db, req, sync ? 'watchlist.sync_on' : 'watchlist.sync_off');
    if (sync) void syncWatchlist(ctx, u.id).catch(() => undefined);
    return view(u.id);
  });

  app.post('/api/watchlist/me/sync', { config: { access: 'user', rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    if (!me(req.user!.id).watchlistSync) throw badRequest('Turn watchlist sync on first');
    const r = await syncWatchlist(ctx, req.user!.id);
    return { ...r, ...view(req.user!.id) };
  });

  /** Jellyfin's accounts, for linking one to a Cinemask user on Settings → Users. */
  app.get('/api/watchlist/jellyfin-users', { config: { access: 'admin' } }, async () => {
    const jf = ctx.settings.get('jellyfin');
    if (!jf.enabled || !jf.url || !jf.apiKey) return { users: [] };
    return { users: await upstream(() => new JellyfinClient(jf.url, jf.apiKey).users()) };
  });
}
