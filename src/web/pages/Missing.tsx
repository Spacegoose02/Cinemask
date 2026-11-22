import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert } from '../components/ui';
import { api } from '../lib/api';
import { poster, type MediaKind } from '../lib/media';

interface MissingEpisode {
  season: number;
  episode: number;
  title: string | null;
  airDate: string;
}

interface MissingShow {
  id: number;
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  profile: string | null;
  aired: number;
  episodes: MissingEpisode[];
}

interface MissingMovie {
  id: number;
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  profile: string | null;
  released: string | null;
}

/** How many shows or movies are drawn before "Show more", so a big backlog stays quick. */
const PAGE = 50;

const pad = (n: number) => String(n).padStart(2, '0');
const code = (e: { season: number; episode: number }) => `S${pad(e.season)}E${pad(e.episode)}`;
const date = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

type Msg = { kind: 'error' | 'success'; text: string } | null;

function Thumb({ path, title }: { path: string | null; title: string }) {
  const src = poster(path, 'w185');
  return (
    <div className="aspect-[2/3] w-12 shrink-0 overflow-hidden rounded border border-border bg-surface-2">
      {src && <img src={src} alt={title} loading="lazy" decoding="async" className="h-full w-full object-cover" />}
    </div>
  );
}

function SearchButton({ label, busy, onClick, primary }: { label: string; busy: boolean; onClick: () => void; primary?: boolean }) {
  return (
    <button className={`${primary ? 'btn-secondary' : 'text-xs text-muted hover:text-accent'} disabled:opacity-50`} disabled={busy} onClick={onClick}>
      {busy ? 'Searching…' : label}
    </button>
  );
}

function ShowCard({ s, open, toggle, search, busy }: { s: MissingShow; open: boolean; toggle: () => void; search: (key: string, body: object) => void; busy: (key: string) => boolean }) {
  const seasons = new Map<number, MissingEpisode[]>();
  for (const e of s.episodes) seasons.set(e.season, [...(seasons.get(e.season) ?? []), e]);
  const sorted = [...seasons.entries()].sort((a, b) => b[0] - a[0]);
  const n = s.episodes.length;
  return (
    <div className="card space-y-2 p-3" style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 90px' }}>
      <div className="flex items-center gap-3">
        <Thumb path={s.posterPath} title={s.title} />
        <div className="min-w-0 flex-1">
          <Link to={`/tv/${s.tmdbId}`} className="block truncate font-medium hover:text-accent">
            {s.title} {s.year && <span className="text-muted">({s.year})</span>}
          </Link>
          <div className="text-sm text-muted">
            <span className="text-danger">{n} missing</span> of {s.aired} aired episode{s.aired === 1 ? '' : 's'}
            {s.profile && ` · ${s.profile}`}
          </div>
          <div className="text-xs text-muted">Latest missing: {code(s.episodes[0]!)} · {date(s.episodes[0]!.airDate)}</div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-3">
          <button className="text-sm text-muted hover:text-accent" onClick={toggle} aria-expanded={open}>
            {open ? 'Hide episodes' : `Show episode${n === 1 ? '' : 's'}`}
          </button>
          <SearchButton primary label="Search" busy={busy(`show:${s.id}`)} onClick={() => search(`show:${s.id}`, { missingOnly: true })} />
        </div>
      </div>
      {open && (
        <div className="space-y-3 border-t border-border pt-2">
          {sorted.map(([season, eps]) => (
            <div key={season}>
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">
                  {season === 0 ? 'Specials' : `Season ${season}`} <span className="text-muted">· {eps.length} missing</span>
                </div>
                <SearchButton label="Search season" busy={busy(`season:${s.id}:${season}`)} onClick={() => search(`season:${s.id}:${season}`, { season, missingOnly: true })} />
              </div>
              <ul className="mt-1 divide-y divide-border text-sm">
                {eps.map((e) => (
                  <li key={code(e)} className="flex items-center gap-3 py-1">
                    <span className="w-16 shrink-0 font-mono text-xs text-muted">{code(e)}</span>
                    <span className="min-w-0 flex-1 truncate">{e.title ?? `Episode ${e.episode}`}</span>
                    <span className="shrink-0 text-xs text-muted">{date(e.airDate)}</span>
                    <SearchButton label="Search" busy={busy(`ep:${s.id}:${code(e)}`)} onClick={() => search(`ep:${s.id}:${code(e)}`, { season: e.season, episode: e.episode })} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Wanted → Missing, as in Sonarr and Radarr: monitored episodes that have aired and monitored movies
 * that are out, with no file here or on a media server. Search one episode, a season, a show, or all.
 */
export function MissingPage() {
  const [params, setParams] = useSearchParams();
  const tab: MediaKind = params.get('tab') === 'movies' ? 'movie' : 'show';
  const q = (params.get('q') ?? '').toLowerCase();
  const [msg, setMsg] = useState<Msg>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(PAGE);
  const list = useQuery({ queryKey: ['monitored-missing'], queryFn: () => api<{ shows: MissingShow[]; movies: MissingMovie[] }>('/api/monitored/missing') });

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
    setLimit(PAGE);
  };
  const shows = (list.data?.shows ?? []).filter((s) => !q || s.title.toLowerCase().includes(q));
  const movies = (list.data?.movies ?? []).filter((m) => !q || m.title.toLowerCase().includes(q));
  const episodeCount = (list.data?.shows ?? []).reduce((n, s) => n + s.episodes.length, 0);

  const run = async (key: string, fn: () => Promise<string>) => {
    setMsg(null);
    setRunning((r) => new Set(r).add(key));
    try {
      setMsg({ kind: 'success', text: await fn() });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setRunning((r) => {
        const next = new Set(r);
        next.delete(key);
        return next;
      });
    }
  };
  const busy = (key: string) => running.has(key);
  // A search grabs what it finds; the list updates once downloads are imported.
  const searchTitle = (id: number) => (key: string, body: object) =>
    void run(key, async () => (await api<{ message: string }>(`/api/monitored/${id}/search`, { body })).message);
  const searchAll = () =>
    void run(`all:${tab}`, async () => {
      const { titles } = await api<{ titles: number }>('/api/monitored/search-missing', { body: { kind: tab } });
      const what = tab === 'movie' ? 'movie' : 'show';
      return titles ? `Searching ${titles} ${what}${titles === 1 ? '' : 's'}, one at a time. What's found shows up on Downloads.` : `No monitored ${what}s are missing anything.`;
    });

  const shown = tab === 'show' ? shows.length : movies.length;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Missing</h1>
          <p className="text-sm text-muted">Monitored episodes that have aired and monitored movies that are out, with no file on disk or on your media servers.</p>
        </div>
        <input className="input w-44" placeholder="Filter by title" defaultValue={params.get('q') ?? ''} onChange={(e) => set('q', e.target.value)} aria-label="Filter by title" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1" role="tablist">
          {(
            [
              ['show', '', `TV · ${episodeCount} episode${episodeCount === 1 ? '' : 's'} in ${list.data?.shows.length ?? 0} show${list.data?.shows.length === 1 ? '' : 's'}`],
              ['movie', 'movies', `Movies · ${list.data?.movies.length ?? 0}`],
            ] as const
          ).map(([k, value, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'btn-primary' : 'btn-secondary'} onClick={() => set('tab', value)}>
              {list.data ? label : k === 'show' ? 'TV' : 'Movies'}
            </button>
          ))}
        </div>
        <SearchButton primary label={tab === 'show' ? 'Search all missing episodes' : 'Search all missing movies'} busy={busy(`all:${tab}`)} onClick={searchAll} />
      </div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {list.error && <Alert>{(list.error as Error).message}</Alert>}
      {list.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {list.data && !shown && (
        <div className="card text-sm text-muted">
          {q ? 'Nothing missing matches this filter.' : tab === 'show' ? 'Every monitored episode that has aired is on disk or on a media server.' : 'Every monitored movie that is out is on disk or on a media server.'}
        </div>
      )}
      {tab === 'show' && (
        <div className="space-y-2">
          {shows.slice(0, limit).map((s) => (
            <ShowCard
              key={s.id}
              s={s}
              open={open.has(s.id)}
              toggle={() =>
                setOpen((o) => {
                  const next = new Set(o);
                  if (next.has(s.id)) next.delete(s.id);
                  else next.add(s.id);
                  return next;
                })
              }
              search={searchTitle(s.id)}
              busy={busy}
            />
          ))}
        </div>
      )}
      {tab === 'movie' && (
        <div className="space-y-2">
          {movies.slice(0, limit).map((m) => (
            <div key={m.id} className="card flex items-center gap-3 p-3" style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 90px' }}>
              <Thumb path={m.posterPath} title={m.title} />
              <div className="min-w-0 flex-1">
                <Link to={`/movie/${m.tmdbId}`} className="block truncate font-medium hover:text-accent">
                  {m.title} {m.year && <span className="text-muted">({m.year})</span>}
                </Link>
                <div className="text-sm text-muted">
                  {m.released ? `Out since ${date(m.released)}` : 'Released'}
                  {m.profile && ` · ${m.profile}`}
                </div>
              </div>
              <SearchButton primary label="Search" busy={busy(`movie:${m.id}`)} onClick={() => searchTitle(m.id)(`movie:${m.id}`, { missingOnly: true })} />
            </div>
          ))}
        </div>
      )}
      {shown > limit && (
        <button className="btn-secondary w-full" onClick={() => setLimit((l) => l + PAGE)}>
          Show more ({shown - limit} left)
        </button>
      )}
    </div>
  );
}
