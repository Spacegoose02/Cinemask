import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

/**
 * What to refetch when the server says a topic changed. Topics are the first path segment of the
 * API route that was written to (POST /api/requests → requests), or a background job's topic.
 */
const TOPIC_QUERIES: Record<string, string[]> = {
  requests: ['requests', 'request-count', 'request-quota', 'watchlist-me', 'home-row', 'media', 'lookup', 'activity', 'search', 'discover'],
  downloads: ['downloads', 'download-count', 'music-requests', 'files', 'file-details', 'issues', 'issue-count', 'monitored-overview', 'activity', 'manual-import', 'media', 'calendar', 'import'],
  monitored: ['storage', 'monitored-overview', 'files', 'media', 'calendar', 'airing', 'downloads', 'download-count', 'lookup'],
  files: ['storage', 'files', 'file-details', 'media', 'duplicates', 'rename', 'monitored-overview'],
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
  users: ['users', 'sessions', 'watchlist-me', 'invites'],
  invites: ['invites', 'users'],
  playing: ['now-playing', 'watch-stats'],
  overlays: ['overlays'],
  music: ['music-requests', 'music-artists', 'music-search', 'music-artist', 'music-count'],
  trash: ['profiles', 'custom-formats'],
  trakt: ['trakt-me', 'watchlist-me'],
  backups: ['backups'],
  indexers: ['indexers', 'health-summary'],
  'download-clients': ['clients', 'health-summary'],
  profiles: ['profiles'],
  media: ['media', 'home-row'],
  ratings: ['ratings', 'home-row', 'wrapped', 'badges'],
  'movie-nights': ['movie-nights', 'home-row'],
  games: ['leaderboard', 'badges'],
  issues: ['issues', 'issue-count', 'title-issues'],
  watchlist: ['watchlist-me'],
  storage: ['storage', 'files', 'monitored-overview'],
  watchmask: ['watchmask-lists', 'watchmask-member'],
  // Saving the Watchmask address or token changes which lists exist.
  settings: ['watchmask-lists', 'watchmask-member'],
};

function invalidate(qc: QueryClient, topics: Set<string>) {
  const keys = new Set<string>();
  for (const t of topics) for (const k of TOPIC_QUERIES[t] ?? []) keys.add(k);
  if (!keys.size) return;
  // Refetches the queries on screen; the rest are marked stale and refetch when next shown.
  void qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && keys.has(q.queryKey[0]) });
}

/** What the tab holding the stream tells the other tabs. */
type LiveMessage = { type: 'topic'; topic: string } | { type: 'status'; connected: boolean } | { type: 'resync' } | { type: 'closed' } | { type: 'hello' };

const LOCK = 'cinemask-live';

/**
 * Keeps the open tab in step with the server: listens to /api/events and refetches whatever
 * changed, so badges, downloads and requests update without polling or a manual refresh.
 * Returns whether the stream is connected.
 *
 * Only one tab per browser holds the stream; it passes what it hears to the other tabs over a
 * BroadcastChannel. Over plain HTTP/1.1 a browser opens at most six connections to one server,
 * shared by every tab, so a stream per tab meant that with six tabs (or the installed app and a
 * few tabs) open, every other request waited forever and the app looked frozen. When the tab
 * holding the stream closes, the next tab takes it over.
 */
export function useLiveUpdates(enabled: boolean): boolean {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    let pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const shared = typeof BroadcastChannel !== 'undefined' && typeof navigator !== 'undefined' && Boolean(navigator.locks);
    const channel = shared ? new BroadcastChannel(LOCK) : null;
    let leading = false;

    const flush = () => {
      timer = null;
      const topics = pending;
      pending = new Set();
      invalidate(qc, topics);
    };
    const heard = (topic: string) => {
      pending.add(topic);
      // Several writes in a row (a bulk action) become one refetch.
      timer ??= setTimeout(flush, 400);
    };
    const resync = () => void qc.invalidateQueries({ refetchType: 'active' });
    const signedOutElsewhere = () => void qc.invalidateQueries({ queryKey: ['me'] });

    // The tab that holds the stream.
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let retryMs = 5_000;
    let stopped = false;
    let lastStatus = false;
    const tell = (m: LiveMessage) => channel?.postMessage(m);
    const status = (c: boolean) => {
      lastStatus = c;
      setConnected(c);
      tell({ type: 'status', connected: c });
    };

    const open = () => {
      if (stopped) return;
      let everConnected = false;
      let droppedAt = 0;
      const s = new EventSource('/api/events');
      source = s;
      s.addEventListener('ready', () => {
        status(true);
        retryMs = 5_000;
        // Anything could have changed while we were away (laptop asleep, phone app in the
        // background), so refresh what's on screen. The server also ends each stream every few
        // minutes and the browser reconnects within seconds; that gap needs no refresh.
        if (everConnected && Date.now() - droppedAt > 15_000) {
          resync();
          tell({ type: 'resync' });
        }
        everConnected = true;
        droppedAt = 0;
      });
      s.onmessage = (e) => {
        try {
          const { topic } = JSON.parse(e.data as string) as { topic?: string };
          if (!topic) return;
          heard(topic);
          tell({ type: 'topic', topic });
        } catch {
          // Ignore anything malformed.
        }
      };
      s.onerror = () => {
        if (s.readyState !== EventSource.OPEN) droppedAt ||= Date.now();
        status(false);
        if (s.readyState !== EventSource.CLOSED) return;
        // A 401 (signed out elsewhere) closes the stream for good; check who we are again. So does
        // a proxy answering 502 while the server restarts, so try again later rather than never.
        signedOutElsewhere();
        tell({ type: 'closed' });
        retry ??= setTimeout(() => {
          retry = null;
          if (source === s) open();
        }, retryMs);
        retryMs = Math.min(retryMs * 2, 60_000);
      };
    };

    // Phones suspend background tabs; reconnect as soon as the app is visible again.
    const onVisible = () => {
      if (leading && document.visibilityState === 'visible' && source?.readyState === EventSource.CLOSED) {
        source.close();
        if (retry) clearTimeout(retry);
        retry = null;
        open();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    let release: (() => void) | null = null;
    const abort = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const lead = () => {
      leading = true;
      open();
    };

    if (channel) {
      channel.onmessage = (e: MessageEvent<LiveMessage>) => {
        const m = e.data;
        if (m.type === 'hello') {
          if (leading) tell({ type: 'status', connected: lastStatus });
        } else if (leading) {
          // Another tab thinks it holds the stream; only one can hold the lock, so ignore it.
        } else if (m.type === 'topic') heard(m.topic);
        else if (m.type === 'status') setConnected(m.connected);
        else if (m.type === 'resync') resync();
        else if (m.type === 'closed') signedOutElsewhere();
      };
      // Ask whoever holds the stream whether it's connected.
      tell({ type: 'hello' });
      navigator.locks
        .request(LOCK, { signal: abort?.signal }, () => {
          if (stopped) return;
          lead();
          // Hold the lock until this tab closes or signs out.
          return new Promise<void>((resolve) => (release = resolve));
        })
        .catch(() => {
          // Aborted before this tab's turn came: it closed or signed out.
        });
    } else {
      // No way to share one stream between tabs: each tab keeps its own.
      lead();
    }

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisible);
      if (timer) clearTimeout(timer);
      if (retry) clearTimeout(retry);
      source?.close();
      source = null;
      if (leading) tell({ type: 'status', connected: false });
      abort?.abort();
      release?.();
      channel?.close();
      setConnected(false);
    };
  }, [enabled, qc]);

  return connected;
}
