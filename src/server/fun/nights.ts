import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import type { AppContext } from '../context.js';
import { MEDIA_KINDS, RSVP_ANSWERS, movieNightRsvps, movieNights, users } from '../db/schema.js';
import { refreshMetadata } from '../library/service.js';
import { upstream } from '../library/routes.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { notify } from '../notify/service.js';
import { nameOf } from './ratings.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const nightBody = z.object({
  startsAt: z.number().int().positive(),
  note: z.string().trim().max(500).nullish(),
});
const idParam = z.object({ id: z.coerce.number().int().positive() });

type Night = typeof movieNights.$inferSelect;

function guests(ctx: AppContext, nightIds: number[]) {
  if (!nightIds.length) return [];
  return ctx.db
    .select({ nightId: movieNightRsvps.nightId, userId: movieNightRsvps.userId, answer: movieNightRsvps.answer, username: users.username, displayName: users.displayName })
    .from(movieNightRsvps)
    .innerJoin(users, eq(users.id, movieNightRsvps.userId))
    .where(inArray(movieNightRsvps.nightId, nightIds))
    .all();
}

function present(ctx: AppContext, nights: Night[], me: number) {
  const all = guests(ctx, nights.map((n) => n.id));
  return nights.map((n) => {
    const mine = all.filter((g) => g.nightId === n.id);
    return {
      ...n,
      mine: n.hostId === me,
      myAnswer: mine.find((g) => g.userId === me)?.answer ?? null,
      rsvps: mine.map((g) => ({ userId: g.userId, name: nameOf(g), answer: g.answer })),
    };
  });
}

/** Only the host or a manager can change or call off a movie night. */
function ownNight(ctx: AppContext, req: FastifyRequest, id: number): Night {
  const night = ctx.db.select().from(movieNights).where(eq(movieNights.id, id)).get();
  if (!night) throw notFound('No such movie night');
  const u = req.user!;
  if (night.hostId !== u.id && u.role === 'user') throw forbidden('Only the host or a manager can change this movie night');
  return night;
}

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Sends "starting soon" for movie nights within the next hour, once each. */
export function remindMovieNights(ctx: AppContext, now = Date.now()): number {
  const due = ctx.db
    .select()
    .from(movieNights)
    .where(and(isNull(movieNights.remindedAt), gte(movieNights.startsAt, now), lte(movieNights.startsAt, now + HOUR)))
    .all();
  for (const n of due) {
    const coming = guests(ctx, [n.id]).filter((g) => g.answer === 'yes').map(nameOf);
    notify(ctx, {
      event: 'movie_night.reminder',
      title: 'Movie night soon',
      message: `${n.title} starts at ${when(n.startsAt)}${coming.length ? `. Coming: ${coming.join(', ')}` : ''}`,
      data: { id: n.id, kind: n.kind, tmdbId: n.tmdbId, startsAt: n.startsAt, host: n.hostName, coming },
    });
    ctx.db.update(movieNights).set({ remindedAt: now }).where(eq(movieNights.id, n.id)).run();
  }
  return due.length;
}

export async function movieNightRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  /** Coming movie nights, plus the past week's so people can see how it went. */
  app.get('/api/movie-nights', { config: { access: 'user' } }, async (req) => {
    const nights = ctx.db.select().from(movieNights).where(gte(movieNights.startsAt, Date.now() - 7 * DAY)).orderBy(asc(movieNights.startsAt)).all();
    return present(ctx, nights, req.user!.id);
  });

  app.post('/api/movie-nights', { config: { access: 'user' } }, async (req) => {
    const body = parse(nightBody.extend({ kind: z.enum(MEDIA_KINDS), tmdbId: z.number().int().positive() }), req.body);
    if (body.startsAt < Date.now() - HOUR) throw badRequest('Pick a time in the future');
    if (body.startsAt > Date.now() + 366 * DAY) throw badRequest('Pick a time within the next year');
    const row = await upstream(() => refreshMetadata(ctx, body.kind, body.tmdbId));
    if (!row) throw notFound('That title could not be found');
    const u = req.user!;
    const night = ctx.db
      .insert(movieNights)
      .values({ kind: body.kind, tmdbId: body.tmdbId, title: row.title, year: row.year, posterPath: row.posterOverride ?? row.posterPath, startsAt: body.startsAt, note: body.note || null, hostId: u.id, hostName: nameOf(u), createdAt: Date.now() })
      .returning()
      .get();
    // The host is coming, of course.
    ctx.db.insert(movieNightRsvps).values({ nightId: night.id, userId: u.id, answer: 'yes', updatedAt: Date.now() }).run();
    audit(ctx.db, req, 'movie_night.created', { target: `${night.kind}:${night.tmdbId}`, details: { id: night.id, startsAt: night.startsAt } });
    notify(ctx, {
      event: 'movie_night.created',
      title: 'Movie night planned',
      message: `${nameOf(u)} planned ${night.title} for ${when(night.startsAt)}`,
      data: { id: night.id, kind: night.kind, tmdbId: night.tmdbId, startsAt: night.startsAt, host: night.hostName },
    });
    return present(ctx, [night], u.id)[0];
  });

  app.patch('/api/movie-nights/:id', { config: { access: 'user' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(nightBody.partial(), req.body);
    const night = ownNight(ctx, req, id);
    if (body.startsAt !== undefined && body.startsAt < Date.now() - HOUR) throw badRequest('Pick a time in the future');
    const set: Partial<Night> = {};
    if (body.startsAt !== undefined && body.startsAt !== night.startsAt) Object.assign(set, { startsAt: body.startsAt, remindedAt: null });
    if (body.note !== undefined) set.note = body.note || null;
    if (Object.keys(set).length) ctx.db.update(movieNights).set(set).where(eq(movieNights.id, id)).run();
    audit(ctx.db, req, 'movie_night.updated', { target: `${night.kind}:${night.tmdbId}`, details: { id, ...body } });
    return present(ctx, [ctx.db.select().from(movieNights).where(eq(movieNights.id, id)).get()!], req.user!.id)[0];
  });

  app.delete('/api/movie-nights/:id', { config: { access: 'user' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const night = ownNight(ctx, req, id);
    ctx.db.delete(movieNights).where(eq(movieNights.id, id)).run();
    audit(ctx.db, req, 'movie_night.deleted', { target: `${night.kind}:${night.tmdbId}`, details: { id, title: night.title, startsAt: night.startsAt } });
    return { ok: true };
  });

  app.put('/api/movie-nights/:id/rsvp', { config: { access: 'user' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { answer } = parse(z.object({ answer: z.enum(RSVP_ANSWERS) }), req.body);
    const night = ctx.db.select().from(movieNights).where(eq(movieNights.id, id)).get();
    if (!night) throw notFound('No such movie night');
    ctx.db
      .insert(movieNightRsvps)
      .values({ nightId: id, userId: req.user!.id, answer, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: [movieNightRsvps.nightId, movieNightRsvps.userId], set: { answer, updatedAt: Date.now() } })
      .run();
    return present(ctx, [night], req.user!.id)[0];
  });
}
