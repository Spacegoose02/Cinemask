import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Modal } from '../components/Modal';
import { Alert, Field, Toggle } from '../components/ui';
import { api, formatDate } from '../lib/api';

type Mode = 'new' | 'all' | 'playlists';
type VideoStatus = 'wanted' | 'skipped' | 'downloading' | 'done' | 'failed';
interface Playlist {
  id: string;
  title: string;
}
interface Channel {
  id: number;
  url: string;
  name: string;
  mode: Mode;
  playlists: Playlist[];
  enabled: boolean;
  lastCheckedAt: number | null;
  lastError: string | null;
  counts: Partial<Record<VideoStatus, number>>;
}
interface Video {
  id: number;
  videoId: string;
  title: string;
  publishedAt: string | null;
  status: VideoStatus;
  error: string | null;
}

const MODE_LABEL: Record<Mode, string> = { new: 'New videos only', all: 'Every video', playlists: 'Chosen playlists' };
const STATUS_LABEL: Record<VideoStatus, string> = { wanted: 'Waiting', skipped: 'Not downloaded', downloading: 'Downloading', done: 'Downloaded', failed: 'Failed' };

function PlaylistPicker({ url, value, onChange }: { url: string; value: Playlist[]; onChange: (p: Playlist[]) => void }) {
  const lists = useQuery({ queryKey: ['yt-playlists', url], queryFn: () => api<{ playlists: Playlist[] }>('/api/youtube/playlists', { body: { url } }), enabled: Boolean(url), retry: false });
  if (lists.isLoading) return <p className="text-sm text-muted">Reading the channel's playlists…</p>;
  if (lists.error) return <Alert>{(lists.error as Error).message}</Alert>;
  if (!lists.data?.playlists.length) return <p className="text-sm text-muted">This channel has no public playlists.</p>;
  return (
    <div className="max-h-64 space-y-2 overflow-y-auto">
      {lists.data.playlists.map((p) => (
        <Toggle key={p.id} label={p.title} checked={value.some((v) => v.id === p.id)} onChange={(on) => onChange(on ? [...value, p] : value.filter((v) => v.id !== p.id))} />
      ))}
    </div>
  );
}

function AddChannel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<Mode>('new');
  const [picked, setPicked] = useState<Playlist[]>([]);
  const [listUrl, setListUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/api/youtube/channels', { body: { url, mode, playlists: picked } });
      await qc.invalidateQueries({ queryKey: ['yt-channels'] });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Subscribe to a channel" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Channel or playlist link" hint="For example https://www.youtube.com/@BlueyOfficialChannel">
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.youtube.com/@…" />
        </Field>
        <Field label="Download">
          <select
            className="input"
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as Mode);
              if (e.target.value === 'playlists') setListUrl(url);
            }}
          >
            <option value="new">New videos from now on</option>
            <option value="all">Every video on the channel</option>
            <option value="playlists">Only the playlists I pick</option>
          </select>
        </Field>
        {mode === 'playlists' && (
          <Field label="Playlists">
            {listUrl === url && url ? (
              <PlaylistPicker url={url} value={picked} onChange={setPicked} />
            ) : (
              <button className="btn-secondary" disabled={!url} onClick={() => setListUrl(url)}>
                Show playlists
              </button>
            )}
          </Field>
        )}
        {error && <Alert>{error}</Alert>}
        <button className="btn-primary" disabled={busy || !url.trim() || (mode === 'playlists' && !picked.length)} onClick={add}>
          {busy ? 'Reading the channel…' : 'Subscribe'}
        </button>
      </div>
    </Modal>
  );
}

function Videos({ channel }: { channel: Channel }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'all' | VideoStatus>('all');
  const videos = useQuery({ queryKey: ['yt-videos', channel.id, status], queryFn: () => api<{ total: number; videos: Video[] }>(`/api/youtube/channels/${channel.id}/videos?status=${status}`), refetchInterval: 15_000 });
  const queue = async (id: number) => {
    await api(`/api/youtube/videos/${id}/download`, { method: 'POST' });
    await qc.invalidateQueries({ queryKey: ['yt-videos', channel.id] });
  };
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Show">
        <option value="all">All videos</option>
        {Object.entries(STATUS_LABEL).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
      <ul className="max-h-96 space-y-1 overflow-y-auto text-sm">
        {videos.data?.videos.map((v) => (
          <li key={v.id} className="flex items-center justify-between gap-3 rounded px-2 py-1 hover:bg-surface-2">
            <span className="min-w-0">
              <a className="block truncate hover:underline" href={`https://www.youtube.com/watch?v=${v.videoId}`} target="_blank" rel="noreferrer">
                {v.title}
              </a>
              <span className="text-xs text-muted">
                {v.publishedAt ? `${v.publishedAt} · ` : ''}
                {STATUS_LABEL[v.status]}
                {v.error && <span className="text-danger">: {v.error}</span>}
              </span>
            </span>
            {(v.status === 'skipped' || v.status === 'failed') && (
              <button className="btn-secondary shrink-0 px-2 py-1 text-xs" onClick={() => void queue(v.id)}>
                {v.status === 'failed' ? 'Retry' : 'Download'}
              </button>
            )}
          </li>
        ))}
        {videos.data && !videos.data.videos.length && <li className="text-muted">No videos here.</li>}
      </ul>
      {videos.data && videos.data.total > videos.data.videos.length && <p className="text-xs text-muted">Showing the newest {videos.data.videos.length} of {videos.data.total}.</p>}
    </div>
  );
}

function ChannelCard({ c }: { c: Channel }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const run = async (fn: () => Promise<string | void>) => {
    setMsg(null);
    try {
      const text = await fn();
      if (text) setMsg({ kind: 'success', text });
      await qc.invalidateQueries({ queryKey: ['yt-channels'] });
      await qc.invalidateQueries({ queryKey: ['yt-videos', c.id] });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
  };
  const counts = c.counts;
  return (
    <li className="card space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <a className="font-medium hover:underline" href={c.url} target="_blank" rel="noreferrer">
            {c.name}
          </a>
          <div className="text-xs text-muted">
            {MODE_LABEL[c.mode]}
            {c.mode === 'playlists' && `: ${c.playlists.map((p) => p.title).join(', ')}`} · checked {formatDate(c.lastCheckedAt)}
            {!c.enabled && ' · paused'}
          </div>
          <div className="text-sm">
            {counts.done ?? 0} downloaded
            {counts.wanted || counts.downloading ? `, ${(counts.wanted ?? 0) + (counts.downloading ?? 0)} to go` : ''}
            {counts.failed ? <span className="text-danger">, {counts.failed} failed</span> : null}
          </div>
          {c.lastError && <div className="text-xs text-danger">{c.lastError}</div>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary" onClick={() => setOpen(!open)} aria-expanded={open}>
            Videos
          </button>
          <button className="btn-secondary" onClick={() => run(async () => `Found ${(await api<{ added: number }>(`/api/youtube/channels/${c.id}/check`, { body: {} })).added} new video(s).`)}>
            Check now
          </button>
          {c.mode === 'new' && (
            <button className="btn-secondary" onClick={() => confirm(`Download every video from ${c.name}?`) && run(async () => void (await api(`/api/youtube/channels/${c.id}`, { method: 'PATCH', body: { mode: 'all' } })))}>
              Get every video
            </button>
          )}
          <button className="btn-secondary" onClick={() => run(async () => void (await api(`/api/youtube/channels/${c.id}`, { method: 'PATCH', body: { enabled: !c.enabled } })))}>
            {c.enabled ? 'Pause' : 'Resume'}
          </button>
          <button className="btn-danger" onClick={() => confirm(`Unsubscribe from ${c.name}? Downloaded videos stay in the folder.`) && run(async () => void (await api(`/api/youtube/channels/${c.id}`, { method: 'DELETE' })))}>
            Unsubscribe
          </button>
        </div>
      </div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {open && <Videos channel={c} />}
    </li>
  );
}

export function YoutubePage() {
  const [adding, setAdding] = useState(false);
  const channels = useQuery({ queryKey: ['yt-channels'], queryFn: () => api<Channel[]>('/api/youtube/channels'), refetchInterval: 30_000 });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">YouTube</h1>
        <button className="btn-primary" onClick={() => setAdding(true)}>
          Subscribe to a channel
        </button>
      </div>
      <p className="text-sm text-muted">
        Videos are saved as Channel/Season year/Channel - date - title, with a thumbnail and an .nfo file. Add the YouTube folder (Settings → Media management) to Plex or Jellyfin as a TV library. In Plex, choose the Personal Media Shows agent so the
        files' own titles and dates are used.
      </p>
      {channels.data?.length === 0 && <div className="card text-sm text-muted">No channels yet.</div>}
      <ul className="space-y-3">
        {channels.data?.map((c) => (
          <ChannelCard key={c.id} c={c} />
        ))}
      </ul>
      {adding && <AddChannel onClose={() => setAdding(false)} />}
    </div>
  );
}
