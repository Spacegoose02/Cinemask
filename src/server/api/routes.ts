import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { audit } from '../audit/log.js';
import { hasRole } from '../auth/guard.js';
import { books, downloads, libraryItems, monitored, requests } from '../db/schema.js';
import { calendar } from '../calendar/service.js';
import { sendWebhook } from '../notify/service.js';
import { badRequest } from '../lib/errors.js';
import { buildOpenApi } from './openapi.js';

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
    const today = new Date().toISOString().slice(0, 10);
    const week = new Date(Date.now() + 7 * DAY).toISOString().slice(0, 10);
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

  app.post('/api/notifications/test', { config: { access: 'admin' } }, async (req) => {
    const s = ctx.settings.get('notifications');
    if (!s.webhookUrl) throw badRequest('Save a webhook URL first');
    try {
      await sendWebhook(s.webhookUrl, { event: 'health.problem', title: 'Test from Cinemask', message: 'If you can read this, the webhook works.', data: { test: true } });
    } catch (err) {
      return { ok: false, message: (err as Error).name === 'TimeoutError' ? 'The webhook timed out' : (err as Error).message.replace(/https?:\/\/\S+/g, '(webhook)') };
    }
    audit(ctx.db, req, 'notifications.tested');
    return { ok: true, message: 'Sent a test event' };
  });
}
