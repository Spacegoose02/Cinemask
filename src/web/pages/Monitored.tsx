import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { airDayLabel } from '../components/Airing';
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
  profile: string | null;
  ended: boolean;
  nextAir: string | null;
}

const missingSomething = (r: OverviewRow) => r.status === 'missing' || r.status === 'partial';

/**
 * The bar under a poster, as Sonarr draws it: have / aired episodes (movies: 1 / 1), in red when a
 * monitored title is missing something, orange when an unmonitored one is, blue when it's complete.
 */
function Progress({ r }: { r: OverviewRow }) {
  const total = r.kind === 'show' ? r.episodes!.aired : r.status === 'upcoming' ? 0 : 1;
  const have = r.kind === 'show' ? total - r.episodes!.missing : r.status === 'downloaded' ? 1 : 0;
  const color = !total ? 'bg-muted' : have === total ? (r.ended || r.kind === 'movie' ? 'bg-info' : 'bg-success') : r.monitored ? 'bg-danger' : 'bg-warning';
  const label = r.kind === 'show' ? `${have} / ${total}` : r.status === 'downloaded' ? 'Downloaded' : r.status === 'upcoming' ? 'Not released' : 'Missing';
  return (
    <div className="relative mt-1 h-4 overflow-hidden rounded-sm bg-surface-2" title={r.kind === 'show' ? `${have} of ${total} aired episodes` : label}>
      <div className={`absolute inset-y-0 left-0 ${color}`} style={{ width: `${total ? Math.max(4, (have / total) * 100) : 100}%` }} />
      <span className="relative block text-center text-[11px] font-medium leading-4 text-text [text-shadow:0_0_3px_rgb(0_0_0/0.8)]">{label}</span>
    </div>
  );
}

function PosterTile({ r, onToggle, onSearch }: { r: OverviewRow; onToggle: () => void; onSearch: () => void }) {
  const src = poster(r.posterPath, 'w342');
  return (
    <div className="group min-w-0">
      <Link to={`/${r.kind === 'movie' ? 'movie' : 'tv'}/${r.tmdbId}`} className="block">
        <div className={`relative aspect-[2/3] overflow-hidden rounded-md border border-border bg-surface-2 ${r.monitored ? '' : 'opacity-60'}`}>
          {src ? <img src={src} alt={r.title} loading="lazy" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center p-2 text-center text-xs text-muted">{r.title}</div>}
        </div>
      </Link>
      <Progress r={r} />
      <div className="mt-0.5 truncate text-[11px] text-muted" title={`${r.monitored ? 'Monitored' : 'Unmonitored'} · ${r.profile ?? 'No profile'}`}>
        {r.monitored ? 'Monitored' : 'Unmonitored'} · {r.profile ?? 'No profile'}
      </div>
      {r.nextAir && <div className="truncate text-[11px] text-text">{airDayLabel(r.nextAir)}</div>}
      <div className="mt-0.5 flex flex-wrap gap-x-2 whitespace-nowrap text-[11px] text-muted">
        <button className="hover:text-accent" onClick={onToggle}>
          {r.monitored ? 'Unmonitor' : 'Monitor'}
        </button>
        {r.monitored && missingSomething(r) && (
          <button className="hover:text-accent" onClick={onSearch}>
            Search
          </button>
        )}
      </div>
    </div>
  );
}

/** Every movie and show Cinemask follows, as a poster grid with what's on disk and what airs next. */
export function MonitoredPage() {
  const [params, setParams] = useSearchParams();
  const kind = params.get('kind') ?? '';
  const state = params.get('state') ?? '';
  const files = params.get('files') ?? '';
  const sort = params.get('sort') ?? 'title';
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
  const rows = (list.data ?? [])
    .filter(
      (r) =>
        (!kind || r.kind === kind) &&
        (!state || (state === 'monitored') === r.monitored) &&
        (!files || (files === 'missing' ? missingSomething(r) : r.status === files)) &&
        (!q || r.title.toLowerCase().includes(q.toLowerCase())),
    )
    // Next airing: soonest first, titles with nothing coming after them.
    .sort((a, b) => (sort === 'next' ? (a.nextAir ?? '9999').localeCompare(b.nextAir ?? '9999') : 0) || a.title.localeCompare(b.title));
  const all = list.data ?? [];
  const counts = { monitored: all.filter((r) => r.monitored).length, unmonitored: all.filter((r) => !r.monitored).length, missing: all.filter((r) => r.monitored && missingSomething(r)).length };

  const run = async (fn: () => Promise<string>) => {
    setMsg(null);
    try {
      setMsg({ kind: 'success', text: await fn() });
      await qc.invalidateQueries({ queryKey: ['monitored-overview'] });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
  };

  // Runs on the server one title at a time; grabs show up on Downloads as they're found.
  const searchMissing = async (kind: MediaKind) => {
    const { titles } = await api<{ titles: number }>('/api/monitored/search-missing', { body: { kind } });
    const what = kind === 'movie' ? 'movie' : 'show';
    return titles ? `Searching ${titles} ${what}${titles === 1 ? '' : 's'} with something missing, one at a time. What's found shows up on Downloads.` : `No monitored ${what}s are missing anything.`;
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
          <select className="input w-auto" value={sort} onChange={(e) => set('sort', e.target.value === 'title' ? '' : e.target.value)} aria-label="Sort">
            <option value="title">Title</option>
            <option value="next">Next airing</option>
          </select>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="btn-secondary" onClick={() => void run(() => searchMissing('show'))}>
          Search all missing episodes
        </button>
        <button className="btn-secondary" onClick={() => void run(() => searchMissing('movie'))}>
          Search all missing movies
        </button>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm bg-success" /> Complete, still airing</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm bg-info" /> Complete (ended, or a movie)</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm bg-danger" /> Missing, monitored</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm bg-warning" /> Missing, unmonitored</span>
      </div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {list.error && <Alert>{(list.error as Error).message}</Alert>}
      {list.data && !list.data.length && <div className="card text-sm text-muted">Nothing is monitored yet. Monitor a title from its page, or import from Radarr and Sonarr in Settings → Imports.</div>}
      {list.data && list.data.length > 0 && !rows.length && <div className="card text-sm text-muted">Nothing matches these filters.</div>}
      <div className="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10">
        {rows.map((r) => (
          <PosterTile
            key={r.id}
            r={r}
            onToggle={() => void run(async () => (await api(`/api/monitored/${r.id}`, { method: 'PATCH', body: { monitored: !r.monitored } }), `${r.title} is ${r.monitored ? 'no longer monitored' : 'monitored'}.`))}
            onSearch={() => void run(async () => (await api<{ message: string }>(`/api/monitored/${r.id}/search`, { body: {} })).message)}
          />
        ))}
      </div>
    </div>
  );
}
