import type { AppContext } from '../context.js';
import type { requests } from '../db/schema.js';
import { notify } from './service.js';

/** A movie or show request is now on the server. */
export function requestAvailable(ctx: AppContext, r: typeof requests.$inferSelect) {
  notify(ctx, {
    event: 'request.available',
    title: 'Request ready',
    message: `${r.title}${r.year ? ` (${r.year})` : ''} is ready to watch`,
    data: { kind: r.kind, tmdbId: r.tmdbId, requestId: r.id, requestedBy: r.requestedByName },
  });
}
