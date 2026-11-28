import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { MediaGrid, MediaRow } from '../components/media';
import { Alert } from '../components/ui';
import { api } from '../lib/api';
import { initials, poster, type MediaCardData } from '../lib/media';
import { t } from '../lib/i18n';

/** A title someone worked on, as a card, with the part they played or their job on it. */
type Credit = MediaCardData & { role: string | null; episodes: number | null };

interface Person {
  id: number;
  name: string;
  biography: string;
  birthday: string | null;
  deathday: string | null;
  placeOfBirth: string | null;
  department: string | null;
  profilePath: string | null;
  imdbId: string | null;
  knownFor: Credit[];
  cast: Credit[];
  crew: Credit[];
}

type Kind = 'all' | 'movie' | 'show';

const fmt = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

/** Whole years between two YYYY-MM-DD dates. */
function age(from: string, to: string) {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  return ty - fy - (tm < fm || (tm === fm && td < fd) ? 1 : 0);
}

const today = () => new Date().toISOString().slice(0, 10);

/** A cast or crew member's page: their bio and everything they're credited on, with what's on the server. */
export function PersonPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['person', id], queryFn: () => api<Person>(`/api/people/${id}`) });
  const [side, setSide] = useState<'cast' | 'crew' | null>(null);
  const [kind, setKind] = useState<Kind>('all');
  const [fullBio, setFullBio] = useState(false);
  if (q.error) return <Alert>{(q.error as Error).message}</Alert>;
  const p = q.data;
  if (!p) return <div className="text-muted">{t('Loading…')}</div>;

  // Acting first for actors; a director's page opens on their crew work.
  const shown = side ?? (p.department !== 'Acting' && p.crew.length ? 'crew' : 'cast');
  const credits = (shown === 'cast' ? p.cast : p.crew).filter((c) => kind === 'all' || c.kind === kind);
  const onServer = (shown === 'cast' ? p.cast : p.crew).filter((c) => c.availability?.status === 'on_server' || c.availability?.status === 'partial').length;
  const longBio = p.biography.length > 600;
  const facts = [
    p.department && [t('Known for'), p.department],
    p.birthday && [t('Born'), `${fmt(p.birthday)}${p.deathday ? '' : ` (${t('age {n}', { n: age(p.birthday, today()) })})`}`],
    p.deathday && [t('Died'), `${fmt(p.deathday)}${p.birthday ? ` (${t('age {n}', { n: age(p.birthday, p.deathday) })})` : ''}`],
    p.placeOfBirth && [t('Birthplace'), p.placeOfBirth],
  ].filter(Boolean) as [string, string][];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-6 sm:flex-row">
        <div className="w-40 shrink-0 self-start overflow-hidden rounded-lg border border-border bg-surface-2 sm:w-52">
          {p.profilePath ? (
            <img src={poster(p.profilePath, 'w500')!} alt={p.name} className="w-full" />
          ) : (
            <div className="flex aspect-[2/3] items-center justify-center text-4xl font-semibold text-muted">{initials(p.name)}</div>
          )}
        </div>
        <div className="min-w-0 space-y-3">
          <h1 className="text-3xl font-bold">{p.name}</h1>
          {facts.length > 0 && (
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {facts.map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-muted">{label}</dt>
                  <dd className="text-sm">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {p.biography ? (
            <div className="max-w-3xl space-y-2">
              <p className={`whitespace-pre-line text-sm leading-relaxed ${longBio && !fullBio ? 'line-clamp-6' : ''}`}>{p.biography}</p>
              {longBio && (
                <button className="text-sm text-accent hover:underline" onClick={() => setFullBio(!fullBio)}>
                  {fullBio ? t('Show less') : t('Read more')}
                </button>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted">{t('TMDB has no biography for this person yet.')}</p>
          )}
          <div className="flex flex-wrap gap-3 text-sm">
            <a className="text-muted hover:text-accent" href={`https://www.themoviedb.org/person/${p.id}`} target="_blank" rel="noreferrer">
              TMDB ↗
            </a>
            {p.imdbId && /^nm\d+$/.test(p.imdbId) && (
              <a className="text-muted hover:text-accent" href={`https://www.imdb.com/name/${p.imdbId}/`} target="_blank" rel="noreferrer">
                IMDb ↗
              </a>
            )}
          </div>
        </div>
      </div>

      <MediaRow title={t('Known for')} items={p.knownFor} />

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{t('Filmography')}</h2>
            <p className="text-xs text-muted">{t('{n} on your server', { n: onServer })}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {p.cast.length > 0 && p.crew.length > 0 && (
              <div className="flex overflow-hidden rounded-md border border-border" role="tablist">
                {(['cast', 'crew'] as const).map((s) => (
                  <button key={s} role="tab" aria-selected={shown === s} onClick={() => setSide(s)} className={`px-3 py-1.5 text-sm ${shown === s ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-muted'}`}>
                    {s === 'cast' ? t('Acting ({n})', { n: p.cast.length }) : t('Crew ({n})', { n: p.crew.length })}
                  </button>
                ))}
              </div>
            )}
            <div className="flex overflow-hidden rounded-md border border-border" role="tablist">
              {(['all', 'movie', 'show'] as const).map((k) => (
                <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)} className={`px-3 py-1.5 text-sm ${kind === k ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-muted'}`}>
                  {k === 'all' ? t('All') : k === 'movie' ? t('Movies') : t('TV')}
                </button>
              ))}
            </div>
          </div>
        </div>
        {credits.length ? (
          <MediaGrid
            items={credits}
            extra={(c) =>
              c.role || c.episodes ? (
                <div className="mt-0.5 text-xs leading-tight text-muted">
                  {c.role}
                  {c.episodes ? `${c.role ? ' · ' : ''}${c.episodes} ep${c.episodes === 1 ? '' : 's'}` : ''}
                </div>
              ) : null
            }
          />
        ) : (
          <p className="text-sm text-muted">{t('Nothing to show here.')}</p>
        )}
      </section>
    </div>
  );
}
