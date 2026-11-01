import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { requestFollowers, type requests } from '../db/schema.js';
import { notify } from './service.js';

type RequestRow = typeof requests.$inferSelect;

/** The person who asked, and everyone who said "me too". */
export function requestAudience(ctx: AppContext, r: RequestRow): number[] {
  const followers = ctx.db.select({ id: requestFollowers.userId }).from(requestFollowers).where(eq(requestFollowers.requestId, r.id)).all().map((f) => f.id);
  return [...new Set([...(r.requestedBy ? [r.requestedBy] : []), ...followers])];
}

const name = (r: RequestRow) => `${r.title}${r.year ? ` (${r.year})` : ''}`;

/** A movie or show request is now on the server. */
export function requestAvailable(ctx: AppContext, r: RequestRow) {
  notify(ctx, {
    event: 'request.available',
    title: 'Ready to watch',
    message: `${name(r)} is ready to watch`,
    data: { kind: r.kind, tmdbId: r.tmdbId, requestId: r.id, requestedBy: r.requestedByName },
    to: requestAudience(ctx, r),
  });
}

export function requestApproved(ctx: AppContext, r: RequestRow, by: string) {
  notify(ctx, {
    event: 'request.approved',
    title: 'Request approved',
    message: `${name(r)} was approved${by === 'Auto-approved' ? '' : ` by ${by}`}. It's on its way.`,
    data: { kind: r.kind, tmdbId: r.tmdbId, requestId: r.id, requestedBy: r.requestedByName },
    to: requestAudience(ctx, r),
    url: '/requests',
  });
}

export function requestDeclined(ctx: AppContext, r: RequestRow, by: string, reason: string | null) {
  notify(ctx, {
    event: 'request.declined',
    title: 'Request declined',
    message: `${name(r)} was declined by ${by}${reason ? `: ${reason}` : '.'}`,
    data: { kind: r.kind, tmdbId: r.tmdbId, requestId: r.id, requestedBy: r.requestedByName, reason },
    to: requestAudience(ctx, r),
  });
}
