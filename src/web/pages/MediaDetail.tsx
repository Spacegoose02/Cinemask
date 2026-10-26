import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { StatusBadge, TrailerModal } from '../components/media';
import { Alert } from '../components/ui';
import { api } from '../lib/api';
import { poster, type AvailabilityInfo, type MediaKind } from '../lib/media';

export interface MediaDetail {
  kind: MediaKind;
  tmdbId: number;
  title: string;
  year: number | null;
  overview: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  releaseDate: string | null;
  digitalRelease: string | null;
  physicalRelease: string | null;
  nextAirDate: string | null;
  tmdbStatus: string | null;
  runtime: number | null;
  genres: string[];
  network: string | null;
  rating: number | null;
  trailerKey: string | null;
  imdbId: string | null;
  released: boolean;
  availability: AvailabilityInfo;
  seasons: { seasonNumber: number; name: string; episodeCount: number; airDate: string | null; onServer: number }[];
  collection: { id: number; name: string } | null;
  /** Main cast from TMDB, in billing order. */
  cast: { id: number; name: string; character: string; profilePath: string | null; episodes?: number }[];
  ratings: { source: string; value: number | null }[];
  /** Plays on Plex/Jellyfin, null when the title isn't on a server. */
  watch: { viewCount: number; lastViewedAt: number | null } | null;
}

/** "Meg Ryan" → "MR", for people TMDB has no photo of. */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .slice(0, 2)
    .join('');

interface Season {
  episodes: { episodeNumber: number; name: string; airDate: string | null; overview: string; onServer: boolean; resolution: string | null; runtime: number | null; viewCount: number | null }[];
}

const fmt = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null);

function SeasonRow({ tmdbId, season }: { tmdbId: number; season: MediaDetail['seasons'][number] }) {
  const [open, setOpen] = useState(false);
  const eps = useQuery({ queryKey: ['season', tmdbId, season.seasonNumber], queryFn: () => api<Season>(`/api/media/show/${tmdbId}/season/${season.seasonNumber}`), enabled: open });
  const complete = season.onServer >= season.episodeCount && season.episodeCount > 0;
  return (
    <li className="border-b border-border last:border-0">
      <button className="flex w-full items-center justify-between gap-3 py-3 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="font-medium">{season.name}</span>
        <span className={`text-sm ${complete ? 'text-success' : 'text-muted'}`}>
          {season.onServer} / {season.episodeCount} on server
        </span>
      </button>
      {open && (
        <ul className="space-y-1 pb-3 text-sm">
          {eps.data?.episodes.map((e) => (
            <li key={e.episodeNumber} className="flex items-center justify-between gap-3 rounded px-2 py-1.5 hover:bg-surface-2">
              <span className="min-w-0 truncate">
                <span className="text-muted">E{String(e.episodeNumber).padStart(2, '0')}</span> {e.name}
                {e.airDate && <span className="ml-2 text-xs text-muted">{fmt(e.airDate)}</span>}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {e.viewCount ? (
                  <span className="text-xs text-success" title={`Played ${e.viewCount} ${e.viewCount === 1 ? 'time' : 'times'}`}>
                    ✓ Watched
                  </span>
                ) : null}
                <StatusBadge status={e.onServer ? 'on_server' : e.airDate && e.airDate <= new Date().toISOString().slice(0, 10) ? 'not_on_server' : 'not_available'} resolution={e.resolution} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function watchText(kind: MediaKind, w: NonNullable<MediaDetail['watch']>): string {
  const last = w.lastViewedAt ? new Date(w.lastViewedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null;
  if (w.viewCount) return `${w.viewCount === 1 ? 'Once' : `${w.viewCount} times`}${last ? `, last on ${last}` : ''}`;
  if (last) return kind === 'show' ? `Partly, last on ${last}` : `Last on ${last}`;
  return 'Not yet';
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  if (!children) return null;
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export function MediaDetailPage({ kind, actions, panels }: { kind: MediaKind; actions?: (m: MediaDetail) => ReactNode; panels?: (m: MediaDetail) => ReactNode }) {
  const { tmdbId } = useParams();
  const [trailer, setTrailer] = useState<'online' | number | null>(null);
  const q = useQuery({ queryKey: ['media', kind, tmdbId], queryFn: () => api<MediaDetail>(`/api/media/${kind}/${tmdbId}`) });
  // Trailer files already next to the title on the server play right here, no YouTube needed.
  const local = useQuery({ queryKey: ['local-trailers', kind, tmdbId], queryFn: () => api<{ index: number; name: string }[]>(`/api/trailers/${kind}/${tmdbId}`) });
  if (q.error) return <Alert>{(q.error as Error).message}</Alert>;
  const m = q.data;
  if (!m) return <div className="text-muted">Loading…</div>;
  const backdrop = poster(m.backdropPath, 'w780');

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-xl border border-border">
        {backdrop && <img src={backdrop} alt="" className="absolute inset-0 h-full w-full object-cover opacity-25" />}
        <div className="relative flex flex-col gap-6 p-5 sm:flex-row md:p-8">
          <div className="w-40 shrink-0 self-start overflow-hidden rounded-lg border border-border bg-surface-2 sm:w-52">
            {m.posterPath ? <img src={poster(m.posterPath, 'w500')!} alt={`${m.title} poster`} className="w-full" /> : <div className="aspect-[2/3]" />}
          </div>
          <div className="min-w-0 space-y-3">
            <div>
              <h1 className="text-3xl font-bold">
                {m.title} {m.year && <span className="font-normal text-muted">({m.year})</span>}
              </h1>
              <div className="mt-1 text-sm text-muted">{[kind === 'movie' ? 'Movie' : 'Series', m.genres.join(', '), m.runtime ? `${m.runtime} min` : null, m.network].filter(Boolean).join(' · ')}</div>
            </div>
            <StatusBadge status={m.availability.status} resolution={m.availability.resolution} />
            {m.overview && <p className="max-w-3xl text-sm leading-relaxed">{m.overview}</p>}
            <div className="flex flex-wrap gap-2">
              {(local.data?.length || m.trailerKey) && (
                // One button for everyone: a trailer file on the server first, YouTube when there isn't one.
                <button className="btn-secondary" onClick={() => setTrailer(local.data?.length ? 0 : 'online')}>
                  ▶ Watch trailer
                </button>
              )}
              {actions?.(m)}
            </div>
            <dl className="grid grid-cols-2 gap-3 pt-2 sm:grid-cols-4">
              <Fact label={kind === 'movie' ? 'In theaters' : 'First aired'}>{fmt(m.releaseDate)}</Fact>
              {kind === 'movie' && <Fact label="Streaming / digital">{fmt(m.digitalRelease)}</Fact>}
              {kind === 'movie' && <Fact label="Disc">{fmt(m.physicalRelease)}</Fact>}
              {kind === 'show' && <Fact label="Next episode">{fmt(m.nextAirDate)}</Fact>}
              <Fact label="Status">{m.tmdbStatus}</Fact>
              <Fact label="TMDB rating">{m.rating ? m.rating.toFixed(1) : null}</Fact>
              {m.ratings.map((r) => (
                <Fact key={r.source} label={r.source}>
                  {r.value}
                </Fact>
              ))}
              {m.watch && <Fact label="Watched">{watchText(m.kind, m.watch)}</Fact>}
              <Fact label="On">{m.availability.servers.map((s) => (s === 'plex' ? 'Plex' : 'Jellyfin')).join(', ')}</Fact>
            </dl>
          </div>
        </div>
      </div>

      {m.cast.length > 0 && (
        <section className="card">
          <h2 className="mb-3 font-semibold">Cast</h2>
          <ul className="flex gap-3 overflow-x-auto pb-2">
            {m.cast.map((c) => (
              <li key={c.id} className="w-28 shrink-0">
                <div className="aspect-[2/3] overflow-hidden rounded-md border border-border bg-surface-2">
                  {c.profilePath ? (
                    <img src={poster(c.profilePath, 'w185')!} alt="" loading="lazy" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-2xl font-semibold text-muted">{initials(c.name)}</div>
                  )}
                </div>
                <div className="mt-1.5 text-sm font-medium leading-tight">{c.name}</div>
                {c.character && <div className="text-xs leading-tight text-muted">{c.character}</div>}
                {c.episodes ? <div className="text-xs text-muted">{c.episodes} episode{c.episodes === 1 ? '' : 's'}</div> : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {kind === 'show' && m.seasons.length > 0 && (
        <section className="card">
          <h2 className="mb-2 font-semibold">Seasons</h2>
          <ul>
            {m.seasons
              .filter((s) => s.seasonNumber > 0 || s.onServer > 0)
              .map((s) => (
                <SeasonRow key={s.seasonNumber} tmdbId={m.tmdbId} season={s} />
              ))}
          </ul>
        </section>
      )}
      {panels?.(m)}
      {trailer === 'online' && m.trailerKey && <TrailerModal videoKey={m.trailerKey} onClose={() => setTrailer(null)} />}
      {typeof trailer === 'number' && <TrailerModal src={`/api/trailers/${kind}/${m.tmdbId}/${trailer}`} onClose={() => setTrailer(null)} />}
    </div>
  );
}
