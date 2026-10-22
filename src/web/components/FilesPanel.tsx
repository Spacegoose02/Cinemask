import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, formatBytes, hasRole } from '../lib/api';
import { useAuth } from '../lib/auth';
import { mediaPath } from '../lib/media';
import type { MediaDetail } from '../pages/MediaDetail';
import { TrailerManager } from './Extras';
import { MatchPicker } from './MatchPicker';
import { ManualSearch } from './MediaActions';
import { Modal } from './Modal';
import { Alert } from './ui';

interface Episode {
  id: number;
  season: number;
  episode: number;
  title: string | null;
  airDate: string | null;
  monitored: boolean;
  filePath: string | null;
  fileQuality: string | null;
}

interface MonitoredView {
  id: number;
  kind: 'movie' | 'show';
  title: string;
  path: string | null;
  filePath: string | null;
  fileQuality: string | null;
  episodes: Episode[];
}

interface FileEntry {
  path: string;
  quality: string | null;
  size: number | null;
  exists: boolean;
  season?: number;
  episodes?: number[];
}

type DeleteTarget = { scope: 'movie' | 'show'; label: string } | { scope: 'season'; season: number; label: string } | { scope: 'episode'; season: number; episode: number; label: string };

interface Activity {
  id: number;
  title: string;
  status: string;
  progress: number;
  episodes: { season: number; episodes: number[] } | null;
  error: string | null;
  eta: number | null;
}

const ACTIVE = (a: Activity) => a.status !== 'failed';

/** How a download for this movie or episode is doing: queued, downloading with a bar, importing, or failed. */
function DownloadStatus({ a }: { a: Activity }) {
  if (a.status === 'failed') return <span className="text-danger" title={a.title}>Download failed{a.error ? `: ${a.error}` : ''}</span>;
  if (a.status === 'held') return <span className="text-warning">Over the size limit; confirm it on Downloads</span>;
  if (a.status === 'completed' || a.status === 'importing') return <span className="text-accent">Downloaded, importing…</span>;
  if (a.status === 'queued') return <span className="text-accent">Queued in the download client</span>;
  const pct = Math.round(a.progress * 100);
  return (
    <span className="flex items-center gap-2 text-accent" title={a.title}>
      {a.status === 'paused' ? 'Paused' : 'Downloading'} {pct}%
      <span className="inline-block h-1.5 w-24 overflow-hidden rounded bg-surface-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span className="block h-full bg-accent" style={{ width: `${pct}%` }} />
      </span>
      {a.eta ? <span className="text-muted">{a.eta < 60 ? '<1 min' : `${Math.round(a.eta / 60)} min`} left</span> : null}
    </span>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
const today = () => new Date().toISOString().slice(0, 10);
const base = (p: string) => p.split(/[\\/]/).pop();

function RenameModal({ id, onClose, onDone }: { id: number; onClose: () => void; onDone: (msg: string) => void }) {
  const preview = useQuery({ queryKey: ['rename', id], queryFn: () => api<{ from: string; to: string }[]>(`/api/monitored/${id}/rename`) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apply = async () => {
    setBusy(true);
    try {
      const r = await api<{ renamed: number; errors: string[] }>(`/api/monitored/${id}/rename`, { body: {} });
      if (r.errors.length) setError(r.errors.join('; '));
      else onDone(`Renamed ${r.renamed} file${r.renamed === 1 ? '' : 's'}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Rename files" onClose={onClose} wide>
      <p className="mb-3 text-sm text-muted">Files are renamed to match Settings → Media management. Nothing is re-downloaded.</p>
      {error && <Alert>{error}</Alert>}
      {preview.data && !preview.data.length && <Alert kind="info">Every file already matches the naming format.</Alert>}
      <ul className="max-h-[55vh] space-y-2 overflow-auto text-sm">
        {preview.data?.map((r) => (
          <li key={r.from} className="rounded border border-border p-2">
            <div className="break-all text-muted line-through">{r.from}</div>
            <div className="break-all">{r.to}</div>
          </li>
        ))}
      </ul>
      {!!preview.data?.length && (
        <button className="btn-primary mt-4" disabled={busy} onClick={apply}>
          Rename {preview.data.length} file{preview.data.length === 1 ? '' : 's'}
        </button>
      )}
    </Modal>
  );
}

function DeleteModal({ id, target, onClose, onDone }: { id: number; target: DeleteTarget; onClose: () => void; onDone: (msg: string) => void }) {
  const [unmonitor, setUnmonitor] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    try {
      const r = await api<{ deleted: number; freed: number }>(`/api/monitored/${id}/delete-files`, { body: { ...target, unmonitor } });
      onDone(`Deleted ${r.deleted} file${r.deleted === 1 ? '' : 's'} (${formatBytes(r.freed)} freed).`);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title={`Delete ${target.label}?`} onClose={onClose}>
      <p className="mb-3 text-sm">The file{target.scope === 'episode' || target.scope === 'movie' ? '' : 's'} will be removed from disk. This can't be undone.</p>
      <label className="mb-4 flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={unmonitor} onChange={(e) => setUnmonitor(e.target.checked)} />
        <span>
          Stop monitoring too
          <span className="hint block">Otherwise the app will download {target.scope === 'movie' ? 'it' : 'them'} again.</span>
        </span>
      </label>
      {error && <Alert>{error}</Alert>}
      <div className="flex gap-2">
        <button className="btn-danger" onClick={go}>
          Delete
        </button>
        <button className="btn-secondary" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

function RemoveModal({ mon, onClose }: { mon: MonitoredView; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [withFiles, setWithFiles] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    try {
      await api(`/api/monitored/${mon.id}/remove`, { body: { deleteFiles: withFiles } });
      await qc.invalidateQueries();
      onClose();
      navigate('/library');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title={`Remove ${mon.title}?`} onClose={onClose}>
      <p className="mb-3 text-sm">The app stops tracking it. Requests for it stay in the history.</p>
      <label className="mb-4 flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={withFiles} onChange={(e) => setWithFiles(e.target.checked)} />
        <span>
          Also delete its folder from disk
          {mon.path && <span className="hint block break-all">{mon.path}</span>}
        </span>
      </label>
      {error && <Alert>{error}</Alert>}
      <button className="btn-danger" onClick={go}>
        {withFiles ? 'Remove and delete files' : 'Remove'}
      </button>
    </Modal>
  );
}

/** Files on disk for a monitored movie or show, with rename, delete and per-episode search. Managers only. */
/**
 * A title on Plex or Jellyfin that Cinemask doesn't manage yet. Managing it finds its folder, so the
 * files can be deleted, renamed and upgraded. Nothing is searched for.
 */
function StartManaging({ m, folder }: { m: MediaDetail; folder: string | null }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const row = await api<{ id: number }>('/api/monitored', { body: { kind: m.kind, tmdbId: m.tmdbId, search: false } });
      // Stop it searching on its own: it's already on the server, and this is only to manage the files.
      await api(`/api/monitored/${row.id}`, { method: 'PATCH', body: { monitored: false } });
      await api(`/api/monitored/${row.id}/scan`, { body: {} });
      await qc.invalidateQueries({ queryKey: ['lookup', m.kind, m.tmdbId] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card space-y-3">
      <div>
        <h2 className="font-semibold">Files</h2>
        <div className="break-all text-xs text-muted">{folder ?? 'No folder for this title was found in your media folders (Settings → Media management).'}</div>
      </div>
      <p className="text-sm text-muted">
        This is on your media server, but Cinemask isn't managing it yet. Manage it to delete, rename or upgrade the files, search for releases and download a trailer. Nothing is downloaded until you ask.
      </p>
      {error && <Alert>{error}</Alert>}
      <button className="btn-primary" disabled={busy} onClick={start}>
        {busy ? 'Finding the files…' : `Manage this ${m.kind === 'movie' ? 'movie' : 'show'}`}
      </button>
    </section>
  );
}

export function FilesPanel({ m }: { m: MediaDetail }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const isManager = hasRole(me, 'manager');
  const lookup = useQuery({ queryKey: ['lookup', m.kind, m.tmdbId], queryFn: () => api<{ monitored: MonitoredView | null; folder?: string | null }>(`/api/monitored/lookup/${m.kind}/${m.tmdbId}`), enabled: isManager });
  const mon = lookup.data?.monitored && 'episodes' in lookup.data.monitored ? lookup.data.monitored : null;
  const files = useQuery({ queryKey: ['files', mon?.id], queryFn: () => api<{ folder: string | null; files: FileEntry[]; totalSize: number }>(`/api/monitored/${mon!.id}/files`), enabled: Boolean(mon) });
  // Downloads in progress refresh every few seconds; when one finishes, the files show without a rescan.
  const activity = useQuery({
    queryKey: ['activity', mon?.id],
    queryFn: () => api<Activity[]>(`/api/monitored/${mon!.id}/activity`),
    enabled: Boolean(mon),
    refetchInterval: (q) => (q.state.data?.some(ACTIVE) ? 5000 : 30000),
  });
  const activeIds = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (!activity.data || !mon) return;
    const now = new Set(activity.data.filter(ACTIVE).map((a) => a.id));
    const finished = [...activeIds.current].some((id) => !now.has(id));
    activeIds.current = now;
    if (finished) {
      void qc.invalidateQueries({ queryKey: ['lookup', m.kind, m.tmdbId] });
      void qc.invalidateQueries({ queryKey: ['files', mon.id] });
    }
  }, [activity.data, mon, m.kind, m.tmdbId, qc]);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [rowMsg, setRowMsg] = useState<{ key: string; kind: 'error' | 'success' | 'info'; text: string; errors?: string[] } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [trailers, setTrailers] = useState(false);
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);
  const [manual, setManual] = useState<{ season: number; episode?: number } | null>(null);
  const [openSeason, setOpenSeason] = useState<number | null>(null);
  const [matching, setMatching] = useState(false);
  const navigate = useNavigate();
  if (!isManager) return null;
  if (!mon) return lookup.data && (m.availability.status === 'on_server' || m.availability.status === 'partial') ? <StartManaging m={m} folder={lookup.data.folder ?? null} /> : null;

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['lookup', m.kind, m.tmdbId] }), qc.invalidateQueries({ queryKey: ['files', mon.id] }), qc.invalidateQueries({ queryKey: ['activity', mon.id] })]);
  // The newest download for an episode (or the movie); a failure only matters while there's still no file.
  const downloadFor = (season?: number, episode?: number) =>
    activity.data?.find((a) => (season === undefined ? true : a.episodes?.season === season && a.episodes.episodes.includes(episode!)));
  const run = async (fn: () => Promise<unknown>, success: string | ((r: never) => string)) => {
    setMsg(null);
    try {
      const r = await fn();
      setMsg({ kind: 'success', text: typeof success === 'string' ? success : success(r as never) });
      await refresh();
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
  };
  // A Search button's result shows under the season or episode it was pressed on, not at the top.
  const search = async (key: string, body: { season: number; episode?: number }) => {
    setRowMsg({ key, kind: 'info', text: 'Searching…' });
    try {
      const r = await api<{ grabbed: number; message: string; errors: string[] }>(`/api/monitored/${mon.id}/search`, { body });
      setRowMsg({ key, kind: r.grabbed ? 'success' : 'info', text: r.message, errors: r.errors });
      await refresh();
    } catch (e) {
      setRowMsg({ key, kind: 'error', text: (e as Error).message });
    }
  };
  const rowAlert = (key: string) =>
    rowMsg?.key === key && (
      <Alert kind={rowMsg.kind}>
        {rowMsg.text}
        {/* Indexer problems (rate limits, timeouts) on their own lines, apart from the result. */}
        {rowMsg.errors?.length ? (
          <ul className="mt-1 list-disc pl-4 text-xs text-muted">
            {rowMsg.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        ) : null}
      </Alert>
    );
  const done = async (text: string) => {
    setRenaming(false);
    setDeleting(null);
    setMsg({ kind: 'success', text });
    await refresh();
  };
  const fileFor = (p: string | null) => (p ? files.data?.files.find((f) => f.path === p) : undefined);

  const seasons = [...new Set(mon.episodes.map((e) => e.season))].sort((a, b) => a - b);

  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">Files</h2>
          <div className="break-all text-xs text-muted">
            {files.data?.folder ?? 'No folder yet'}
            {files.data && files.data.totalSize > 0 && ` · ${formatBytes(files.data.totalSize)}`}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {m.kind === 'show' && (
            <button className="btn-secondary" title="Searches every monitored episode that has aired and has no file" onClick={() => run(() => api<{ message: string }>(`/api/monitored/${mon.id}/search`, { body: { missingOnly: true } }), (r: { message: string }) => r.message)}>
              Search missing
            </button>
          )}
          <button className="btn-secondary" onClick={() => run(() => api(`/api/monitored/${mon.id}/scan`, { body: {} }), (r: { found: number; missing: number }) => `Found ${r.found} new file(s)${r.missing ? `, ${r.missing} missing` : ''}.`)}>
            Rescan folder
          </button>
          <button className="btn-secondary" onClick={() => setRenaming(true)}>
            Rename
          </button>
          <button className="btn-secondary" onClick={() => setTrailers(true)}>
            Trailers
          </button>
          <button className="btn-secondary" onClick={() => setMatching(true)} title="Point this at a different TMDB title">
            Fix match
          </button>
          {m.kind === 'show' && files.data && files.data.files.length > 0 && (
            <button className="btn-secondary" onClick={() => setDeleting({ scope: 'show', label: `all files for ${mon.title}` })}>
              Delete all files
            </button>
          )}
          <button className="btn-danger" onClick={() => setRemoving(true)}>
            Remove
          </button>
        </div>
      </div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}

      {m.kind === 'movie' &&
        (mon.filePath ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-2 text-sm">
            <div className="min-w-0">
              <div className="break-all">{base(mon.filePath)}</div>
              <div className="text-xs text-muted">
                {mon.fileQuality} {fileFor(mon.filePath)?.size != null && `· ${formatBytes(fileFor(mon.filePath)!.size!)}`}
                {fileFor(mon.filePath)?.exists === false && <span className="text-danger"> · missing on disk</span>}
              </div>
            </div>
            <button className="btn-secondary" onClick={() => setDeleting({ scope: 'movie', label: base(mon.filePath!)! })}>
              Delete file
            </button>
          </div>
        ) : (
          <p className="text-sm text-muted">No file yet. If it's already on disk, use Rescan folder.</p>
        ))}
      {m.kind === 'movie' && downloadFor() && (!mon.filePath || ACTIVE(downloadFor()!)) && (
        <div className="text-sm">
          <DownloadStatus a={downloadFor()!} />
        </div>
      )}

      {m.kind === 'show' && (
        <ul>
          {seasons.map((s) => {
            const eps = mon.episodes.filter((e) => e.season === s);
            const have = eps.filter((e) => e.filePath).length;
            const allMonitored = eps.every((e) => e.monitored);
            const isOpen = openSeason === s;
            return (
              <li key={s} className="border-b border-border last:border-0">
                <div className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <button className="flex items-center gap-2 text-left font-medium" onClick={() => setOpenSeason(isOpen ? null : s)} aria-expanded={isOpen}>
                    {s === 0 ? 'Specials' : `Season ${s}`}
                    <span className={`text-sm font-normal ${have === eps.length ? 'text-success' : 'text-muted'}`}>
                      {have} / {eps.length} files
                    </span>
                  </button>
                  <div className="flex flex-wrap gap-2 text-sm">
                    <label className="flex items-center gap-1 text-muted">
                      <input type="checkbox" checked={allMonitored} onChange={(e) => run(() => api(`/api/monitored/${mon.id}/episodes`, { method: 'PATCH', body: { season: s, monitored: e.target.checked } }), e.target.checked ? `Monitoring season ${s}.` : `Stopped monitoring season ${s}.`)} />
                      Monitored
                    </label>
                    <button className="btn-secondary" onClick={() => void search(`s${s}`, { season: s })}>
                      Search
                    </button>
                    <button className="btn-secondary" onClick={() => setManual({ season: s })}>
                      Manual
                    </button>
                    {have > 0 && (
                      <button className="btn-secondary" onClick={() => setDeleting({ scope: 'season', season: s, label: `season ${s} files` })}>
                        Delete
                      </button>
                    )}
                  </div>
                </div>
                {rowMsg?.key === `s${s}` && <div className="pb-2">{rowAlert(`s${s}`)}</div>}
                {isOpen && (
                  <ul className="space-y-1 pb-3 text-sm">
                    {eps.map((e) => {
                      const f = fileFor(e.filePath);
                      const aired = e.airDate && e.airDate <= today();
                      const dl = downloadFor(s, e.episode);
                      return (
                        <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded px-2 py-1.5 hover:bg-surface-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <input
                              type="checkbox"
                              aria-label={`Monitor episode ${e.episode}`}
                              checked={e.monitored}
                              onChange={(ev) => run(() => api(`/api/monitored/${mon.id}/episodes`, { method: 'PATCH', body: { season: s, episode: e.episode, monitored: ev.target.checked } }), ev.target.checked ? 'Monitoring.' : 'Stopped monitoring.')}
                            />
                            <span className="min-w-0">
                              <span className="text-muted">E{pad(e.episode)}</span> {e.title}
                              <span className="block text-xs text-muted">
                                {e.filePath ? (
                                  <>
                                    {e.fileQuality} {f?.size != null && `· ${formatBytes(f.size)}`} {f?.exists === false && <span className="text-danger">· missing on disk</span>}
                                  </>
                                ) : aired ? (
                                  <span className="text-danger">Missing</span>
                                ) : (
                                  `Airs ${e.airDate ?? 'TBA'}`
                                )}
                              </span>
                              {dl && (!e.filePath || ACTIVE(dl)) && (
                                <span className="block text-xs">
                                  <DownloadStatus a={dl} />
                                </span>
                              )}
                            </span>
                          </div>
                          <div className="flex gap-1">
                            <button className="btn-secondary px-2 py-1 text-xs" title="Search automatically" onClick={() => void search(`s${s}e${e.episode}`, { season: s, episode: e.episode })}>
                              Search
                            </button>
                            <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setManual({ season: s, episode: e.episode })}>
                              Manual
                            </button>
                            {e.filePath && (
                              <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setDeleting({ scope: 'episode', season: s, episode: e.episode, label: `S${pad(s)}E${pad(e.episode)}` })}>
                                Delete
                              </button>
                            )}
                          </div>
                          {rowMsg?.key === `s${s}e${e.episode}` && <div className="w-full">{rowAlert(`s${s}e${e.episode}`)}</div>}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {renaming && <RenameModal id={mon.id} onClose={() => setRenaming(false)} onDone={done} />}
      {deleting && <DeleteModal id={mon.id} target={deleting} onClose={() => setDeleting(null)} onDone={done} />}
      {trailers && <TrailerManager monitoredId={mon.id} kind={m.kind} tmdbId={m.tmdbId} onClose={() => (setTrailers(false), void qc.invalidateQueries({ queryKey: ['local-trailers'] }))} />}
      {matching && (
        <MatchPicker
          kind={m.kind}
          title={mon.title}
          onClose={() => setMatching(false)}
          onPick={async (tmdbId) => {
            await api(`/api/monitored/${mon.id}/match`, { body: { tmdbId } });
            await qc.invalidateQueries({ queryKey: ['lookup'] });
            navigate(mediaPath(m.kind, tmdbId));
          }}
        />
      )}
      {removing && <RemoveModal mon={mon} onClose={() => setRemoving(false)} />}
      {manual && <ManualSearch monitoredId={mon.id} initialSeason={manual.season} episode={manual.episode} onClose={() => setManual(null)} />}
    </section>
  );
}
