import { EventEmitter } from 'node:events';
import type { Access } from '../auth/guard.js';

/**
 * A "something changed" signal for open browser tabs. It never carries data, only a topic,
 * so a tab reacts by refetching through the normal access-checked API.
 */
export interface LiveEvent {
  topic: string;
  /** Lowest level that may hear about it: the access level of the route or job that caused it. */
  access: Exclude<Access, 'public'>;
}

export class LiveBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // One listener per open tab; a household won't get near this, but don't warn about it either.
    this.emitter.setMaxListeners(0);
  }

  publish(event: LiveEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(fn: (event: LiveEvent) => void): () => void {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }

  get listeners(): number {
    return this.emitter.listenerCount('event');
  }
}

/** Which topic a background job announces when it finishes, and who may hear it. */
export const JOB_TOPICS: Record<string, LiveEvent> = {
  track: { topic: 'downloads', access: 'manager' },
  'watch-folder': { topic: 'downloads', access: 'manager' },
  rss: { topic: 'downloads', access: 'manager' },
  missing: { topic: 'downloads', access: 'manager' },
  health: { topic: 'health', access: 'admin' },
  'refresh-monitored': { topic: 'calendar', access: 'user' },
  lists: { topic: 'lists', access: 'user' },
  collections: { topic: 'collections', access: 'user' },
  audiobookshelf: { topic: 'books', access: 'user' },
  shelfmark: { topic: 'books', access: 'user' },
  readmeabook: { topic: 'books', access: 'user' },
  'youtube-check': { topic: 'youtube', access: 'manager' },
  'youtube-download': { topic: 'youtube', access: 'manager' },
};

/** Writes under these never need to reach other tabs. */
const QUIET = new Set(['auth', 'events', 'setup', 'health']);

/** The topic for a write to an API route: its first path segment, e.g. /api/requests/:id → requests. */
export function topicForRoute(url: string): string | null {
  const m = /^\/api\/([a-z0-9-]+)/.exec(url);
  if (!m || QUIET.has(m[1]!)) return null;
  return m[1]!;
}
