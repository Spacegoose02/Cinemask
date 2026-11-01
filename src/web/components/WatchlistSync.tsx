import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, formatDate } from '../lib/api';
import { Alert, Toggle } from './ui';
import { useT } from '../lib/i18n';

interface WatchlistState {
  sync: boolean;
  sources: { plex: boolean; jellyfin: boolean };
  syncedAt: number | null;
  error: string | null;
  items: { source: 'plex' | 'jellyfin'; kind: 'movie' | 'show'; tmdbId: number; title: string; result: string | null; createdAt: number }[];
}

const RESULT: Record<string, string> = {
  requested: 'Requested',
  approved: 'Requested and approved',
  following: 'Already requested; you’ll hear when it’s ready',
  on_server: 'Already on the server',
};

/** Account → Watchlist: Plex watchlist and Jellyfin favourites become requests. */
export function WatchlistSync() {
  const qc = useQueryClient();
  const t = useT();
  const q = useQuery({ queryKey: ['watchlist-me'], queryFn: () => api<WatchlistState>('/api/watchlist/me') });
  const set = useMutation({
    mutationFn: (sync: boolean) => api<WatchlistState>('/api/watchlist/me', { method: 'PUT', body: { sync } }),
    onSuccess: (d) => qc.setQueryData(['watchlist-me'], d),
  });
  const now = useMutation({
    mutationFn: () => api<WatchlistState & { requested: number }>('/api/watchlist/me/sync', { body: {} }),
    onSuccess: (d) => qc.setQueryData(['watchlist-me'], d),
  });
  const d = q.data;
  if (!d) return null;
  const from = [d.sources.plex && 'your Plex watchlist', d.sources.jellyfin && 'your Jellyfin favourites'].filter(Boolean).join(' and ');
  return (
    <section className="card space-y-3">
      <h2 className="font-semibold">{t('Watchlist')}</h2>
      {from ? (
        <Toggle label={`Request what I add to ${from}`} checked={d.sync} onChange={(v) => set.mutate(v)} hint="Checked every 30 minutes. Requests follow the usual rules: approval, your request limit and so on." />
      ) : (
        <p className="text-sm text-muted">Link your Plex account below (or ask an admin to link your Jellyfin account) and what you add to your watchlist is requested for you.</p>
      )}
      {set.error && <Alert>{(set.error as Error).message}</Alert>}
      {now.error && <Alert>{(now.error as Error).message}</Alert>}
      {d.error && <Alert>{d.error}</Alert>}
      {d.sync && (
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
          <span>{d.syncedAt ? `Last checked ${formatDate(d.syncedAt)}` : 'Not checked yet'}</span>
          <button className="btn-secondary" disabled={now.isPending} onClick={() => now.mutate()}>
            {now.isPending ? 'Checking…' : 'Check now'}
          </button>
          {now.data && <span>{now.data.requested ? `Requested ${now.data.requested}.` : 'Nothing new.'}</span>}
        </div>
      )}
      {d.items.length > 0 && (
        <ul className="divide-y divide-border text-sm">
          {d.items.slice(0, 15).map((i) => (
            <li key={`${i.source}:${i.kind}:${i.tmdbId}`} className="flex justify-between gap-3 py-1.5">
              <Link to={`/${i.kind === 'movie' ? 'movie' : 'tv'}/${i.tmdbId}`} className="truncate hover:underline">
                {i.title}
              </Link>
              <span className="shrink-0 text-xs text-muted">{RESULT[i.result ?? ''] ?? i.result}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
