import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { poster, type MediaCardData, type MediaKind } from '../lib/media';
import { Modal } from './Modal';
import { Alert } from './ui';

/**
 * Fixes a wrong match: search TMDB (or paste a TMDB id) and pick the right title of the same kind.
 * `onPick` does the saving; an error it throws is shown in the dialog.
 */
export function MatchPicker({ kind, title, heading, onPick, onClose }: { kind: MediaKind; title: string; heading?: string; onPick: (tmdbId: number) => Promise<unknown>; onClose: () => void }) {
  const [q, setQ] = useState(title);
  const [query, setQuery] = useState(title);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const found = useQuery({
    queryKey: ['match-search', query],
    queryFn: () => api<{ results: MediaCardData[]; error: string | null }>(`/api/search?q=${encodeURIComponent(query)}`),
    enabled: query.trim().length > 0,
  });
  const results = (found.data?.results ?? []).filter((r) => r.kind === kind && r.tmdbId);
  const pick = async (tmdbId: number) => {
    setBusy(true);
    setError('');
    try {
      await onPick(tmdbId);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const typedId = /^\d+$/.test(q.trim()) ? Number(q.trim()) : null;

  return (
    <Modal title={heading ?? `Fix the match for ${title}`} onClose={onClose}>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (typedId) void pick(typedId);
          else setQuery(q);
        }}
      >
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title or TMDB id" aria-label="Title or TMDB id" />
        <button className="btn-primary" disabled={busy || !q.trim()}>
          {typedId ? 'Use this id' : 'Search'}
        </button>
      </form>
      {error && <Alert>{error}</Alert>}
      {found.data?.error && <Alert>{found.data.error}</Alert>}
      <ul className="mt-3 max-h-96 space-y-1 overflow-y-auto">
        {results.map((r) => (
          <li key={r.tmdbId}>
            <button className="flex w-full items-center gap-3 rounded p-1.5 text-left hover:bg-surface-2" disabled={busy} onClick={() => void pick(r.tmdbId!)}>
              {poster(r.posterPath, 'w185') ? <img src={poster(r.posterPath, 'w185')!} alt="" className="h-14 w-10 rounded object-cover" /> : <div className="h-14 w-10 rounded bg-surface-2" />}
              <span className="text-sm">
                {r.title} <span className="text-muted">{r.year ?? ''}</span>
                <span className="block text-xs text-muted">TMDB {r.tmdbId}</span>
              </span>
            </button>
          </li>
        ))}
        {found.data && !results.length && <li className="text-sm text-muted">No {kind === 'movie' ? 'movies' : 'shows'} found.</li>}
      </ul>
    </Modal>
  );
}
