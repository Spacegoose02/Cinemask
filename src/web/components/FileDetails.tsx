import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, hasRole } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { MediaDetail } from '../pages/MediaDetail';
import { Alert } from './ui';

interface FileInfo {
  width: number | null;
  height: number | null;
  resolution: string | null;
  videoCodec: string | null;
  hdr: string | null;
  durationMin: number | null;
  audio: { codec: string; channels: number | null; language: string | null }[];
  subtitles: { codec: string; language: string | null; forced: boolean }[];
  externalSubtitles: string[];
  problems: string[];
}

export interface DetailFile {
  path: string;
  release: string | null;
  formatScore: number | null;
  info: FileInfo | null;
  season?: number;
  episodes?: number[];
}

const channels = (n: number | null) => (n === 8 ? '7.1' : n === 6 ? '5.1' : n === 2 ? 'stereo' : n === 1 ? 'mono' : n ? `${n} ch` : '');
const pad = (n: number) => String(n).padStart(2, '0');
const subLang = (f: string) => /\.([a-z]{2,3})(\.(sdh|forced|hi))?\.\w+$/i.exec(f)?.[1] ?? '?';

/** What ffprobe found in one file: picture, HDR, audio and subtitle languages, and anything to check. */
export function FileInfoLines({ info }: { info: FileInfo | null }) {
  if (!info) return <div className="text-xs text-muted">Not read yet.</div>;
  return (
    <>
      <div>{[info.resolution && `${info.resolution} (${info.width}×${info.height})`, info.videoCodec?.toUpperCase(), info.hdr ?? 'SDR', info.durationMin && `${info.durationMin} min`].filter(Boolean).join(' · ')}</div>
      <div className="text-xs text-muted">
        Audio: {info.audio.map((a) => [a.language?.toUpperCase() ?? '?', a.codec.toUpperCase(), channels(a.channels)].filter(Boolean).join(' ')).join(', ') || 'none'}
        {' · '}Subtitles: {[...info.subtitles.map((s) => `${s.language?.toUpperCase() ?? '?'}${s.forced ? ' (forced)' : ''}`), ...info.externalSubtitles.map((x) => `${subLang(x).toUpperCase()} (file)`)].join(', ') || 'none'}
      </div>
      {info.problems.map((p) => (
        <div key={p} className="text-xs text-warning">
          {p}
        </div>
      ))}
    </>
  );
}

/** Reads every file of a monitored title again with ffprobe. Returns the message to show. */
export async function readFiles(id: number): Promise<string> {
  const r = await api<{ probed: number }>(`/api/monitored/${id}/probe`, { body: {} });
  return `Read ${r.probed} file(s).`;
}

/** Downloads subtitles in the household's languages for files without them. Returns the message to show. */
export async function fetchSubtitles(id: number): Promise<string> {
  const r = await api<{ saved: string[]; missing: string[] }>(`/api/monitored/${id}/subtitles`, { body: {} });
  return r.saved.length ? `Saved ${r.saved.length} subtitle file(s).${r.missing.length ? ` None found for ${r.missing.length}.` : ''}` : r.missing.length ? `No subtitles found for ${r.missing.join(', ')}.` : 'Every file already has subtitles in your languages.';
}

/**
 * Managers: what's really in each file of a movie, and subtitles. A show's files are read out under
 * each episode in its Seasons section instead (FilesPanel), so a long show isn't one huge list.
 */
export function FileDetails({ m }: { m: MediaDetail }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const isManager = hasRole(me, 'manager');
  const lookup = useQuery({ queryKey: ['lookup', m.kind, m.tmdbId], queryFn: () => api<{ monitored: { id: number } | null }>(`/api/monitored/lookup/${m.kind}/${m.tmdbId}`), enabled: isManager });
  const id = lookup.data?.monitored?.id;
  const q = useQuery({ queryKey: ['file-details', id], queryFn: () => api<{ files: DetailFile[] }>(`/api/monitored/${id}/details`), enabled: isManager && !!id });
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!isManager || m.kind === 'show' || !id || !q.data?.files.length) return null;
  const files = q.data.files;
  const problems = files.reduce((n, f) => n + (f.info?.problems.length ?? 0), 0);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ kind: 'success', text: await fn() });
      await qc.invalidateQueries({ queryKey: ['file-details', id] });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">
          What's in the files {problems > 0 && <span className="ml-1 text-sm font-normal text-warning">· {problems} thing{problems === 1 ? '' : 's'} to check</span>}
        </h2>
        <div className="flex gap-2">
          <button className="btn-secondary" disabled={busy} onClick={() => run(() => readFiles(id))}>
            Read again
          </button>
          <button className="btn-secondary" disabled={busy} onClick={() => run(() => fetchSubtitles(id))}>
            Fetch subtitles
          </button>
        </div>
      </div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <ul className="max-h-96 space-y-2 overflow-y-auto text-sm">
        {files.map((f) => (
          <li key={f.path} className="rounded-md border border-border p-2">
            <div className="truncate text-xs text-muted" title={f.path}>
              {f.season !== undefined ? `S${pad(f.season)}E${f.episodes!.map(pad).join('-E')} · ` : ''}
              {f.release ?? f.path.split('/').pop()}
              {f.formatScore ? ` · score ${f.formatScore}` : ''}
            </div>
            <FileInfoLines info={f.info} />
          </li>
        ))}
      </ul>
    </section>
  );
}
