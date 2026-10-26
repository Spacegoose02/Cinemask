import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatBytes } from '../lib/api';
import { mediaPath, serverName, type MediaKind } from '../lib/media';
import { Modal } from './Modal';
import { Alert } from './ui';

interface DuplicateGroup {
  monitoredId: number;
  kind: MediaKind;
  tmdbId: number;
  title: string;
  year: number | null;
  episode: string | null;
  files: { path: string; size: number; quality: string; tracked: boolean }[];
}
interface Duplicates {
  files: DuplicateGroup[];
  servers: { server: string; kind: MediaKind; tmdbId: number; title: string; year: number | null; count: number }[];
}

/** Movies and episodes with more than one copy on disk, and titles the media servers list twice. */
export function DuplicatesDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['duplicates'], queryFn: () => api<Duplicates>('/api/duplicates') });
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const remove = async (g: DuplicateGroup, file: string) => {
    if (!confirm(`Delete this copy of ${g.title}${g.episode ? ` ${g.episode}` : ''} from disk? This can't be undone.\n\n${file}`)) return;
    setMsg(null);
    try {
      const r = await api<{ freed: number }>('/api/duplicates/delete', { body: { monitoredId: g.monitoredId, path: file } });
      setMsg({ kind: 'success', text: `Deleted it and freed ${formatBytes(r.freed)}.` });
      await qc.invalidateQueries({ queryKey: ['duplicates'] });
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    }
  };
  const label = (g: { title: string; year: number | null }) => `${g.title}${g.year ? ` (${g.year})` : ''}`;
  return (
    <Modal title="Duplicates" onClose={onClose} wide>
      <div className="space-y-4 text-sm">
        {q.isLoading && <p className="text-muted">Looking through your folders…</p>}
        {q.error && <Alert>{(q.error as Error).message}</Alert>}
        {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
        {q.data && !q.data.files.length && !q.data.servers.length && <p className="text-muted">No duplicates found.</p>}
        {!!q.data?.files.length && (
          <section className="space-y-2">
            <h3 className="font-semibold">More than one file</h3>
            <p className="hint">Trailers and extras next to a movie aren't counted. Keep the copy you want and delete the others.</p>
            {q.data.files.map((g) => (
              <div key={`${g.monitoredId}-${g.episode ?? ''}`} className="rounded border border-border p-2">
                <Link to={mediaPath(g.kind, g.tmdbId)} className="font-medium hover:underline" onClick={onClose}>
                  {label(g)} {g.episode}
                </Link>
                <ul className="mt-1 space-y-1">
                  {g.files.map((f) => (
                    <li key={f.path} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 break-all text-xs">
                        {f.path}
                        <span className="text-muted"> · {[f.quality !== 'Unknown' ? f.quality : null, formatBytes(f.size), f.tracked ? 'the one Cinemask uses' : null].filter(Boolean).join(' · ')}</span>
                      </span>
                      <button className="btn-danger shrink-0 text-xs" onClick={() => void remove(g, f.path)}>
                        Delete
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        )}
        {!!q.data?.servers.length && (
          <section className="space-y-2">
            <h3 className="font-semibold">Listed more than once on a media server</h3>
            <p className="hint">Usually the same title in two libraries, or two versions Plex didn't merge. Remove the extra copy on the server, or merge them there.</p>
            <ul className="space-y-1">
              {q.data.servers.map((s) => (
                <li key={`${s.server}-${s.kind}-${s.tmdbId}`}>
                  <Link to={mediaPath(s.kind, s.tmdbId)} className="hover:underline" onClick={onClose}>
                    {label(s)}
                  </Link>
                  <span className="text-muted">
                    {' '}
                    · {s.count} times on {serverName(s.server)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  );
}
