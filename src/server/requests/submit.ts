import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { audit } from '../audit/log.js';
import type { SessionUser } from '../auth/sessions.js';
import type { AppContext } from '../context.js';
import { monitored, requestFollowers, requests, users, type MediaKind } from '../db/schema.js';
import { hasRole } from '../auth/guard.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors.js';
import { availabilityFor, refreshMetadata } from '../library/service.js';
import { notify } from '../notify/service.js';
import { requestApproved } from '../notify/events.js';
import { monitorTitle } from '../arr/monitor.js';
import { defaultProfileId, getProfile } from '../arr/profiles.js';
import { autoSearch } from '../arr/search.js';
import { assertSuitable } from '../kids/ratings.js';
import { quotaFor, quotaProblem, showSeasonCount, streamingFor } from './rules.js';

type RequestRow = typeof requests.$inferSelect;

/** The seasons open (pending or approved) show requests cover between them, or 'all' when one asked for every season. */
export function openSeasons(open: { seasons: string | null }[]): number[] | 'all' {
  if (open.some((r) => r.seasons === null)) return 'all';
  return [...new Set(open.flatMap((r) => JSON.parse(r.seasons!) as number[]))].sort((a, b) => a - b);
}

/** Approves a request: monitors the title (or adds the seasons) and starts a search. */
export async function approveRequest(ctx: AppContext, requestId: number, profileId: number | undefined, deciderName: string, deciderId: number, rootId?: string) {
  const db = ctx.db;
  const r = db.select().from(requests).where(eq(requests.id, requestId)).get();
  if (!r) throw notFound('Request not found');
  // A title that's already monitored keeps its profile, and gains the requested seasons. A 4K request moves it to the 4K profile.
  const existing = db.select().from(monitored).where(and(eq(monitored.kind, r.kind), eq(monitored.tmdbId, r.tmdbId))).get();
  const rs = ctx.settings.get('requests');
  const fourKProfile = r.fourK ? (r.kind === 'movie' ? rs.fourKMovieProfile : rs.fourKShowProfile) : null;
  const fourKRoot = r.fourK ? (r.kind === 'movie' ? rs.fourKMovieRoot : rs.fourKShowRoot) || undefined : undefined;
  const profile = profileId ?? (fourKProfile && getProfile(ctx, fourKProfile) ? fourKProfile : null) ?? existing?.profileId ?? defaultProfileId(ctx, r.kind);
  if (!getProfile(ctx, profile)) throw badRequest('Unknown quality profile');
  const asked = r.seasons ? (JSON.parse(r.seasons) as number[]) : null;
  const had = existing ? (existing.seasons ? (JSON.parse(existing.seasons) as number[]) : null) : [];
  const seasons = asked === null || had === null ? null : [...had, ...asked];
  const row = await monitorTitle(ctx, { kind: r.kind, tmdbId: r.tmdbId, profileId: profile, seasons, addedBy: deciderId, rootId: rootId ?? (existing ? undefined : fourKRoot) }).catch((err: Error) => {
    throw err.message === 'Unknown root folder' ? badRequest(err.message) : err;
  });
  // An existing title asked for in 4K switches to the 4K profile, so the next search upgrades it.
  if (existing && r.fourK && existing.profileId !== profile) db.update(monitored).set({ profileId: profile }).where(eq(monitored.id, existing.id)).run();
  db.update(requests).set({ status: 'approved', decidedByName: deciderName, decidedAt: Date.now(), monitoredId: row.id }).where(eq(requests.id, requestId)).run();
  // Nobody needs telling about their own download.
  if (r.requestedBy !== deciderId) requestApproved(ctx, r, deciderName);
  const fresh = db.select().from(monitored).where(eq(monitored.id, row.id)).get() ?? row;
  void autoSearch(ctx, fresh).catch(() => undefined);
  return fresh;
}

/** Adds the user to an open request ("me too") and returns it. */
export function followRequest(ctx: AppContext, r: RequestRow, userId: number) {
  if (r.requestedBy !== userId) ctx.db.insert(requestFollowers).values({ requestId: r.id, userId, createdAt: Date.now() }).onConflictDoNothing().run();
  return { ...r, following: r.requestedBy !== userId };
}

export interface RequestInput {
  kind: MediaKind;
  tmdbId: number;
  seasons?: number[] | null;
  rootId?: string;
  fourK?: boolean;
  note?: string;
  /** Where it came from, for the audit log ("watchlist"). */
  via?: string;
}

/**
 * Makes a request for a user with every rule applied: kids profiles, 4K permission, limits, the
 * streaming rule and "me too" for titles someone already asked for. Managers and trusted users are
 * approved straight away. Used by the request button and by watchlist sync.
 */
export async function submitRequest(ctx: AppContext, user: SessionUser, input: RequestInput, req: FastifyRequest | null) {
  const db = ctx.db;
  const fourK = input.fourK ?? false;
  const isManager = hasRole(user.role, 'manager');
  const me = db.select().from(users).where(eq(users.id, user.id)).get();
  if (fourK && !isManager && !me?.canRequest4k) throw forbidden("You can't request 4K. Ask an admin to allow it.");
  const meta = await refreshMetadata(ctx, input.kind, input.tmdbId);
  if (!meta) throw badRequest('Could not look up this title. Ask an admin to set a TMDB key.');
  await assertSuitable(ctx, user.id, input.kind, input.tmdbId);
  const avail = availabilityFor(ctx, input.kind, [{ tmdbId: input.tmdbId, releaseDate: meta.releaseDate }]).get(input.tmdbId)!;
  if (avail.status === 'on_server' && input.kind === 'movie') {
    // A 4K request still makes sense when the copy on the server isn't 4K.
    const file = db.select().from(monitored).where(and(eq(monitored.kind, 'movie'), eq(monitored.tmdbId, input.tmdbId))).get()?.fileQuality ?? avail.resolution ?? null;
    if (!fourK || (file && /2160|4k/i.test(file))) throw conflict(fourK ? 'This is already on the server in 4K' : 'This is already on the server');
  }
  const open = db
    .select()
    .from(requests)
    .where(and(eq(requests.kind, input.kind), eq(requests.tmdbId, input.tmdbId), eq(requests.fourK, fourK), inArray(requests.status, ['pending', 'approved'])))
    .orderBy(desc(requests.createdAt))
    .all();
  // Seasons a show request asks for beyond the open ones (null: every season).
  let seasons = input.seasons ?? null;
  const quota = await quotaFor(ctx, user);
  const cost = async (list: number[] | null) => (input.kind === 'movie' ? 1 : list ? list.length : await showSeasonCount(ctx, input.tmdbId));
  const checkQuota = async (list: number[] | null) => {
    const problem = quotaProblem(quota, input.kind, await cost(list));
    if (problem) throw new HttpError(429, problem, 'request_limit');
  };
  if (open.length) {
    const covered = openSeasons(open);
    // Someone already asked: this user follows that request instead, and hears when it's ready.
    if (input.kind === 'movie' || covered === 'all') return followRequest(ctx, open[0]!, user.id);
    const extra = seasons === null ? null : seasons.filter((n) => !covered.includes(n));
    if (extra?.length === 0) return followRequest(ctx, open[0]!, user.id);
    // Their own request still waiting for approval: one request with all the seasons is easier to approve than two.
    const pending = open.find((r) => r.status === 'pending' && r.requestedBy === user.id);
    if (pending && !isManager) {
      const merged = extra === null || pending.seasons === null ? null : [...new Set([...(JSON.parse(pending.seasons) as number[]), ...extra])].sort((a, b) => a - b);
      // Only the new seasons count against the allowance; the waiting request already does.
      if (extra !== null) await checkQuota(extra);
      else if (quota.seasons.limit) {
        const now = await showSeasonCount(ctx, input.tmdbId);
        const problem = quotaProblem(quota, 'show', Math.max(0, now - (await cost(pending.seasons ? (JSON.parse(pending.seasons) as number[]) : null))));
        if (problem) throw new HttpError(429, problem, 'request_limit');
      }
      db.update(requests)
        .set({ seasons: merged ? JSON.stringify(merged) : null, ...(input.note ? { note: input.note } : {}) })
        .where(eq(requests.id, pending.id))
        .run();
      audit(db, req, 'request.seasons_added', { target: `${meta.title} (${meta.year ?? '?'})`, details: { seasons: extra }, user });
      return db.select().from(requests).where(eq(requests.id, pending.id)).get()!;
    }
    seasons = extra;
  }
  await checkQuota(seasons);
  // Admins can refuse requests for titles the household can already stream.
  if (!isManager && ctx.settings.get('requests').streaming === 'block') {
    const hit = await streamingFor(ctx, input.kind, input.tmdbId);
    if (hit) throw conflict(`${meta.title} is on ${hit.providers.map((p) => p.name).join(', ')}, so it can't be requested. Ask a manager if you still need it.`);
  }
  const created = db
    .insert(requests)
    .values({
      kind: input.kind,
      tmdbId: input.tmdbId,
      title: meta.title,
      year: meta.year,
      posterPath: meta.posterPath,
      seasons: seasons ? JSON.stringify(seasons) : null,
      status: 'pending',
      requestedBy: user.id,
      requestedByName: user.displayName || user.username,
      createdAt: Date.now(),
      fourK,
      note: input.note || null,
    })
    .returning()
    .get();
  audit(db, req, 'request.created', { target: `${meta.title} (${meta.year ?? '?'})${fourK ? ' in 4K' : ''}`, user, ...(input.via ? { details: { via: input.via } } : {}) });
  notify(ctx, {
    event: 'request.created',
    title: 'New request',
    message: `${created.requestedByName} requested ${meta.title}${meta.year ? ` (${meta.year})` : ''}${fourK ? ' in 4K' : ''}${input.via === 'watchlist' ? ' from their watchlist' : ''}${input.note ? `: "${input.note}"` : ''}`,
    data: { kind: input.kind, tmdbId: input.tmdbId, requestId: created.id, fourK },
  });
  // Managers and admins don't need anyone's approval, nor do users an admin trusts with this kind.
  const trusted = input.kind === 'movie' ? me?.autoApproveMovies : me?.autoApproveShows;
  if (isManager) await approveRequest(ctx, created.id, undefined, user.username, user.id, input.rootId);
  else if (trusted) await approveRequest(ctx, created.id, undefined, 'Auto-approved', user.id);
  return db.select().from(requests).where(eq(requests.id, created.id)).get()!;
}
