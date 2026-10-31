import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Stars } from '../components/FamilyPanel';
import { Alert } from '../components/ui';
import { api } from '../lib/api';
import { mediaPath, poster, type MediaKind } from '../lib/media';

interface Badge {
  id: string;
  name: string;
  emoji: string;
  description: string;
  progress: number;
  target: number;
  earned: boolean;
}

interface Wrapped {
  year: number;
  month: number | null;
  you: {
    requests: number;
    requestsReady: number;
    ratings: number;
    reviews: number;
    averageStars: number | null;
    favorite: { kind: MediaKind; tmdbId: number; title: string; year: number | null; posterPath: string | null; stars: number } | null;
    nightsHosted: number;
    nightsAttended: number;
    rounds: number;
    correct: number;
    perfectRounds: number;
    persona: { name: string; blurb: string; genre: string | null };
    streak: { current: number; best: number };
  };
  household: {
    movies: number;
    shows: number;
    episodes: number;
    hours: number;
    topGenres: { genre: string; count: number }[];
    topShow: { kind: MediaKind; tmdbId: number | null; title: string; posterPath: string | null; episodes: number } | null;
    busiestMonth: string | null;
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function Stat({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 p-4">
      <div className="text-3xl font-bold text-accent">{value}</div>
      <div className="text-sm text-muted">{label}</div>
    </div>
  );
}

function Poster({ path, title, to, children }: { path: string | null; title: string; to: string | null; children?: ReactNode }) {
  const img = poster(path, 'w185');
  const body = (
    <div className="flex items-center gap-4">
      <div className="w-20 shrink-0 overflow-hidden rounded-md border border-border bg-surface-2">{img ? <img src={img} alt="" className="w-full" /> : <div className="aspect-[2/3]" />}</div>
      <div>
        <div className="text-lg font-semibold">{title}</div>
        {children}
      </div>
    </div>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

export function BadgeGrid({ badges }: { badges: Badge[] }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {badges.map((b) => (
        <li key={b.id} className={`rounded-lg border p-3 ${b.earned ? 'border-accent bg-surface-2' : 'border-border opacity-60'}`} title={b.description}>
          <div className={`text-3xl ${b.earned ? '' : 'grayscale'}`}>{b.emoji}</div>
          <div className="mt-1 text-sm font-semibold">{b.name}</div>
          <div className="text-xs text-muted">{b.description}</div>
          {!b.earned && b.target > 1 && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-label={`${b.progress} of ${b.target}`}>
              <div className="h-full bg-accent" style={{ width: `${(b.progress / b.target) * 100}%` }} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function WrappedPage() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState<number | ''>('');
  const q = useQuery({ queryKey: ['wrapped', year, month], queryFn: () => api<Wrapped>(`/api/wrapped?year=${year}${month ? `&month=${month}` : ''}`) });
  const badges = useQuery({ queryKey: ['badges'], queryFn: () => api<{ badges: Badge[] }>('/api/badges') });
  const w = q.data;
  const period = month ? `${MONTHS[month - 1]} ${year}` : String(year);
  const years = Array.from({ length: 5 }, (_, n) => now.getFullYear() - n);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Cinemask Wrapped</h1>
          <p className="text-sm text-muted">Your {period} in movies, shows and popcorn.</p>
        </div>
        <div className="flex gap-2">
          <select className="input w-auto" value={month} onChange={(e) => setMonth(e.target.value ? Number(e.target.value) : '')} aria-label="Month">
            <option value="">Whole year</option>
            {MONTHS.map((m, n) => (
              <option key={m} value={n + 1}>
                {m}
              </option>
            ))}
          </select>
          <select className="input w-auto" value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Year">
            {years.map((y) => (
              <option key={y}>{y}</option>
            ))}
          </select>
        </div>
      </div>
      {q.error && <Alert>{(q.error as Error).message}</Alert>}
      {w && (
        <>
          <section className="relative overflow-hidden rounded-xl border border-accent/60 bg-surface p-6 md:p-10">
            <img src="/hero.png" alt="" className="pointer-events-none absolute -right-10 bottom-0 hidden h-full opacity-30 md:block" />
            <div className="relative max-w-xl space-y-2">
              <div className="text-xs uppercase tracking-wider text-accent">Your raccoon persona</div>
              <h2 className="text-3xl font-bold md:text-4xl">{w.you.persona.name}</h2>
              <p className="text-lg">{w.you.persona.blurb}</p>
              {w.you.persona.genre && <p className="text-sm text-muted">Because you can't get enough {w.you.persona.genre.toLowerCase()}.</p>}
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">You</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat value={w.you.requests} label={`requests (${w.you.requestsReady} now on the server)`} />
              <Stat value={w.you.ratings} label={w.you.averageStars ? `titles rated, ${w.you.averageStars}★ on average` : 'titles rated'} />
              <Stat value={w.you.nightsAttended} label={`${w.you.nightsAttended === 1 ? 'movie night' : 'movie nights'} (${w.you.nightsHosted} hosted)`} />
              <Stat value={w.you.correct} label={`game points over ${plural(w.you.rounds, 'round')}`} />
            </div>
            {w.you.favorite && (
              <div className="card">
                <div className="mb-2 text-xs uppercase tracking-wider text-muted">Your top pick</div>
                <Poster path={w.you.favorite.posterPath} title={w.you.favorite.title} to={mediaPath(w.you.favorite.kind, w.you.favorite.tmdbId)}>
                  <Stars value={w.you.favorite.stars} />
                </Poster>
              </div>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">The household</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat value={w.household.hours} label="hours watched" />
              <Stat value={w.household.movies} label="movies" />
              <Stat value={w.household.episodes} label={`episodes across ${plural(w.household.shows, 'show')}`} />
              <Stat value={w.household.busiestMonth ?? '–'} label="busiest month" />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {w.household.topShow && (
                <div className="card">
                  <div className="mb-2 text-xs uppercase tracking-wider text-muted">Most binged</div>
                  <Poster path={w.household.topShow.posterPath} title={w.household.topShow.title} to={w.household.topShow.tmdbId ? mediaPath('show', w.household.topShow.tmdbId) : null}>
                    <div className="text-sm text-muted">{w.household.topShow.episodes} episodes</div>
                  </Poster>
                </div>
              )}
              {w.household.topGenres.length > 0 && (
                <div className="card">
                  <div className="mb-2 text-xs uppercase tracking-wider text-muted">Top genres</div>
                  <ol className="space-y-1.5">
                    {w.household.topGenres.map((g) => (
                      <li key={g.genre} className="flex items-center gap-2 text-sm">
                        <span className="w-32 shrink-0 truncate">{g.genre}</span>
                        <span className="flex-1">
                          <span className="block h-2 rounded-full bg-accent" style={{ width: `${(g.count / w.household.topGenres[0]!.count) * 100}%` }} />
                        </span>
                        <span className="text-muted">{g.count}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
            <p className="hint">Watch counts come from your media servers, which only remember each title's latest play, so the real numbers are probably higher.</p>
          </section>
        </>
      )}

      {badges.data && (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold">Badges</h2>
            <span className="text-sm text-muted">
              {badges.data.badges.filter((b) => b.earned).length} of {badges.data.badges.length} earned
              {w && w.you.streak.current > 0 && ` · 🔥 ${w.you.streak.current}-day game streak`}
            </span>
          </div>
          <BadgeGrid badges={badges.data.badges} />
        </section>
      )}
    </div>
  );
}
