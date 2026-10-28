import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, formatAge, formatBytes, hasRole } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { MediaDetail } from '../pages/MediaDetail';
import { PosterPicker, useCreateSeriesCollection } from './Extras';
import { Modal } from './Modal';
import { Alert } from './ui';

interface Profile {
  id: number;
  name: string;
}

interface Lookup {
  monitored: {
    id: number;
    monitored: boolean;
    profileId?: number;
    wanted?: number;
    fileQuality?: string | null;
    seasons?: number[] | null;
    rootId?: string | null;
    maxSizeMb?: number | null;
    largerFiles?: boolean;
    defaultMaxSizeMb?: number | null;
    path?: string | null;
  } | null;
  request: { id: number; status: string; requestedByName: string | null; reason: string | null } | null;
  /** Managers: the title's folder on disk and the root folder it's in. */
  folder?: string | null;
  folderRoot?: string;
}

interface ReleaseRow {
  guid: string;
  title: string;
  indexer: string;
  protocol: string;
  size: number;
  seeders: number | null;
  publishedAt: number | null;
  quality: string;
  languages: string[];
  accepted: boolean;
  rejections: string[];
  /** Size per movie or episode when over the size limit. */
  oversize: number | null;
  /** The status of this release's download when it was already sent for this title. */
  grabbed: string | null;
}

/** How a sent release is doing, in a few words. */
const GRABBED_LABEL: Record<string, string> = {
  held: 'Waiting for confirmation',
  queued: 'Sent, queued',
  downloading: 'Downloading',
  paused: 'Paused',
  completed: 'Downloaded, importing',
  importing: 'Importing',
  imported: 'Downloaded',
  failed: 'Failed',
};

export interface RootFolder {
  id: string;
  name: string;
  kind: 'movie' | 'show';
  path: string;
}

export function useRootFolders(enabled: boolean) {
  return useQuery({ queryKey: ['root-folders'], queryFn: () => api<{ roots: RootFolder[]; destinations: { key: string; name: string; path: string }[] }>('/api/root-folders'), enabled });
}

/** Picks a root folder; renders nothing when there is only the main one. An empty value asks for a choice. */
export function RootPicker({ roots, value, onChange }: { roots: RootFolder[]; value: string; onChange: (id: string) => void }) {
  if (roots.length < 2) return null;
  return (
    <select className="input w-auto" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Folder">
      {!value && (
        <option value="" disabled>
          Choose a library…
        </option>
      )}
      {roots.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
        </option>
      ))}
    </select>
  );
}

/** Where a monitored title lives and how big a release may be. */
function FolderAndSize({ mon, kind, roots, onClose, onSaved }: { mon: NonNullable<Lookup['monitored']>; kind: 'movie' | 'show'; roots: RootFolder[]; onClose: () => void; onSaved: () => void }) {
  const [rootId, setRootId] = useState(mon.rootId ?? 'default');
  const [mode, setMode] = useState<'default' | 'double' | 'none' | 'custom'>(mon.maxSizeMb === null || mon.maxSizeMb === undefined ? (mon.largerFiles ? 'double' : 'default') : mon.maxSizeMb === 0 ? 'none' : 'custom');
  const [gb, setGb] = useState(mon.maxSizeMb ? String(Math.round((mon.maxSizeMb / 1024) * 10) / 10) : '');
  const [msg, setMsg] = useState<string | null>(null);
  const save = async () => {
    setMsg(null);
    try {
      const maxSizeMb = mode === 'default' || mode === 'double' ? null : mode === 'none' ? 0 : Math.round(Number(gb) * 1024);
      if (mode === 'custom' && !(maxSizeMb && maxSizeMb > 0)) throw new Error('Enter a size in GB');
      await api(`/api/monitored/${mon.id}`, { method: 'PATCH', body: { rootId, maxSizeMb, largerFiles: mode === 'double' } });
      onSaved();
      onClose();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const per = kind === 'show' ? 'per episode' : 'for the movie';
  const limit = (mb: number) => `${Math.round((mb / 1024) * 10) / 10} GB`;
  const def = mon.defaultMaxSizeMb;
  return (
    <Modal title="Folder and size" onClose={onClose}>
      <div className="space-y-4">
        {msg && <Alert>{msg}</Alert>}
        {roots.length > 1 && (
          <label className="block">
            <span className="label">Folder</span>
            <RootPicker roots={roots} value={rootId} onChange={setRootId} />
            {mon.path && rootId !== (mon.rootId ?? 'default') && <span className="hint block">The files already downloaded move to the new folder.</span>}
          </label>
        )}
        <fieldset className="space-y-1">
          <legend className="label">Largest release {per}</legend>
          {(
            [
              ['default', def ? `Use the default, ${limit(def)} (Settings → Media management)` : 'Use the default (Settings → Media management)'],
              ['double', def ? `Allow larger files: twice the default, ${limit(def * 2)}` : 'Allow larger files: twice the default'],
              ['none', 'No limit'],
              ['custom', 'Up to'],
            ] as const
          ).map(([v, label]) => (
            <label key={v} className="flex items-center gap-2 text-sm">
              <input type="radio" name="size" checked={mode === v} onChange={() => setMode(v)} />
              {label}
              {v === 'custom' && (
                <>
                  <input className="input w-24" type="number" min={0.1} step={0.1} value={gb} onChange={(e) => (setGb(e.target.value), setMode('custom'))} aria-label="Size in GB" /> GB
                </>
              )}
            </label>
          ))}
          <p className="hint">Bigger releases are only grabbed when nothing smaller is found, and you get a warning when that happens.</p>
        </fieldset>
        <button className="btn-primary" onClick={save}>
          Save
        </button>
      </div>
    </Modal>
  );
}

/** Moves a title's folder to another root folder, such as Movies → Kids Movies. */
function MoveFolder({ kind, tmdbId, folder, current, roots, onClose, onMoved }: { kind: 'movie' | 'show'; tmdbId: number; folder: string; current: string; roots: RootFolder[]; onClose: () => void; onMoved: (to: string) => void }) {
  const [rootId, setRootId] = useState(roots.find((r) => r.id !== current)?.id ?? current);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const move = async () => {
    setMsg(null);
    setBusy(true);
    try {
      await api(`/api/files/${kind}/${tmdbId}/move`, { body: { rootId } });
      onMoved(roots.find((r) => r.id === rootId)?.name ?? rootId);
      onClose();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Move to another folder" onClose={onClose}>
      <div className="space-y-4">
        {msg && <Alert>{msg}</Alert>}
        <p className="text-sm">
          Now in <span className="font-medium">{roots.find((r) => r.id === current)?.name ?? 'its folder'}</span>
          <span className="block break-all text-xs text-muted">{folder}</span>
        </p>
        <label className="block">
          <span className="label">Move to</span>
          <RootPicker roots={roots} value={rootId} onChange={setRootId} />
        </label>
        <p className="hint">The whole folder moves, and Plex/Jellyfin are asked to rescan. It shows up in the other library once they have.</p>
        <button className="btn-primary" disabled={busy || rootId === current} onClick={move}>
          {busy ? 'Moving…' : 'Move'}
        </button>
      </div>
    </Modal>
  );
}

function SeasonPicker({ seasons, value, onChange }: { seasons: MediaDetail['seasons']; value: number[]; onChange: (v: number[]) => void }) {
  const real = seasons.filter((s) => s.seasonNumber > 0);
  return (
    <div className="space-y-1">
      {real.map((s) => (
        <label key={s.seasonNumber} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={value.includes(s.seasonNumber)}
            onChange={(e) => onChange(e.target.checked ? [...value, s.seasonNumber] : value.filter((x) => x !== s.seasonNumber))}
          />
          {s.name} <span className="text-xs text-muted">({s.onServer}/{s.episodeCount} on server)</span>
        </label>
      ))}
    </div>
  );
}

type ReleaseColumn = 'title' | 'quality' | 'size' | 'age' | 'peers';

/** Column sort for manual search. Null keeps the server's order (best first). Undated or peerless releases go last either way. */
function sortRows(rows: ReleaseRow[], sort: { by: ReleaseColumn; desc: boolean } | null): ReleaseRow[] {
  if (!sort) return rows;
  const value = (r: ReleaseRow): string | number | null =>
    sort.by === 'title' ? r.title.toLowerCase() : sort.by === 'quality' ? qualityOrder(r.quality) : sort.by === 'size' ? r.size : sort.by === 'age' ? (r.publishedAt === null ? null : -r.publishedAt) : r.seeders;
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    const c = x < y ? -1 : x > y ? 1 : 0;
    return sort.desc ? -c : c;
  });
}

/** Rough rank of a quality name ("WEBDL-1080p") by its resolution, for sorting. */
function qualityOrder(q: string): number {
  const res = /(\d{3,4})p/.exec(q)?.[1];
  return (res ? Number(res) : 0) + (/remux/i.test(q) ? 2 : /bluray/i.test(q) ? 1 : 0);
}

/** A column header that sorts the table: first click sorts one way, the second the other, the third goes back to best first. */
function SortHeader({ label, col, sort, onSort, first = 'asc' }: { label: string; col: ReleaseColumn; sort: { by: ReleaseColumn; desc: boolean } | null; onSort: (s: { by: ReleaseColumn; desc: boolean } | null) => void; first?: 'asc' | 'desc' }) {
  const active = sort?.by === col;
  const startDesc = first === 'desc';
  const next = () => onSort(!active ? { by: col, desc: startDesc } : sort.desc === startDesc ? { by: col, desc: !startDesc } : null);
  return (
    <th className="p-2" aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button className={`flex items-center gap-1 hover:text-text ${active ? 'text-text' : ''}`} onClick={next}>
        {label}
        <span aria-hidden className={active ? '' : 'opacity-40'}>
          {active ? (sort.desc ? '▼' : '▲') : '↕'}
        </span>
      </button>
    </th>
  );
}

/** Marks a release that was sent for this title: just now from this list, or earlier. */
function GrabbedNote({ now, before }: { now?: { status: string; error?: string }; before: string | null }) {
  if (now?.status === 'error') return <div className="text-xs text-danger">Couldn't send it: {now.error}</div>;
  if (now?.status === 'sending') return <div className="text-xs text-muted">Sending…</div>;
  if (now?.status === 'queued') return <div className="text-xs font-medium text-success">✓ Sent to the download client. Follow it on Downloads.</div>;
  if (!before) return null;
  return <div className={`text-xs font-medium ${before === 'failed' ? 'text-danger' : 'text-success'}`}>{before === 'failed' ? '✕' : '✓'} Grabbed before: {GRABBED_LABEL[before] ?? before}</div>;
}

export function ManualSearch({ monitoredId, onClose, initialSeason, episode }: { monitoredId: number; onClose: () => void; initialSeason?: number; episode?: number }) {
  const [season, setSeason] = useState<string>(initialSeason !== undefined ? String(initialSeason) : '');
  const params = new URLSearchParams();
  if (season) params.set('season', season);
  if (season && episode !== undefined) params.set('episode', String(episode));
  const qs = params.size ? `?${params}` : '';
  const res = useQuery({ queryKey: ['releases', monitoredId, season, episode], queryFn: () => api<{ releases: ReleaseRow[]; errors: string[] }>(`/api/monitored/${monitoredId}/releases${qs}`) });
  const [sort, setSort] = useState<{ by: ReleaseColumn; desc: boolean } | null>(null);
  const header = (label: string, col: ReleaseColumn, first?: 'asc' | 'desc') => <SortHeader label={label} col={col} sort={sort} onSort={setSort} first={first} />;
  // Grabs made here are marked on their own row, not in a message at the top.
  const [sentNow, setSentNow] = useState<Record<string, { status: string; error?: string }>>({});
  const grab = async (r: ReleaseRow) => {
    if (r.oversize !== null && !confirm(`"${r.title}" is ${formatBytes(r.size)}, over the size limit. Download it anyway?`)) return;
    setSentNow((s) => ({ ...s, [r.guid]: { status: 'sending' } }));
    try {
      await api(`/api/monitored/${monitoredId}/grab`, { body: { guid: r.guid } });
      setSentNow((s) => ({ ...s, [r.guid]: { status: 'queued' } }));
    } catch (e) {
      setSentNow((s) => ({ ...s, [r.guid]: { status: 'error', error: (e as Error).message } }));
    }
  };
  return (
    <Modal title={episode !== undefined ? `Manual search: S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}` : 'Manual search'} onClose={onClose} wide>
      <div className="mb-3 flex items-center gap-2">
        <label className="text-sm text-muted">
          Season{' '}
          <input className="input inline-block w-20" type="number" min={0} value={season} onChange={(e) => setSeason(e.target.value)} placeholder="all" />
        </label>
      </div>
      {res.isLoading && <p className="text-muted">Searching indexers…</p>}
      {res.data?.errors.map((e) => (
        <Alert key={e}>{e}</Alert>
      ))}
      <div className="max-h-[60vh] overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface text-left text-muted">
            <tr>
              {header('Release', 'title')}
              {header('Quality', 'quality', 'desc')}
              {header('Size', 'size', 'desc')}
              {header('Age', 'age')}
              {header('Peers', 'peers', 'desc')}
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {sortRows(res.data?.releases ?? [], sort).map((r) => (
              <tr key={r.guid} className="border-t border-border align-top">
                <td className="p-2">
                  <div className="break-all">{r.title}</div>
                  <div className="text-xs text-muted">
                    {r.indexer} · {r.protocol} · {r.languages.join(', ')}
                  </div>
                  {!r.accepted && <div className="text-xs text-danger">{r.rejections.join('; ')}</div>}
                  {r.oversize !== null && <div className="text-xs text-warning">Over the size limit ({formatBytes(r.oversize)}{season ? ' per episode' : ''})</div>}
                  <GrabbedNote now={sentNow[r.guid]} before={r.grabbed} />
                </td>
                <td className="whitespace-nowrap p-2">{r.quality}</td>
                <td className="whitespace-nowrap p-2">{formatBytes(r.size)}</td>
                <td className="whitespace-nowrap p-2" title={r.publishedAt ? new Date(r.publishedAt).toLocaleString() : undefined}>
                  {r.publishedAt ? (
                    <>
                      {formatAge(r.publishedAt)}
                      <div className="text-xs text-muted">{new Date(r.publishedAt).toLocaleDateString()}</div>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="p-2">{r.seeders ?? '—'}</td>
                <td className="p-2">
                  <button className={r.accepted && !r.grabbed && !sentNow[r.guid] ? 'btn-primary' : 'btn-secondary'} disabled={sentNow[r.guid]?.status === 'sending' || sentNow[r.guid]?.status === 'queued'} onClick={() => grab(r)}>
                    {sentNow[r.guid]?.status === 'queued' ? 'Sent' : r.grabbed && r.grabbed !== 'failed' ? 'Grab again' : 'Grab'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {res.data && !res.data.releases.length && <p className="p-2 text-muted">No releases found.</p>}
      </div>
    </Modal>
  );
}

/** Request / monitor / search controls on a movie or show page. What shows depends on the user's level. */
/** Asks which library folder a new title goes in, before it is downloaded or monitored. */
function ChooseFolder({ title, action, roots, onClose, onChosen }: { title: string; action: string; roots: RootFolder[]; onClose: () => void; onChosen: (rootId: string) => void }) {
  const [rootId, setRootId] = useState('');
  return (
    <Modal title={`Which library for ${title}?`} onClose={onClose}>
      <div className="space-y-2">
        {roots.map((r) => (
          <label key={r.id} className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 hover:bg-surface-2">
            <input type="radio" name="root" checked={rootId === r.id} onChange={() => setRootId(r.id)} />
            <span className="font-medium">{r.name}</span>
            <span className="truncate text-xs text-muted">{r.path}</span>
          </label>
        ))}
      </div>
      <button className="btn-primary mt-4" disabled={!rootId} onClick={() => onChosen(rootId)}>
        {action}
      </button>
    </Modal>
  );
}

export function MediaActions({ m }: { m: MediaDetail }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const isManager = hasRole(me, 'manager');
  const lookup = useQuery({ queryKey: ['lookup', m.kind, m.tmdbId], queryFn: () => api<Lookup>(`/api/monitored/lookup/${m.kind}/${m.tmdbId}`) });
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api<Profile[]>('/api/profiles'), enabled: isManager });
  const [requesting, setRequesting] = useState(false);
  const [seasons, setSeasons] = useState<number[]>(m.seasons.filter((s) => s.seasonNumber > 0 && s.onServer < s.episodeCount).map((s) => s.seasonNumber));
  const [manual, setManual] = useState(false);
  const [posters, setPosters] = useState(false);
  const [folderSize, setFolderSize] = useState(false);
  const [moving, setMoving] = useState(false);
  const rootQuery = useRootFolders(isManager);
  const roots = rootQuery.data?.roots.filter((r) => r.kind === m.kind) ?? [];
  // Empty until chosen: with several library folders, a manager is asked which one (unless it's already on disk in one).
  const [rootId, setRootId] = useState('');
  const [asking, setAsking] = useState<'download' | 'monitor' | null>(null);
  const createSeries = useCreateSeriesCollection();
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['lookup', m.kind, m.tmdbId] });

  const run = async (fn: () => Promise<unknown>, success: string | ((result: unknown) => string)) => {
    setMsg(null);
    try {
      const result = await fn();
      setMsg({ kind: 'success', text: typeof success === 'string' ? success : success(result) });
      await refresh();
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
  };

  // A user an admin trusts with this kind gets an approved request straight away.
  const requested = (r: unknown) => ((r as { status?: string } | null)?.status === 'approved' ? 'Added and searching.' : 'Requested. A manager will review it.');
  const mon = lookup.data?.monitored;
  const req = lookup.data?.request;
  const fullyAvailable = m.availability.status === 'on_server';
  const chosenRoot = rootId || lookup.data?.folderRoot || (roots.length > 1 ? '' : 'default');
  const download = (root: string) => run(() => api('/api/requests', { body: { kind: m.kind, tmdbId: m.tmdbId, ...(isManager ? { rootId: root } : {}) } }), requested);
  const monitorOnly = (root: string) =>
    run(() => api('/api/monitored', { body: { kind: m.kind, tmdbId: m.tmdbId, search: false, rootId: root } }), fullyAvailable ? 'Monitoring. Better releases will replace the file when the profile allows an upgrade.' : 'Monitoring. Nothing was searched now; new releases and the regular missing search will download it.');

  return (
    <>
      {/* Users can ask for a title even when it's already monitored but not on the server yet. */}
      {(!mon || !isManager) && !req && !(m.kind === 'movie' && fullyAvailable) && (
        <>
          <button className="btn-primary" onClick={() => (m.kind === 'show' ? setRequesting(true) : isManager && !chosenRoot ? setAsking('download') : download(chosenRoot))}>
            {isManager ? 'Download' : 'Request'}
          </button>
        </>
      )}
      {!mon && isManager && (
        <button
          className="btn-secondary"
          title="Adds it to monitoring without searching now. Search, upgrades and the missing-file search take it from there."
          onClick={() => (chosenRoot ? monitorOnly(chosenRoot) : setAsking('monitor'))}
        >
          {fullyAvailable ? 'Monitor for upgrades' : 'Monitor only'}
        </button>
      )}
      {req && (!mon || !isManager) && <span className="self-center text-sm text-muted">Requested by {req.requestedByName} · {req.status}</span>}
      {req?.status === 'declined' && req.reason && <span className="self-center text-sm text-danger">Declined: {req.reason}</span>}
      {mon && isManager && 'profileId' in mon && (
        <>
          <select
            className="input w-auto"
            value={mon.profileId}
            aria-label="Quality profile"
            onChange={async (e) => {
              const res = await api<{ upgradeCandidates: number }>(`/api/monitored/${mon.id}`, { method: 'PATCH', body: { profileId: Number(e.target.value) } });
              await refresh();
              // Ask before searching; if nothing better turns up, nothing changes.
              if (res.upgradeCandidates > 0 && confirm(`${res.upgradeCandidates} file(s) could be upgraded under this profile. Search for better releases now?`)) {
                await run(() => api(`/api/monitored/${mon.id}/search`, { body: {} }), 'Searching for upgrades. Existing files stay unless a better release is found.');
              }
            }}
          >
            {profiles.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="btn-secondary" onClick={() => run(() => api<{ message: string }>(`/api/monitored/${mon.id}/search`, { body: {} }), (r) => (r as { message: string }).message)}>
            Search now
          </button>
          <button className="btn-secondary" onClick={() => setManual(true)}>
            Manual search
          </button>
          <button className="btn-secondary" onClick={() => run(() => api(`/api/monitored/${mon.id}`, { method: 'PATCH', body: { monitored: !mon.monitored } }), mon.monitored ? 'Stopped monitoring.' : 'Monitoring.')}>
            {mon.monitored ? 'Unmonitor' : 'Monitor'}
          </button>
          <button className="btn-secondary" onClick={() => setFolderSize(true)}>
            {roots.length > 1 ? 'Folder and size' : 'Size limit'}
            {'largerFiles' in mon && mon.largerFiles && !mon.maxSizeMb && mon.maxSizeMb !== 0 ? ' (2×)' : ''}
          </button>
        </>
      )}
      {isManager && roots.length > 1 && lookup.data?.folder && (
        <button className="btn-secondary" onClick={() => setMoving(true)}>
          Move to folder
        </button>
      )}
      {isManager && (
        <button className="btn-secondary" onClick={() => setPosters(true)}>
          Change poster
        </button>
      )}
      {isManager && m.collection && (
        <button className="btn-secondary" onClick={() => run(() => createSeries(m.collection!), '')}>
          Add {m.collection.name} to your media servers
        </button>
      )}
      {msg && msg.text && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {posters && <PosterPicker kind={m.kind} tmdbId={m.tmdbId} onClose={() => setPosters(false)} />}
      {requesting && (
        <Modal title={`Request ${m.title}`} onClose={() => setRequesting(false)}>
          <p className="mb-3 text-sm text-muted">Pick the seasons you want.</p>
          <SeasonPicker seasons={m.seasons} value={seasons} onChange={setSeasons} />
          {isManager && roots.length > 1 && (
            <label className="mt-3 block">
              <span className="label">Library</span>
              <RootPicker roots={roots} value={chosenRoot} onChange={setRootId} />
            </label>
          )}
          <button
            className="btn-primary mt-4"
            disabled={!seasons.length || (isManager && !chosenRoot)}
            onClick={async () => {
              await run(() => api('/api/requests', { body: { kind: 'show', tmdbId: m.tmdbId, seasons, ...(isManager ? { rootId: chosenRoot } : {}) } }), requested);
              setRequesting(false);
            }}
          >
            {isManager ? 'Download' : 'Request'} {seasons.length} season{seasons.length === 1 ? '' : 's'}
          </button>
        </Modal>
      )}
      {moving && lookup.data?.folder && (
        <MoveFolder kind={m.kind} tmdbId={m.tmdbId} folder={lookup.data.folder} current={lookup.data.folderRoot ?? 'default'} roots={roots} onClose={() => setMoving(false)} onMoved={(to) => (refresh(), setMsg({ kind: 'success', text: `Moved to ${to}.` }))} />
      )}
      {asking && (
        <ChooseFolder
          title={m.title}
          action={asking === 'download' ? 'Download' : 'Monitor'}
          roots={roots}
          onClose={() => setAsking(null)}
          onChosen={(root) => {
            setAsking(null);
            setRootId(root);
            void (asking === 'download' ? download(root) : monitorOnly(root));
          }}
        />
      )}
      {manual && mon && <ManualSearch monitoredId={mon.id} onClose={() => setManual(false)} />}
      {folderSize && mon && <FolderAndSize mon={mon} kind={m.kind} roots={roots} onClose={() => setFolderSize(false)} onSaved={() => (refresh(), setMsg({ kind: 'success', text: 'Saved.' }))} />}
    </>
  );
}
