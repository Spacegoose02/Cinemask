import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, hasRole } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { MediaDetail } from '../pages/MediaDetail';
import { Modal } from './Modal';
import { Alert, Field } from './ui';

interface TitleRatings {
  family: { average: number; count: number } | null;
  mine: { stars: number; review: string | null } | null;
  ratings: { userId: number; name: string; stars: number; review: string | null; updatedAt: number }[];
}

/** Five stars; read-only unless onChange is given. */
export function Stars({ value, onChange, size = 'text-xl' }: { value: number; onChange?: (n: number) => void; size?: string }) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  return (
    <span className={`inline-flex ${size} leading-none`} onMouseLeave={() => setHover(0)} role={onChange ? 'radiogroup' : 'img'} aria-label={onChange ? 'Your rating' : `${value} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) =>
        onChange ? (
          <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} star${n === 1 ? '' : 's'}`} className={n <= shown ? 'text-accent' : 'text-muted/40'} onMouseEnter={() => setHover(n)} onClick={() => onChange(n)}>
            ★
          </button>
        ) : (
          <span key={n} className={n <= Math.round(shown) ? 'text-accent' : 'text-muted/40'}>
            ★
          </span>
        ),
      )}
    </span>
  );
}

/** A datetime-local value for tonight at 8pm, or tomorrow's if that's less than half an hour away. */
function tonight() {
  const d = new Date();
  d.setHours(20, 0, 0, 0);
  if (d.getTime() - Date.now() < 30 * 60 * 1000) d.setDate(d.getDate() + 1);
  return toLocalInput(d.getTime());
}
export const toLocalInput = (ms: number) => {
  const d = new Date(ms);
  return new Date(ms - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

export function PlanNight({ m, onClose }: { m: { kind: MediaDetail['kind']; tmdbId: number; title: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const [at, setAt] = useState(tonight);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const save = async () => {
    setError('');
    try {
      await api('/api/movie-nights', { body: { kind: m.kind, tmdbId: m.tmdbId, startsAt: new Date(at).getTime(), note: note || null } });
      await qc.invalidateQueries({ queryKey: ['movie-nights'] });
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title={`Plan a movie night: ${m.title}`} onClose={onClose}>
      {done ? (
        <div className="space-y-3">
          <Alert kind="success">It's on the calendar. Everyone can RSVP on the movie nights page.</Alert>
          <Link to="/movie-nights" className="btn-primary">
            See movie nights
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          <Field label="When">
            <input type="datetime-local" className="input" value={at} onChange={(e) => setAt(e.target.value)} />
          </Field>
          <Field label="Note (optional)">
            <input className="input" maxLength={500} placeholder="Pizza at 7, film at 8" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {error && <Alert>{error}</Alert>}
          <button className="btn-primary" onClick={save} disabled={!at}>
            Plan it
          </button>
        </div>
      )}
    </Modal>
  );
}

function MyRating({ mine, onSave, onRemove }: { mine: TitleRatings['mine']; onSave: (stars: number, review: string) => void; onRemove: () => void }) {
  const [stars, setStars] = useState(mine?.stars ?? 0);
  const [review, setReview] = useState(mine?.review ?? '');
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted">Your rating</span>
        <Stars
          value={stars}
          onChange={(n) => {
            setStars(n);
            onSave(n, review);
          }}
        />
        {mine && (
          <button className="text-xs text-muted hover:text-danger" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
      {stars > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <textarea className="input min-h-[60px]" maxLength={2000} placeholder="What did you think? (optional)" value={review} onChange={(e) => setReview(e.target.value)} aria-label="Your review" />
          <button className="btn-primary self-start" onClick={() => onSave(stars, review)} disabled={(mine?.review ?? '') === review.trim()}>
            Save review
          </button>
        </div>
      )}
    </div>
  );
}

/** The household's stars and reviews for a title, and a way to plan watching it together. */
export function FamilyPanel({ m }: { m: MediaDetail }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const key = ['ratings', m.kind, m.tmdbId];
  const q = useQuery({ queryKey: key, queryFn: () => api<TitleRatings>(`/api/ratings/${m.kind}/${m.tmdbId}`) });
  const [error, setError] = useState('');
  const [planning, setPlanning] = useState(false);

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: key });
      await qc.invalidateQueries({ queryKey: ['home-row', 'family_favorites'] });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const others = (q.data?.ratings ?? []).filter((r) => r.userId !== me?.id);

  return (
    <section className="card space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="font-semibold">Family ratings</h2>
          {q.data?.family ? (
            <span className="flex items-center gap-1.5 text-sm text-muted">
              <Stars value={q.data.family.average} size="text-base" />
              {q.data.family.average.toFixed(1)} from {q.data.family.count} {q.data.family.count === 1 ? 'person' : 'people'}
            </span>
          ) : (
            <span className="text-sm text-muted">Nobody has rated this yet</span>
          )}
        </div>
        <button className="btn-secondary" onClick={() => setPlanning(true)}>
          🍿 Plan a movie night
        </button>
      </div>

      {q.data && (
        // Remounted when the saved rating changes, so the form starts from what's stored.
        <MyRating
          key={JSON.stringify(q.data.mine)}
          mine={q.data.mine}
          onSave={(stars, review) => act(() => api(`/api/ratings/${m.kind}/${m.tmdbId}`, { method: 'PUT', body: { stars, review: review.trim() || null } }))}
          onRemove={() => act(() => api(`/api/ratings/${m.kind}/${m.tmdbId}`, { method: 'DELETE' }))}
        />
      )}
      {error && <Alert>{error}</Alert>}

      {others.length > 0 && (
        <ul className="divide-y divide-border">
          {others.map((r) => (
            <li key={r.userId} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium">{r.name}</span>
                  <Stars value={r.stars} size="text-sm" />
                </div>
                {r.review && <p className="whitespace-pre-line text-sm text-text/90">{r.review}</p>}
              </div>
              {hasRole(me, 'manager') && (
                <button className="text-xs text-muted hover:text-danger" onClick={() => confirm(`Remove ${r.name}'s rating?`) && act(() => api(`/api/ratings/${m.kind}/${m.tmdbId}/users/${r.userId}`, { method: 'DELETE' }))}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {planning && <PlanNight m={m} onClose={() => setPlanning(false)} />}
    </section>
  );
}
