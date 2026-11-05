import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import type { AppContext } from '../context.js';
import { MEDIA_KINDS, media, ratings, users, type MediaKind } from '../db/schema.js';
import { availabilityFor, cards, refreshMetadata, tmdbClient } from '../library/service.js';
import { upstream } from '../library/routes.js';
import { notFound } from '../lib/errors.js';
import { forViewer } from '../kids/ratings.js';
import { parse } from '../lib/validate.js';

const titleParams = z.object({ kind: z.enum(MEDIA_KINDS), tmdbId: z.coerce.number().int().positive() });
const ratingBody = z.object({
  stars: z.number().int().min(1).max(5),
  review: z.string().trim().max(2000).nullish(),
});

export const nameOf = (u: { username: string; displayName: string | null }) => u.displayName || u.username;

/** The household's average stars for each title, rounded to one decimal. */
export function familyScores(ctx: AppContext, kind: MediaKind, tmdbIds: number[]): Map<number, { average: number; count: number }> {
  const out = new Map<number, { average: number; count: number }>();
  if (!tmdbIds.length) return out;
  const rows = ctx.db
    .select({ tmdbId: ratings.tmdbId, average: sql<number>`avg(${ratings.stars})`, count: sql<number>`count(*)` })
    .from(ratings)
    .where(and(eq(ratings.kind, kind), inArray(ratings.tmdbId, tmdbIds)))
    .groupBy(ratings.tmdbId)
    .all();
  for (const r of rows) out.set(r.tmdbId, { average: Math.round(r.average * 10) / 10, count: r.count });
  return out;
}

/** Titles the household rates best, for the "Family favorites" row. Needs two ratings unless only one person rates. */
export function familyFavorites(ctx: AppContext, opts: { since?: number; limit?: number } = {}) {
  const raters = ctx.db.select({ n: sql<number>`count(DISTINCT ${ratings.userId})` }).from(ratings).get()?.n ?? 0;
  const minCount = raters > 1 ? 2 : 1;
  const rows = ctx.db
    .select({
      kind: ratings.kind,
      tmdbId: ratings.tmdbId,
      average: sql<number>`avg(${ratings.stars})`,
      count: sql<number>`count(*)`,
      title: media.title,
      year: media.year,
      posterPath: sql<string | null>`coalesce(${media.posterOverride}, ${media.posterPath})`,
    })
    .from(ratings)
    .innerJoin(media, and(eq(media.kind, ratings.kind), eq(media.tmdbId, ratings.tmdbId)))
    .where(opts.since ? gte(ratings.updatedAt, opts.since) : undefined)
    .groupBy(ratings.kind, ratings.tmdbId)
    .having(and(sql`count(*) >= ${minCount}`, sql`avg(${ratings.stars}) >= 3.5`))
    .orderBy(desc(sql`avg(${ratings.stars})`), desc(sql`count(*)`), desc(sql`max(${ratings.updatedAt})`))
    .limit(opts.limit ?? 30)
    .all();
  const avail = { movie: availabilityFor(ctx, 'movie', rows.filter((r) => r.kind === 'movie')), show: availabilityFor(ctx, 'show', rows.filter((r) => r.kind === 'show')) };
  return rows.map((r) => ({ ...r, average: Math.round(r.average * 10) / 10, availability: avail[r.kind].get(r.tmdbId)! }));
}

/** Star ratings and reviews from everyone in the household. */
export async function ratingRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.get('/api/ratings/favorites', { config: { access: 'user' } }, async () => ({ items: familyFavorites(ctx) }));

  /** Titles like the one this person most recently gave four or five stars, from TMDB's recommendations. */
  app.get('/api/ratings/because', { config: { access: 'user' } }, async (req) => {
    const liked = ctx.db
      .select({ kind: ratings.kind, tmdbId: ratings.tmdbId, title: media.title })
      .from(ratings)
      .innerJoin(media, and(eq(media.kind, ratings.kind), eq(media.tmdbId, ratings.tmdbId)))
      .where(and(eq(ratings.userId, req.user!.id), gte(ratings.stars, 4)))
      .orderBy(desc(ratings.updatedAt))
      .get();
    const tmdb = tmdbClient(ctx);
    if (!liked || !tmdb.configured) return { basedOn: null, results: [] };
    const recs = await upstream(() => tmdb.recommendations(liked.kind === 'movie' ? 'movie' : 'tv', liked.tmdbId));
    const rated = new Set(ctx.db.select({ k: ratings.kind, t: ratings.tmdbId }).from(ratings).where(eq(ratings.userId, req.user!.id)).all().map((r) => `${r.k}:${r.t}`));
    return { basedOn: liked, results: await forViewer(ctx, req.user!.id, cards(ctx, recs.results, liked.kind).filter((c) => !rated.has(`${c.kind}:${c.tmdbId}`))) };
  });

  app.get('/api/ratings/:kind/:tmdbId', { config: { access: 'user' } }, async (req) => {
    const { kind, tmdbId } = parse(titleParams, req.params);
    const rows = ctx.db
      .select({ userId: ratings.userId, stars: ratings.stars, review: ratings.review, updatedAt: ratings.updatedAt, username: users.username, displayName: users.displayName })
      .from(ratings)
      .innerJoin(users, eq(users.id, ratings.userId))
      .where(and(eq(ratings.kind, kind), eq(ratings.tmdbId, tmdbId)))
      .orderBy(desc(ratings.updatedAt))
      .all();
    const mine = rows.find((r) => r.userId === req.user!.id);
    return {
      family: familyScores(ctx, kind, [tmdbId]).get(tmdbId) ?? null,
      mine: mine ? { stars: mine.stars, review: mine.review } : null,
      ratings: rows.map((r) => ({ userId: r.userId, name: nameOf(r), stars: r.stars, review: r.review, updatedAt: r.updatedAt })),
    };
  });

  app.put('/api/ratings/:kind/:tmdbId', { config: { access: 'user' } }, async (req) => {
    const { kind, tmdbId } = parse(titleParams, req.params);
    const body = parse(ratingBody, req.body);
    // Ratings are only for real titles: the media row gives Wrapped and the favorites row a title and poster.
    const row = await upstream(() => refreshMetadata(ctx, kind, tmdbId));
    if (!row) throw notFound('That title could not be found');
    const now = Date.now();
    const review = body.review || null;
    ctx.db
      .insert(ratings)
      .values({ userId: req.user!.id, kind, tmdbId, stars: body.stars, review, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: [ratings.userId, ratings.kind, ratings.tmdbId], set: { stars: body.stars, review, updatedAt: now } })
      .run();
    return { ok: true, family: familyScores(ctx, kind, [tmdbId]).get(tmdbId) ?? null };
  });

  app.delete('/api/ratings/:kind/:tmdbId', { config: { access: 'user' } }, async (req) => {
    const { kind, tmdbId } = parse(titleParams, req.params);
    ctx.db.delete(ratings).where(and(eq(ratings.userId, req.user!.id), eq(ratings.kind, kind), eq(ratings.tmdbId, tmdbId))).run();
    return { ok: true };
  });

  /** Managers can take down someone else's rating and review. */
  app.delete('/api/ratings/:kind/:tmdbId/users/:id', { config: { access: 'manager' } }, async (req) => {
    const { kind, tmdbId, id } = parse(titleParams.extend({ id: z.coerce.number().int().positive() }), req.params);
    const removed = ctx.db.delete(ratings).where(and(eq(ratings.userId, id), eq(ratings.kind, kind), eq(ratings.tmdbId, tmdbId))).returning().get();
    if (!removed) throw notFound('No rating to remove');
    audit(ctx.db, req, 'rating.removed', { target: `${kind}:${tmdbId}`, details: { userId: id, stars: removed.stars, review: removed.review } });
    return { ok: true };
  });
}
