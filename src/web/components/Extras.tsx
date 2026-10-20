import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, formatBytes } from '../lib/api';
import type { MediaKind } from '../lib/media';
import { Modal } from './Modal';
import { Alert } from './ui';

interface PosterOption {
  source: 'tmdb' | 'theposterdb';
  value: string;
  preview: string;
  language?: string | null;
  votes?: number;
}

type Msg = { kind: 'error' | 'success'; text: string } | null;

function serversText(r: { servers: { server: string; ok: boolean; error?: string }[] }) {
  if (!r.servers.length) return 'Poster changed in Cinemask. This title isn’t on Plex or Jellyfin yet.';
  return r.servers.map((s) => `${s.server === 'plex' ? 'Plex' : 'Jellyfin'}: ${s.ok ? 'updated' : s.error}`).join(' · ');
}

/** Pick a poster from TMDB (or ThePosterDB), paste a link or upload one, and push it to Plex/Jellyfin. */
export function PosterPicker({ kind, tmdbId, onClose }: { kind: MediaKind; tmdbId: number; onClose: () => void }) {
  const qc = useQueryClient();
  const opts = useQuery({ queryKey: ['posters', kind, tmdbId], queryFn: () => api<PosterOption[]>(`/api/posters/${kind}/${tmdbId}`) });
  const [url, setUrl] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const apply = async (fn: () => Promise<{ servers: { server: string; ok: boolean; error?: string }[] }>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ kind: 'success', text: serversText(await fn()) });
      await qc.invalidateQueries({ queryKey: ['media', kind] });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const upload = async () => {
    const f = file.current?.files?.[0];
    if (!f) return;
    await apply(() => api(`/api/posters/${kind}/${tmdbId}`, { raw: f, headers: { 'content-type': f.type || 'image/jpeg' } }));
  };
  return (
    <Modal title="Change poster" onClose={onClose} wide>
      <div className="mb-4 flex flex-wrap gap-2">
        <input className="input max-w-md" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https:// link to an image" aria-label="Poster link" />
        <button className="btn-secondary" disabled={!url.startsWith('https://') || busy} onClick={() => apply(() => api(`/api/posters/${kind}/${tmdbId}`, { body: { value: url } }))}>
          Use link
        </button>
        <label className="btn-secondary cursor-pointer">
          Upload…
          <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={upload} />
        </label>
        <button className="btn-secondary" disabled={busy} onClick={() => apply(async () => (await api(`/api/posters/${kind}/${tmdbId}`, { method: 'DELETE' }), { servers: [] })).then(() => setMsg({ kind: 'success', text: 'Back to the TMDB poster in Cinemask. Plex and Jellyfin keep their current poster.' }))}>
          Reset
        </button>
      </div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {opts.isLoading && <p className="text-muted">Loading posters…</p>}
      {opts.error && <Alert>{(opts.error as Error).message}</Alert>}
      <div className="mt-3 grid max-h-[60vh] grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3 overflow-auto">
        {opts.data?.map((o) => (
          <button key={o.value} disabled={busy} onClick={() => apply(() => api(`/api/posters/${kind}/${tmdbId}`, { body: { value: o.value } }))} className="group text-left">
            <img src={o.preview} alt="" loading="lazy" className="aspect-[2/3] w-full rounded border border-border object-cover group-hover:border-accent" />
            <span className="text-[11px] text-muted">
              {o.source === 'tmdb' ? 'TMDB' : 'ThePosterDB'}
              {o.language ? ` · ${o.language}` : ''}
              {o.votes ? ` · ${o.votes} votes` : ''}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

interface TrailerInfo {
  enabled: boolean;
  files: { path: string; size: number }[];
  job: { status: 'downloading' | 'done' | 'failed'; key: string; error?: string } | null;
  candidates: { key: string; name: string; type: string; official: boolean; size: number | null }[];
}

/** Trailers saved next to the movie (or in the show's trailers folder) so Plex and Jellyfin show them. */
export function TrailerManager({ monitoredId, onClose }: { monitoredId: number; onClose: () => void }) {
  const info = useQuery({
    queryKey: ['trailers', monitoredId],
    queryFn: () => api<TrailerInfo>(`/api/monitored/${monitoredId}/trailers`),
    refetchInterval: (q) => (q.state.data?.job?.status === 'downloading' ? 3000 : false),
  });
  const [msg, setMsg] = useState<Msg>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, text: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: 'success', text });
      await info.refetch();
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
  };
  const d = info.data;
  return (
    <Modal title="Trailers" onClose={onClose} wide>
      {d && !d.enabled && <Alert kind="info">Trailer downloads are off. An admin can turn them on in Settings → Media management.</Alert>}
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {d?.job?.status === 'downloading' && <Alert kind="info">Downloading a trailer…</Alert>}
      {d?.job?.status === 'failed' && <Alert>Last download failed: {d.job.error}</Alert>}
      <h3 className="mb-1 mt-3 font-medium">On disk</h3>
      {d?.files.length ? (
        <ul className="mb-2 space-y-1 text-sm">
          {d.files.map((f) => (
            <li key={f.path} className="break-all">
              {f.path} <span className="text-muted">· {formatBytes(f.size)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-2 text-sm text-muted">No trailer downloaded.</p>
      )}
      {!!d?.files.length && (
        <button className="btn-secondary mb-4" onClick={() => run(() => api(`/api/monitored/${monitoredId}/trailers`, { method: 'DELETE' }), 'Removed.')}>
          Remove trailers
        </button>
      )}
      <h3 className="mb-1 font-medium">Available</h3>
      <ul className="max-h-[50vh] space-y-1 overflow-auto text-sm">
        {d?.candidates.map((c) => (
          <li key={c.key} className="flex flex-wrap items-center justify-between gap-2 rounded px-2 py-1.5 hover:bg-surface-2">
            <span>
              {c.name} <span className="text-muted">· {c.type}{c.official ? ' · official' : ''}{c.size ? ` · ${c.size}p` : ''}</span>
            </span>
            <span className="flex gap-1">
              <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setPreview(c.key)}>
                Watch
              </button>
              <button className="btn-primary px-2 py-1 text-xs" disabled={!d.enabled || d.job?.status === 'downloading'} onClick={() => run(() => api(`/api/monitored/${monitoredId}/trailers`, { body: { key: c.key } }), 'Download started.')}>
                Download
              </button>
            </span>
          </li>
        ))}
        {d && !d.candidates.length && <li className="text-muted">TMDB lists no trailers for this title.</li>}
      </ul>
      {preview && (
        <div className="mt-3 aspect-video w-full">
          <iframe className="h-full w-full rounded" src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(preview)}`} title="Trailer preview" referrerPolicy="strict-origin-when-cross-origin" allow="encrypted-media; picture-in-picture" allowFullScreen />
        </div>
      )}
    </Modal>
  );
}

/** Adds the TMDB film series a movie belongs to as a collection on Plex and Jellyfin, then opens it. */
export function useCreateSeriesCollection() {
  const navigate = useNavigate();
  return async (collection: { id: number; name: string }) => {
    const c = await api<{ id: number }>('/api/collections', { body: { name: collection.name, source: 'tmdb', sourceId: collection.id, toServers: true } });
    navigate(`/collections/${c.id}`);
  };
}
