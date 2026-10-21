import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert } from '../components/ui';
import { api } from '../lib/api';
import { poster, type MediaKind } from '../lib/media';

type Status = 'downloaded' | 'missing' | 'partial' | 'upcoming';

interface OverviewRow {
  id: number;
  kind: MediaKind;
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  monitored: boolean;
  status: Status;
  episodes: { aired: number; missing: number } | null;
}

/** What a row says about its files: "Missing", "3 of 40 episodes missing", "Not released yet"… */
function statusText(r: OverviewRow): { text: string; tone: string } {
  if (r.status === 'downloaded') return { text: r.kind === 'show' ? `All ${r.episodes!.aired} aired episodes` : 'Downloaded', tone: 'text-success' };
  if (r.status === 'upcoming') return { text: r.kind === 'show' ? 'Nothing aired yet' : 'Not released yet', tone: 'text-muted' };
  if (r.kind === 'show') return { text: `${r.episodes!.missing} of ${r.episodes!.aired} episodes missing`, tone: r.status === 'missing' ? 'text-danger' : 'text-warning' };
  return { text: 'Missing', tone: 'text-danger' };
}

/** Every movie and show Cinemask follows: monitored or not, and what is missing. */
export function MonitoredPage() {
  const [params, setParams] = useSearchParams();
  const kind = params.get('kind') ?? '';
  const state = params.get('state') ?? '';
  const files = params.get('files') ?? '';
  const q = params.get('q') ?? '';
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const list = useQuery({ queryKey: ['monitored-overview'], queryFn: () => api<OverviewRow[]>('/api/monitored/overview') });

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const rows = (list.data ?? []).filter(
    (r) =>
      (!kind || r.kind === kind) &&
      (!state || (state === 'monitored') === r.monitored) &&
      (!files || (files === 'missing' ? r.status === 'missing' || r.status === 'partial' : r.status === files)) &&
      (!q || r.title.toLowerCase().includes(q.toLowerCase())),
  );
  const counts = {
    monitored: (list.data ?? []).filter((r) => r.monitored).length,
    unmonitored: (list.data ?? []).filter((r) => !r.monitored).length,
    missing: (list.data ?? []).filter((r) => r.monitored && (r.status === 'missing' || r.status === 'partial')).length,
  };

  const run = async (fn: () => Promise<string>) => {
    setMsg(null);
    try {
      setMsg({ kind: 'success', text: await fn() });
      await qc.invalidateQueries({ queryKey: ['monitored-overview'] });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Monitored</h1>
          {list.data && (
            <p className="text-sm text-muted">
              {counts.monitored} monitored · {counts.unmonitored} unmonitored · {counts.missing} monitored with something missing
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <input className="input w-44" placeholder="Filter by title" defaultValue={q} onChange={(e) => set('q', e.target.value)} aria-label="Filter by title" />
          <select className="input w-auto" value={kind} onChange={(e) => set('kind', e.target.value)} aria-label="Type">
            <option value="">Movies and shows</option>
            <option value="movie">Movies</option>
            <option value="show">Shows</option>
          </select>
          <select className="input w-auto" value={state} onChange={(e) => set('state', e.target.value)} aria-label="Monitored">
            <option value="">Monitored or not</option>
            <option value="monitored">Monitored</option>
            <option value="unmonitored">Unmonitored</option>
          </select>
          <select className="input w-auto" value={files} onChange={(e) => set('files', e.target.value)} aria-label="Files">
            <option value="">Any files</option>
            <option value="missing">Missing something</option>
            <option value="downloaded">Complete</option>
            <option value="upcoming">Not out yet</option>
          </select>
        </div>
      </div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {list.error && <Alert>{(list.error as Error).message}</Alert>}
      {list.data && !list.data.length && <div className="card text-sm text-muted">Nothing is monitored yet. Monitor a title from its page, or import from Radarr and Sonarr in Settings → Imports.</div>}
      {list.data && list.data.length > 0 && (
        <ul className="card divide-y divide-border p-0">
          {rows.map((r) => {
            const s = statusText(r);
            const src = poster(r.posterPath, 'w185');
            return (
              <li key={r.id} className="flex items-center gap-3 px-3 py-2">
                {src ? <img src={src} alt="" className="h-14 w-10 shrink-0 rounded object-cover" loading="lazy" /> : <div className="h-14 w-10 shrink-0 rounded bg-surface-2" />}
                <div className="min-w-0 flex-1">
                  <Link to={`/${r.kind === 'movie' ? 'movie' : 'tv'}/${r.tmdbId}`} className="block truncate font-medium hover:underline">
                    {r.title} {r.year && <span className="font-normal text-muted">({r.year})</span>}
                  </Link>
                  <div className="text-xs">
                    <span className={r.monitored ? 'text-accent' : 'text-muted'}>{r.monitored ? 'Monitored' : 'Unmonitored'}</span>
                    <span className="text-muted"> · {r.kind === 'movie' ? 'Movie' : 'Show'} · </span>
                    <span className={s.tone}>{s.text}</span>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  {r.monitored && (r.status === 'missing' || r.status === 'partial') && (
                    <button className="btn-secondary px-2 py-1 text-xs" onClick={() => void run(async () => `${r.title}: ${(await api<{ grabbed: number }>(`/api/monitored/${r.id}/search`, { body: {} })).grabbed} release(s) sent to the download client.`)}>
                      Search
                    </button>
                  )}
                  <button
                    className="btn-secondary px-2 py-1 text-xs"
                    onClick={() => void run(async () => (await api(`/api/monitored/${r.id}`, { method: 'PATCH', body: { monitored: !r.monitored } }), `${r.title} is ${r.monitored ? 'no longer monitored' : 'monitored'}.`))}
                  >
                    {r.monitored ? 'Unmonitor' : 'Monitor'}
                  </button>
                </div>
              </li>
            );
          })}
          {!rows.length && <li className="px-3 py-2 text-sm text-muted">Nothing matches these filters.</li>}
        </ul>
      )}
    </div>
  );
}
