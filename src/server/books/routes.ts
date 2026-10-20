import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { notify } from '../notify/service.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { hasRole } from '../auth/guard.js';
import { absItems, BOOK_FORMATS, BOOK_STATUSES, books } from '../db/schema.js';
import { lookupPodcast, searchPodcasts, topPodcasts } from '../integrations/itunes.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { absClient, absMatch, annotate, getBook, openLibrary, startBookDownload, syncAudiobookshelf } from './service.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const workKey = z.string().regex(/^\/works\/OL\d+W$/, 'Not an Open Library work');
const upstream = (err: unknown) => (err instanceof HttpError ? err : new HttpError(502, (err as Error).message, 'upstream'));

export async function bookRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const region = () => ctx.settings.get('metadata').region;

  // ---------------- Discovery (Open Library) ----------------
  app.get('/api/books/search', { config: { access: 'user' } }, async (req) => {
    const q = parse(z.object({ q: z.string().trim().min(1).max(200), page: z.coerce.number().int().min(1).max(50).default(1) }), req.query);
    try {
      const r = await openLibrary(ctx).search(q.q, q.page);
      return { total: r.total, results: annotate(ctx, r.works) };
    } catch (err) {
      throw upstream(err);
    }
  });

  app.get('/api/books/trending', { config: { access: 'user' } }, async () => {
    try {
      return annotate(ctx, await openLibrary(ctx).trending());
    } catch (err) {
      throw upstream(err);
    }
  });

  // ---------------- Requests ----------------
  app.get('/api/books', { config: { access: 'user' } }, async (req) => {
    const q = parse(z.object({ status: z.enum([...BOOK_STATUSES, 'all']).default('all'), mine: z.coerce.boolean().default(false) }), req.query);
    const onlyMine = q.mine || !hasRole(req.user!.role, 'manager');
    return ctx.db
      .select()
      .from(books)
      .where(and(q.status === 'all' ? undefined : eq(books.status, q.status), onlyMine ? eq(books.requestedBy, req.user!.id) : undefined))
      .orderBy(desc(books.createdAt))
      .limit(500)
      .all();
  });

  const approve = async (id: number, deciderName: string, deciderId: number) => {
    ctx.db.update(books).set({ status: 'approved', decidedByName: deciderName, decidedAt: Date.now() }).where(eq(books.id, id)).run();
    void startBookDownload(ctx, id, deciderId).catch((err) => app.log.warn({ err }, 'Book download failed to start'));
  };

  /** Requests an audiobook or ebook. The title and author come from Open Library, not the browser. */
  app.post('/api/books', { config: { access: 'user' } }, async (req) => {
    const body = parse(z.object({ workKey, format: z.enum(BOOK_FORMATS) }), req.body);
    const open = ctx.db.select().from(books).where(and(eq(books.workKey, body.workKey), eq(books.format, body.format))).get();
    if (open && open.status !== 'declined' && open.status !== 'failed') return open;
    let work;
    try {
      work = await openLibrary(ctx).work(body.workKey);
    } catch (err) {
      throw upstream(err);
    }
    if (!work) throw badRequest('Could not find that book on Open Library');
    if (body.format === 'audiobook' && absMatch(ctx, work)) throw conflict('This audiobook is already in Audiobookshelf');
    const values = {
      title: work.title.slice(0, 500),
      author: work.author?.slice(0, 300) ?? null,
      year: work.year,
      coverId: work.coverId,
      isbn: work.isbn,
      status: 'pending' as const,
      requestedBy: req.user!.id,
      requestedByName: req.user!.displayName || req.user!.username,
      decidedByName: null,
      decidedAt: null,
      reason: null,
      error: null,
      externalId: null,
      createdAt: Date.now(),
    };
    const row = open
      ? ctx.db.update(books).set(values).where(eq(books.id, open.id)).returning().get()
      : ctx.db.insert(books).values({ workKey: body.workKey, format: body.format, ...values }).returning().get();
    audit(ctx.db, req, 'book.requested', { target: `${row.title} (${row.format})` });
    notify(ctx, { event: 'request.created', title: 'New book request', message: `${values.requestedByName} requested the ${row.format} of ${row.title}`, data: { kind: row.format, workKey: row.workKey, bookId: row.id } });
    if (hasRole(req.user!.role, 'manager')) await approve(row.id, req.user!.username, req.user!.id);
    return getBook(ctx, row.id);
  });

  const pending = (id: number) => {
    const b = getBook(ctx, id);
    if (!b) throw notFound('Request not found');
    if (b.status !== 'pending') throw conflict(`Request is already ${b.status}`);
    return b;
  };

  app.post('/api/books/:id/approve', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = pending(id);
    await approve(id, req.user!.username, req.user!.id);
    audit(ctx.db, req, 'book.approved', { target: b.title });
    return getBook(ctx, id);
  });

  app.post('/api/books/:id/decline', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().max(500).optional() }), req.body ?? {});
    const b = pending(id);
    ctx.db.update(books).set({ status: 'declined', reason: reason ?? null, decidedByName: req.user!.username, decidedAt: Date.now() }).where(eq(books.id, id)).run();
    audit(ctx.db, req, 'book.declined', { target: b.title });
    return { ok: true };
  });

  app.post('/api/books/:id/retry', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = getBook(ctx, id);
    if (!b) throw notFound('Request not found');
    if (!['approved', 'failed', 'downloading'].includes(b.status)) throw conflict(`Can't retry a request that is ${b.status}`);
    audit(ctx.db, req, 'book.retried', { target: b.title });
    return startBookDownload(ctx, id, req.user!.id);
  });

  /** Points a request at a different Open Library work (it was matched to the wrong book). */
  app.post('/api/books/:id/match', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ workKey }), req.body);
    const b = getBook(ctx, id);
    if (!b) throw notFound('Request not found');
    const clash = ctx.db.select().from(books).where(and(eq(books.workKey, body.workKey), eq(books.format, b.format))).get();
    if (clash && clash.id !== id) throw conflict(`There is already a request for that ${b.format}`);
    let work;
    try {
      work = await openLibrary(ctx).work(body.workKey);
    } catch (err) {
      throw upstream(err);
    }
    if (!work) throw badRequest('Could not find that book on Open Library');
    ctx.db
      .update(books)
      .set({ workKey: body.workKey, title: work.title.slice(0, 500), author: work.author?.slice(0, 300) ?? null, year: work.year, coverId: work.coverId, isbn: work.isbn })
      .where(eq(books.id, id))
      .run();
    audit(ctx.db, req, 'book.matched', { target: `${b.title} → ${work.title}` });
    return getBook(ctx, id);
  });

  app.delete('/api/books/:id', { config: { access: 'user' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = getBook(ctx, id);
    if (!b) throw notFound('Request not found');
    if (!hasRole(req.user!.role, 'manager') && (b.requestedBy !== req.user!.id || b.status !== 'pending')) throw forbidden('You can only cancel your own pending requests');
    ctx.db.delete(books).where(eq(books.id, id)).run();
    audit(ctx.db, req, 'book.deleted', { target: b.title });
    return { ok: true };
  });

  // ---------------- Audiobookshelf library ----------------
  app.get('/api/books/library', { config: { access: 'user' } }, async (req) => {
    const q = parse(z.object({ type: z.enum(['book', 'podcast']).default('book') }), req.query);
    const items = ctx.db.select().from(absItems).where(eq(absItems.mediaType, q.type)).orderBy(asc(absItems.title)).all();
    return { connected: Boolean(absClient(ctx)), items: items.map((i) => ({ ...i, cover: `abs:/api/items/${i.absId}/cover` })) };
  });

  app.post('/api/books/library/sync', { config: { access: 'manager' } }, async (req) => {
    try {
      const r = await syncAudiobookshelf(ctx);
      audit(ctx.db, req, 'audiobookshelf.synced', { details: r });
      return r;
    } catch (err) {
      throw upstream(err);
    }
  });

  app.get('/api/audiobookshelf/libraries', { config: { access: 'admin' } }, async () => {
    const abs = absClient(ctx);
    if (!abs) throw badRequest('Save the Audiobookshelf address and API token first');
    try {
      return (await abs.libraries()).map((l) => ({ id: l.id, name: l.name, mediaType: l.mediaType }));
    } catch (err) {
      throw upstream(err);
    }
  });

  // ---------------- Podcasts ----------------
  const subscribed = () => new Set(ctx.db.select({ t: absItems.title }).from(absItems).where(eq(absItems.mediaType, 'podcast')).all().map((r) => r.t.toLowerCase()));

  app.get('/api/podcasts/search', { config: { access: 'user' } }, async (req) => {
    const { q } = parse(z.object({ q: z.string().trim().min(1).max(200) }), req.query);
    try {
      const subs = subscribed();
      return (await searchPodcasts(q, region())).map((p) => ({ ...p, subscribed: subs.has(p.title.toLowerCase()) }));
    } catch (err) {
      throw upstream(err);
    }
  });

  app.get('/api/podcasts/top', { config: { access: 'user' } }, async () => {
    try {
      const subs = subscribed();
      return (await topPodcasts(region())).map((p) => ({ ...p, subscribed: subs.has(p.title.toLowerCase()) }));
    } catch (err) {
      throw upstream(err);
    }
  });

  /** Subscribes Audiobookshelf's podcast library to a show. The feed URL is looked up server-side by id. */
  app.post('/api/podcasts', { config: { access: 'manager' } }, async (req) => {
    const { itunesId } = parse(z.object({ itunesId: z.number().int().positive() }), req.body);
    const abs = absClient(ctx);
    const libId = ctx.settings.get('audiobookshelf').podcastLibraryId;
    if (!abs || !libId) throw badRequest('Connect Audiobookshelf and pick a podcast library first (Settings → Books)');
    try {
      const p = await lookupPodcast(itunesId);
      if (!p?.feedUrl) throw notFound('Podcast not found');
      await abs.addPodcast(libId, { feedUrl: p.feedUrl, title: p.title, author: p.author ?? undefined, imageUrl: p.artwork ?? undefined });
      audit(ctx.db, req, 'podcast.added', { target: p.title });
      void syncAudiobookshelf(ctx).catch(() => undefined);
      return { ok: true, title: p.title };
    } catch (err) {
      throw upstream(err);
    }
  });

  app.get('/api/books/counts', { config: { access: 'manager' } }, async () => ({
    pending: ctx.db.select({ id: books.id }).from(books).where(inArray(books.status, ['pending'])).all().length,
  }));
}
