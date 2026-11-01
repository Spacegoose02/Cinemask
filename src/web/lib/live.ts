import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

/**
 * What to refetch when the server says a topic changed. Topics are the first path segment of the
 * API route that was written to (POST /api/requests → requests), or a background job's topic.
 */
const TOPIC_QUERIES: Record<string, string[]> = {
  requests: ['requests', 'request-count', 'request-quota', 'home-row', 'media', 'lookup', 'activity', 'search', 'discover'],
  downloads: ['downloads', 'download-count', 'files', 'file-details', 'issues', 'issue-count', 'monitored-overview', 'activity', 'manual-import', 'media', 'calendar', 'import'],
  monitored: ['monitored-overview', 'files', 'media', 'calendar', 'airing', 'downloads', 'download-count', 'lookup'],
  files: ['files', 'file-details', 'media', 'duplicates', 'rename', 'monitored-overview'],
  'manual-import': ['manual-import', 'downloads', 'download-count', 'files'],
  import: ['import', 'files', 'monitored-overview'],
  library: ['library', 'library-sections', 'library-labels', 'home-row', 'media', 'airing', 'calendar', 'duplicates', 'sync-status', 'lookup'],
  books: ['book-requests', 'abs-library', 'books-search'],
  podcasts: ['podcasts-top', 'podcasts-search', 'abs-library'],
  health: ['health', 'health-summary'],
  system: ['health', 'health-summary'],
  youtube: ['yt-channels', 'yt-videos', 'yt-playlists'],
  lists: ['lists', 'list', 'home-row'],
  collections: ['collections', 'collection', 'tmdb-collections', 'home-row'],
  calendar: ['calendar', 'airing', 'home-row'],
  posters: ['posters', 'media', 'collection', 'collections'],
  duplicates: ['duplicates'],
  home: ['home-layout', 'home-row'],
  users: ['users', 'sessions'],
  backups: ['backups'],
  indexers: ['indexers', 'health-summary'],
  'download-clients': ['clients', 'health-summary'],
  profiles: ['profiles'],
  media: ['media', 'home-row'],
  ratings: ['ratings', 'home-row', 'wrapped', 'badges'],
  'movie-nights': ['movie-nights', 'home-row'],
  games: ['leaderboard', 'badges'],
  issues: ['issues', 'issue-count', 'title-issues'],
};

function invalidate(qc: QueryClient, topics: Set<string>) {
  const keys = new Set<string>();
  for (const t of topics) for (const k of TOPIC_QUERIES[t] ?? []) keys.add(k);
  if (!keys.size) return;
  // Refetches the queries on screen; the rest are marked stale and refetch when next shown.
  void qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && keys.has(q.queryKey[0]) });
}

/**
 * Keeps the open tab in step with the server: listens to /api/events and refetches whatever
 * changed, so badges, downloads and requests update without polling or a manual refresh.
 * Returns whether the stream is connected.
 */
export function useLiveUpdates(enabled: boolean): boolean {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    let source: EventSource | null = null;
    let pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let everConnected = false;
    let droppedAt = 0;

    const flush = () => {
      timer = null;
      const topics = pending;
      pending = new Set();
      invalidate(qc, topics);
    };

    const open = () => {
      source = new EventSource('/api/events');
      source.addEventListener('ready', () => {
        setConnected(true);
        // Anything could have changed while we were away (laptop asleep, phone app in the
        // background), so refresh what's on screen. The server also ends each stream every few
        // minutes and the browser reconnects within seconds; that gap needs no refresh.
        if (everConnected && Date.now() - droppedAt > 15_000) void qc.invalidateQueries({ refetchType: 'active' });
        everConnected = true;
        droppedAt = 0;
      });
      source.onmessage = (e) => {
        try {
          const { topic } = JSON.parse(e.data as string) as { topic?: string };
          if (!topic) return;
          pending.add(topic);
          // Several writes in a row (a bulk action) become one refetch.
          timer ??= setTimeout(flush, 400);
        } catch {
          // Ignore anything malformed.
        }
      };
      source.onerror = () => {
        if (source?.readyState !== EventSource.OPEN) droppedAt ||= Date.now();
        setConnected(false);
        // A 401 (signed out elsewhere) closes the stream for good; check who we are again.
        if (source?.readyState === EventSource.CLOSED) {
          void qc.invalidateQueries({ queryKey: ['me'] });
        }
      };
    };

    // Phones suspend background tabs; reconnect as soon as the app is visible again.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && source?.readyState === EventSource.CLOSED) {
        source.close();
        open();
      }
    };
    open();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      if (timer) clearTimeout(timer);
      source?.close();
      setConnected(false);
    };
  }, [enabled, qc]);

  return connected;
}
