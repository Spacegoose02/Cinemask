import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toLocalInput } from '../components/FamilyPanel';
import { Modal } from '../components/Modal';
import { Alert, Field } from '../components/ui';
import { api, hasRole } from '../lib/api';
import { useAuth } from '../lib/auth';
import { mediaPath, poster, type MediaKind } from '../lib/media';

type Answer = 'yes' | 'maybe' | 'no';

export interface MovieNight {
  id: number;
  kind: MediaKind;
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  startsAt: number;
  note: string | null;
  hostName: string | null;
  mine: boolean;
  myAnswer: Answer | null;
  rsvps: { userId: number; name: string; answer: Answer }[];
}

// Still "coming up" until a few hours after it starts.
const split = (nights: MovieNight[], now = Date.now()) => ({
  upcoming: nights.filter((n) => n.startsAt > now - 3 * 60 * 60 * 1000),
  past: nights.filter((n) => n.startsAt <= now - 3 * 60 * 60 * 1000).reverse(),
});

export const useMovieNights = () => useQuery({ queryKey: ['movie-nights'], queryFn: () => api<MovieNight[]>('/api/movie-nights'), select: split });

export const nightWhen = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const ANSWERS: { id: Answer; label: string }[] = [
  { id: 'yes', label: "I'm in" },
  { id: 'maybe', label: 'Maybe' },
  { id: 'no', label: "Can't make it" },
];

function Edit({ night, onClose }: { night: MovieNight; onClose: () => void }) {
  const qc = useQueryClient();
  const [at, setAt] = useState(toLocalInput(night.startsAt));
  const [note, setNote] = useState(night.note ?? '');
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['movie-nights'] });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title={`Change ${night.title}`} onClose={onClose}>
      <div className="space-y-3">
        <Field label="When">
          <input type="datetime-local" className="input" value={at} onChange={(e) => setAt(e.target.value)} />
        </Field>
        <Field label="Note">
          <input className="input" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-between">
          <button className="btn-primary" disabled={!at} title={at ? undefined : 'Pick a time'} onClick={() => run(() => api(`/api/movie-nights/${night.id}`, { method: 'PATCH', body: { startsAt: new Date(at).getTime(), note: note || null } }))}>
            Save
          </button>
          <button className="btn-danger" onClick={() => confirm('Call off this movie night?') && run(() => api(`/api/movie-nights/${night.id}`, { method: 'DELETE' }))}>
            Call it off
          </button>
        </div>
      </div>
    </Modal>
  );
}

function NightCard({ night, past }: { night: MovieNight; past: boolean }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const img = poster(night.posterPath, 'w185');
  const rsvp = async (answer: Answer) => {
    setError('');
    try {
      await api(`/api/movie-nights/${night.id}/rsvp`, { method: 'PUT', body: { answer } });
      await qc.invalidateQueries({ queryKey: ['movie-nights'] });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const going = night.rsvps.filter((r) => r.answer === 'yes');
  const maybe = night.rsvps.filter((r) => r.answer === 'maybe');
  return (
    <li className={`card flex gap-4 ${past ? 'opacity-70' : ''}`}>
      <Link to={mediaPath(night.kind, night.tmdbId)} className="w-20 shrink-0 overflow-hidden rounded-md border border-border bg-surface-2 sm:w-24">
        {img ? <img src={img} alt="" className="w-full" /> : <div className="aspect-[2/3]" />}
      </Link>
      <div className="min-w-0 flex-1 space-y-2">
        <div>
          <div className="text-xs uppercase tracking-wider text-accent">{nightWhen(night.startsAt)}</div>
          <Link to={mediaPath(night.kind, night.tmdbId)} className="text-lg font-semibold hover:text-accent">
            {night.title} {night.year && <span className="font-normal text-muted">({night.year})</span>}
          </Link>
          <div className="text-sm text-muted">Hosted by {night.hostName ?? 'someone'}</div>
          {night.note && <p className="mt-1 text-sm">{night.note}</p>}
        </div>
        <div className="text-sm">
          <span className="text-success">{going.length ? `Going: ${going.map((r) => r.name).join(', ')}` : 'Nobody going yet'}</span>
          {maybe.length > 0 && <span className="text-muted"> · Maybe: {maybe.map((r) => r.name).join(', ')}</span>}
        </div>
        {!past && (
          <div className="flex flex-wrap gap-2">
            {ANSWERS.map((a) => (
              <button key={a.id} className={night.myAnswer === a.id ? 'btn-primary' : 'btn-secondary'} onClick={() => rsvp(a.id)} aria-pressed={night.myAnswer === a.id}>
                {a.label}
              </button>
            ))}
            {(night.mine || hasRole(me, 'manager')) && (
              <button className="btn-secondary ml-auto" onClick={() => setEditing(true)}>
                Change
              </button>
            )}
          </div>
        )}
        {error && <Alert>{error}</Alert>}
      </div>
      {editing && <Edit night={night} onClose={() => setEditing(false)} />}
    </li>
  );
}

export function MovieNightsPage() {
  const q = useMovieNights();
  const { upcoming, past } = q.data ?? { upcoming: [], past: [] };
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Movie nights</h1>
        <p className="text-sm text-muted">Plan one from any movie or show's page with "Plan a movie night", then everyone can say if they're in.</p>
      </div>
      {q.error && <Alert>{(q.error as Error).message}</Alert>}
      {q.data && !upcoming.length && (
        <div className="card text-sm text-muted">
          Nothing planned yet. Find something on the <Link to="/library" className="text-accent">Library</Link> or <Link to="/discover" className="text-accent">Discover</Link> page and plan a night around it.
        </div>
      )}
      <ul className="space-y-3">
        {upcoming.map((n) => (
          <NightCard key={n.id} night={n} past={false} />
        ))}
      </ul>
      {past.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Last week</h2>
          <ul className="space-y-3">
            {past.map((n) => (
              <NightCard key={n.id} night={n} past />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
