import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { TrailerModal } from '../components/media';
import { Modal } from '../components/Modal';
import { Alert } from '../components/ui';
import { api } from '../lib/api';
import { mediaPath, poster } from '../lib/media';

interface Entry {
  date: string;
  kind: 'movie' | 'show';
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  overview: string | null;
  trailerKey: string | null;
  monitored: boolean;
  releaseType?: 'cinema' | 'digital' | 'physical';
  premiere?: boolean;
  hasFile: boolean;
  episodes?: { season: number; episode: number; title: string | null; hasFile: boolean; marker: Marker | null }[];
}

type Marker = 'series_premiere' | 'season_premiere' | 'season_finale' | 'series_finale';
type View = 'month' | 'week' | 'agenda';
type Only = 'all' | 'premieres' | 'premieres_finales';
type KindFilter = 'all' | 'movie' | 'show';

const MARKER_LABEL: Record<Marker, string> = { series_premiere: 'Series premiere', season_premiere: 'Season premiere', season_finale: 'Season finale', series_finale: 'Series finale' };
const MARKER_SHORT: Record<Marker, string> = { series_premiere: 'NEW', season_premiere: 'PREMIERE', season_finale: 'FINALE', series_finale: 'FINALE' };
const isPremiere = (m: Marker | null) => m === 'series_premiere' || m === 'season_premiere';

/** Keeps what the view asks for; a show's day keeps only its premiere (and finale) episodes. */
function filterEntries(entries: Entry[], only: Only, kind: KindFilter): Entry[] {
  return entries
    .filter((e) => kind === 'all' || e.kind === kind)
    .map((e) => {
      if (only === 'all') return e;
      if (e.kind === 'movie') return e.premiere ? e : null;
      const eps = (e.episodes ?? []).filter((ep) => (only === 'premieres' ? isPremiere(ep.marker) : ep.marker !== null));
      return eps.length ? { ...e, episodes: eps, hasFile: eps.every((ep) => ep.hasFile) } : null;
    })
    .filter((e): e is Entry => e !== null);
}

const RELEASE_LABEL = { cinema: 'In theaters', digital: 'Digital release', physical: 'Disc release' };
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startOfWeek = (d: Date) => addDays(d, -d.getDay());
const todayIso = () => iso(new Date());
const epCode = (e: { season: number; episode: number }) => `S${pad(e.season)}E${pad(e.episode)}`;

/** "Expedition Unknown S05E01 +5" for a show with several episodes on one day. */
export function entryLabel(e: Entry): string {
  if (e.kind === 'movie') return e.title;
  const eps = e.episodes ?? [];
  if (!eps.length) return e.title;
  return eps.length > 1 ? `${e.title} ${epCode(eps[0]!)} +${eps.length - 1}` : `${e.title} ${epCode(eps[0]!)}`;
}

function tone(e: Entry): string {
  if (e.hasFile) return 'border-success/60 bg-success/15';
  // A cinema release can't be downloaded yet, so it never counts as missing.
  if (!e.monitored || e.releaseType === 'cinema') return 'border-border bg-surface-2 text-muted';
  if (e.date < todayIso()) return 'border-danger/60 bg-danger/15';
  return 'border-info/60 bg-info/15';
}

function rangeFor(view: View, anchor: Date): { start: Date; end: Date } {
  if (view === 'month') {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    return { start: startOfWeek(first), end: addDays(startOfWeek(last), 6) };
  }
  if (view === 'week') {
    const s = startOfWeek(anchor);
    return { start: s, end: addDays(s, 6) };
  }
  return { start: anchor, end: addDays(anchor, 30) };
}

function Chip({ e, onClick }: { e: Entry; onClick: () => void }) {
  const eps = e.episodes ?? [];
  // A finale outranks a premiere on the same day only when there's no premiere.
  const marker = eps.find((ep) => isPremiere(ep.marker))?.marker ?? eps.find((ep) => ep.marker)?.marker ?? null;
  return (
    <button onClick={onClick} className={`flex w-full items-center gap-1 rounded border px-1.5 py-0.5 text-left text-xs ${tone(e)}`} title={entryLabel(e)}>
      {e.kind === 'movie' && <span className="shrink-0 opacity-70">{e.releaseType === 'cinema' ? '🎬' : e.releaseType === 'physical' ? '💿' : '📺'}</span>}
      <span className="min-w-0 truncate">{e.kind === 'show' && eps.length ? `${e.title} ${epCode(eps[0]!)}` : e.title}</span>
      {marker && (
        <span className={`shrink-0 rounded px-1 text-[10px] font-bold ${isPremiere(marker) ? 'bg-accent text-accent-fg' : 'bg-warning text-black'}`} title={MARKER_LABEL[marker]}>
          {MARKER_SHORT[marker]}
        </span>
      )}
      {e.kind === 'movie' && e.premiere && e.releaseType !== 'cinema' && (
        <span className="shrink-0 rounded bg-accent px-1 text-[10px] font-bold text-accent-fg" title="First release">
          PREMIERE
        </span>
      )}
      {/* The "+5" stays visible however narrow the cell is. */}
      {eps.length > 1 && <span className="ml-auto shrink-0 rounded bg-black/30 px-1 font-semibold">+{eps.length - 1}</span>}
    </button>
  );
}

function Details({ e, onClose }: { e: Entry; onClose: () => void }) {
  const [trailer, setTrailer] = useState(false);
  const img = poster(e.posterPath, 'w185');
  return (
    <Modal title={e.title} onClose={onClose}>
      <div className="flex gap-4">
        {img && <img src={img} alt="" className="w-24 shrink-0 self-start rounded border border-border" />}
        <div className="min-w-0 space-y-2 text-sm">
          <div className="text-muted">
            {new Date(`${e.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            {e.releaseType && ` · ${RELEASE_LABEL[e.releaseType]}`}
          </div>
          {e.episodes && (
            <ul className="space-y-0.5">
              {e.episodes.map((ep) => (
                <li key={epCode(ep)} className="flex justify-between gap-2">
                  <span>
                    <span className="text-muted">{epCode(ep)}</span> {ep.title}
                    {ep.marker && <span className={`ml-2 rounded px-1 text-[10px] font-bold ${isPremiere(ep.marker) ? 'bg-accent text-accent-fg' : 'bg-warning text-black'}`}>{MARKER_LABEL[ep.marker]}</span>}
                  </span>
                  <span className={ep.hasFile ? 'text-success' : 'text-muted'}>{ep.hasFile ? 'Downloaded' : e.date > todayIso() ? 'Upcoming' : 'Missing'}</span>
                </li>
              ))}
            </ul>
          )}
          {e.kind === 'movie' && <div className={e.hasFile ? 'text-success' : 'text-muted'}>{e.hasFile ? 'Downloaded' : e.monitored ? 'Monitored' : 'Not monitored'}</div>}
          {e.overview && <p className="line-clamp-5 text-muted">{e.overview}</p>}
          <div className="flex flex-wrap gap-2 pt-1">
            {e.trailerKey && (
              <button className="btn-secondary" onClick={() => setTrailer(true)}>
                ▶ Trailer
              </button>
            )}
            <Link className="btn-primary" to={mediaPath(e.kind, e.tmdbId)} onClick={onClose}>
              Details
            </Link>
          </div>
        </div>
      </div>
      {trailer && e.trailerKey && <TrailerModal videoKey={e.trailerKey} onClose={() => setTrailer(false)} />}
    </Modal>
  );
}

export function CalendarPage() {
  const [view, setView] = useState<View>(() => (typeof window !== 'undefined' && window.innerWidth < 768 ? 'agenda' : 'month'));
  const [anchor, setAnchor] = useState(() => new Date());
  const [selected, setSelected] = useState<Entry | null>(null);
  const [only, setOnly] = useState<Only>(() => {
    try {
      return (localStorage.getItem('calendar-only') as Only | null) ?? 'all';
    } catch {
      return 'all';
    }
  });
  const [kind, setKind] = useState<KindFilter>('all');
  const pickOnly = (v: Only) => {
    setOnly(v);
    try {
      localStorage.setItem('calendar-only', v);
    } catch {
      // private mode: the choice just isn't remembered
    }
  };
  const { start, end } = rangeFor(view, anchor);
  const q = useQuery({ queryKey: ['calendar', iso(start), iso(end)], queryFn: () => api<Entry[]>(`/api/calendar?start=${iso(start)}&end=${iso(end)}`) });
  const byDate = new Map<string, Entry[]>();
  const shown = filterEntries(q.data ?? [], only, kind);
  for (const e of shown) byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);

  const step = (dir: -1 | 1) => {
    if (view === 'month') setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1));
    else setAnchor(addDays(anchor, dir * (view === 'week' ? 7 : 30)));
  };
  const title =
    view === 'month'
      ? anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
      : `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const days: Date[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  const today = todayIso();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Calendar</h1>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-border" role="tablist">
            {(['month', 'week', 'agenda'] as View[]).map((v) => (
              <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)} className={`px-3 py-1.5 text-sm capitalize ${view === v ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-muted'}`}>
                {v}
              </button>
            ))}
          </div>
          <select className="input w-auto" value={only} onChange={(e) => pickOnly(e.target.value as Only)} aria-label="Show">
            <option value="all">Everything</option>
            <option value="premieres">Premieres only</option>
            <option value="premieres_finales">Premieres and finales</option>
          </select>
          <select className="input w-auto" value={kind} onChange={(e) => setKind(e.target.value as KindFilter)} aria-label="Type">
            <option value="all">Movies and shows</option>
            <option value="movie">Movies</option>
            <option value="show">Shows</option>
          </select>
          <button className="btn-secondary" onClick={() => step(-1)} aria-label="Previous">
            ‹
          </button>
          <button className="btn-secondary" onClick={() => setAnchor(new Date())}>
            Today
          </button>
          <button className="btn-secondary" onClick={() => step(1)} aria-label="Next">
            ›
          </button>
        </div>
      </div>
      <div className="text-lg font-medium">{title}</div>
      {q.error && <Alert>{(q.error as Error).message}</Alert>}

      {view === 'agenda' ? (
        <div className="space-y-4">
          {days
            .filter((d) => byDate.has(iso(d)))
            .map((d) => (
              <section key={iso(d)}>
                <h2 className={`mb-1 text-sm font-semibold ${iso(d) === today ? 'text-accent' : 'text-muted'}`}>{d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</h2>
                <div className="space-y-1">
                  {byDate.get(iso(d))!.map((e) => (
                    <Chip key={`${e.kind}-${e.tmdbId}-${e.releaseType ?? ''}`} e={e} onClick={() => setSelected(e)} />
                  ))}
                </div>
              </section>
            ))}
          {q.data && !shown.length && <p className="text-muted">{only === 'all' ? 'Nothing monitored is coming out in the next 30 days.' : 'No premieres in the next 30 days.'}</p>}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="grid min-w-[700px] grid-cols-7 gap-px overflow-hidden rounded-lg border border-border bg-border">
            {days.slice(0, 7).map((d) => (
              <div key={`h${iso(d)}`} className="bg-surface px-2 py-1 text-xs font-medium text-muted">
                {d.toLocaleDateString(undefined, { weekday: 'short' })}
              </div>
            ))}
            {days.map((d) => {
              const key = iso(d);
              const outside = view === 'month' && d.getMonth() !== anchor.getMonth();
              return (
                <div key={key} className={`space-y-1 bg-surface p-1.5 ${view === 'week' ? 'min-h-64' : 'min-h-24'} ${outside ? 'opacity-40' : ''}`}>
                  <div className={`text-xs ${key === today ? 'inline-block rounded-full bg-accent px-1.5 font-semibold text-accent-fg' : 'text-muted'}`}>{d.getDate()}</div>
                  {(byDate.get(key) ?? []).map((e) => (
                    <Chip key={`${e.kind}-${e.tmdbId}-${e.releaseType ?? ''}`} e={e} onClick={() => setSelected(e)} />
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-3 text-xs text-muted">
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-sm bg-success/60" /> Downloaded
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-sm bg-info/60" /> Upcoming
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-sm bg-danger/60" /> Missing
        </span>
        <span>🎬 theaters · 📺 digital · 💿 disc</span>
        <span className="flex items-center gap-1">
          <span className="rounded bg-accent px-1 text-[10px] font-bold text-accent-fg">NEW</span> series premiere
          <span className="rounded bg-accent px-1 text-[10px] font-bold text-accent-fg">PREMIERE</span> season premiere
          <span className="rounded bg-warning px-1 text-[10px] font-bold text-black">FINALE</span> season or series finale
        </span>
      </div>
      {selected && <Details e={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
