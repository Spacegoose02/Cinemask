import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { authStates, users } from '../db/schema.js';
import { pollDeviceLink, startDeviceLink, traktConfigured } from '../integrations/trakt.js';
import { randomToken, sha256 } from '../security/crypto.js';
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
    if (sync && !src.plex && !src.jellyfin && !src.trakt) throw badRequest('Link Plex or Trakt on your profile first, or ask an admin to link your Jellyfin account.');
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

  // ---- Trakt: link with a device code, unlink
  app.get('/api/trakt/me', { config: { access: 'user' } }, async (req) => ({ configured: traktConfigured(ctx), linked: Boolean(me(req.user!.id).traktToken), username: me(req.user!.id).traktUser }));

  app.post('/api/trakt/link', { config: { access: 'user', rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const code = await upstream(() => startDeviceLink(ctx));
    // The device code stays on the server; the browser polls with a token for it.
    const token = randomToken(24);
    ctx.db.insert(authStates).values({ state: sha256(token), kind: 'trakt', data: JSON.stringify({ userId: req.user!.id, deviceCode: code.device_code }), expiresAt: Date.now() + code.expires_in * 1000 }).run();
    return { token, userCode: code.user_code, url: code.verification_url, interval: code.interval, expiresIn: code.expires_in };
  });

  app.post('/api/trakt/link/poll', { config: { access: 'user', rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { token } = parse(z.object({ token: z.string().max(100) }), req.body);
    const row = ctx.db.select().from(authStates).where(and(eq(authStates.state, sha256(token)), eq(authStates.kind, 'trakt'))).get();
    const data = row ? (JSON.parse(row.data) as { userId: number; deviceCode: string }) : null;
    if (!row || !data || data.userId !== req.user!.id || row.expiresAt < Date.now()) return { status: 'expired' };
    const status = await upstream(() => pollDeviceLink(ctx, req.user!.id, data.deviceCode));
    if (status !== 'pending' && status !== 'slow_down') ctx.db.delete(authStates).where(eq(authStates.state, row.state)).run();
    if (status === 'linked') audit(ctx.db, req, 'trakt.linked', { target: me(req.user!.id).traktUser ?? undefined });
    return { status, username: me(req.user!.id).traktUser };
  });

  app.delete('/api/trakt/link', { config: { access: 'user' } }, async (req) => {
    ctx.db.update(users).set({ traktToken: null, traktUser: null }).where(eq(users.id, req.user!.id)).run();
    audit(ctx.db, req, 'trakt.unlinked');
    return { ok: true };
  });

  /** Jellyfin's accounts, for linking one to a Cinemask user on Settings → Users. */
  app.get('/api/watchlist/jellyfin-users', { config: { access: 'admin' } }, async () => {
    const jf = ctx.settings.get('jellyfin');
    if (!jf.enabled || !jf.url || !jf.apiKey) return { users: [] };
    return { users: await upstream(() => new JellyfinClient(jf.url, jf.apiKey).users()) };
  });
}
