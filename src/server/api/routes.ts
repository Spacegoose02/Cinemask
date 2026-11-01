import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { audit } from '../audit/log.js';
import { hasRole } from '../auth/guard.js';
import { books, downloads, libraryItems, monitored, requests } from '../db/schema.js';
import { calendar } from '../calendar/service.js';
import { z } from 'zod';
import { cleanError, configuredChannels, sendTo, SHARED_CHANNELS } from '../notify/channels.js';
import { parse } from '../lib/validate.js';

const CHANNEL_NAMES = { webhook: 'the webhook', discord: 'Discord', telegram: 'Telegram', ntfy: 'ntfy', gotify: 'Gotify', pushover: 'Pushover' } as const;
import { badRequest } from '../lib/errors.js';
import { buildOpenApi } from './openapi.js';
import { localDay } from '../lib/dates.js';

const DAY = 24 * 60 * 60 * 1000;

/** The API description, a stats feed for dashboards and Home Assistant, and the webhook test. */
export async function apiRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  let spec: ReturnType<typeof buildOpenApi> | null = null;

  app.get('/api/openapi.json', { config: { access: 'user' } }, async () => (spec ??= buildOpenApi(app, ctx.config.version)));

  app.get('/api/stats', { config: { access: 'user' } }, async (req) => {
    const count = (rows: { n: number }[]) => rows[0]?.n ?? 0;
    const n = sql<number>`count(*)`;
    const distinctTitles = (kind: 'movie' | 'show') =>
      count(ctx.db.select({ n: sql<number>`count(distinct coalesce(${libraryItems.tmdbId}, ${libraryItems.title}))` }).from(libraryItems).where(eq(libraryItems.kind, kind)).all());
    const reqCount = (status: 'pending' | 'approved' | 'available') => count(ctx.db.select({ n }).from(requests).where(eq(requests.status, status)).all());
    const today = localDay();
    const week = localDay(Date.now() + 7 * DAY);
    const upcoming = calendar(ctx, today, week);
    const isAdmin = hasRole(req.user!.role, 'admin');
    const summary = isAdmin ? app.healthSummary() : null;
    return {
      library: { movies: distinctTitles('movie'), shows: distinctTitles('show') },
      monitored: count(ctx.db.select({ n }).from(monitored).all()),
      requests: { pending: reqCount('pending'), approved: reqCount('approved'), available: reqCount('available') },
      books: { pending: count(ctx.db.select({ n }).from(books).where(eq(books.status, 'pending')).all()), downloading: count(ctx.db.select({ n }).from(books).where(eq(books.status, 'downloading')).all()) },
      downloads: {
        active: count(ctx.db.select({ n }).from(downloads).where(inArray(downloads.status, ['queued', 'downloading', 'paused', 'completed', 'importing'])).all()),
        failed24h: count(ctx.db.select({ n }).from(downloads).where(and(eq(downloads.status, 'failed'), gte(downloads.addedAt, Date.now() - DAY))).all()),
      },
      upcoming: { today: upcoming.filter((e) => e.date === today).length, week: upcoming.length },
      // Health is an admin concern; other users get null.
      health: summary,
    };
  });

  /** Sends a test to one shared channel (the webhook unless another is named), with what's saved now. */
  app.post('/api/notifications/test', { config: { access: 'admin' } }, async (req) => {
    const { channel } = parse(z.object({ channel: z.enum(SHARED_CHANNELS).default('webhook') }), req.body ?? {});
    const s = ctx.settings.get('notifications');
    if (!configuredChannels(s).includes(channel)) throw badRequest(channel === 'webhook' ? 'Save a webhook URL first' : `Fill in and save the ${CHANNEL_NAMES[channel]} settings first`);
    try {
      await sendTo(ctx, channel, s, { event: 'health.problem', title: 'Test from Cinemask', message: `If you can read this, ${channel === 'webhook' ? 'the webhook' : CHANNEL_NAMES[channel]} works.`, data: { test: true }, url: '/' });
    } catch (err) {
      return { ok: false, message: cleanError(err).replace(/^It timed out$/, `The ${channel === 'webhook' ? 'webhook' : CHANNEL_NAMES[channel]} timed out`) };
    }
    audit(ctx.db, req, 'notifications.tested', { target: channel });
    return { ok: true, message: channel === 'webhook' ? 'Sent a test event' : `Sent a test to ${CHANNEL_NAMES[channel]}` };
  });
}
