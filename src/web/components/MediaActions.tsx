import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, formatBytes, hasRole } from '../lib/api';
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
    path?: string | null;
  } | null;
  request: { id: number; status: string; requestedByName: string | null; reason: string | null } | null;
}

interface ReleaseRow {
  guid: string;
  title: string;
  indexer: string;
  protocol: string;
  size: number;
  seeders: number | null;
  quality: string;
  languages: string[];
  accepted: boolean;
  rejections: string[];
  /** Size per movie or episode when over the size limit. */
  oversize: number | null;
}

export interface RootFolder {
  id: string;
  name: string;
  kind: 'movie' | 'show';
  path: string;
}

export function useRootFolders(enabled: boolean) {
  return useQuery({ queryKey: ['root-folders'], queryFn: () => api<{ roots: RootFolder[]; destinations: { key: string; name: string; path: string }[] }>('/api/root-folders'), enabled });
}

/** Picks a root folder; renders nothing when there is only the main one. */
function RootPicker({ roots, value, onChange }: { roots: RootFolder[]; value: string; onChange: (id: string) => void }) {
  if (roots.length < 2) return null;
  return (
    <select className="input w-auto" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Folder">
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
  const [mode, setMode] = useState<'default' | 'none' | 'custom'>(mon.maxSizeMb === null || mon.maxSizeMb === undefined ? 'default' : mon.maxSizeMb === 0 ? 'none' : 'custom');
  const [gb, setGb] = useState(mon.maxSizeMb ? String(Math.round((mon.maxSizeMb / 1024) * 10) / 10) : '');
  const [msg, setMsg] = useState<string | null>(null);
  const save = async () => {
    setMsg(null);
    try {
      const maxSizeMb = mode === 'default' ? null : mode === 'none' ? 0 : Math.round(Number(gb) * 1024);
      if (mode === 'custom' && !(maxSizeMb && maxSizeMb > 0)) throw new Error('Enter a size in GB');
      await api(`/api/monitored/${mon.id}`, { method: 'PATCH', body: { rootId, maxSizeMb } });
      onSaved();
      onClose();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const per = kind === 'show' ? 'per episode' : 'for the movie';
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
              ['default', 'Use the default (Settings → Media management)'],
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

export function ManualSearch({ monitoredId, onClose, initialSeason, episode }: { monitoredId: number; onClose: () => void; initialSeason?: number; episode?: number }) {
  const [season, setSeason] = useState<string>(initialSeason !== undefined ? String(initialSeason) : '');
  const params = new URLSearchParams();
  if (season) params.set('season', season);
  if (season && episode !== undefined) params.set('episode', String(episode));
  const qs = params.size ? `?${params}` : '';
  const res = useQuery({ queryKey: ['releases', monitoredId, season, episode], queryFn: () => api<{ releases: ReleaseRow[]; errors: string[] }>(`/api/monitored/${monitoredId}/releases${qs}`) });
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const grab = async (r: ReleaseRow) => {
    try {
      await api(`/api/monitored/${monitoredId}/grab`, { body: { guid: r.guid } });
      setMsg({ kind: 'success', text: `Sent "${r.title}" to the download client.` });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
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
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {res.isLoading && <p className="text-muted">Searching indexers…</p>}
      {res.data?.errors.map((e) => (
        <Alert key={e}>{e}</Alert>
      ))}
      <div className="max-h-[60vh] overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface text-left text-muted">
            <tr>
              <th className="p-2">Release</th>
              <th className="p-2">Quality</th>
              <th className="p-2">Size</th>
              <th className="p-2">Peers</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {res.data?.releases.map((r) => (
              <tr key={r.guid} className="border-t border-border align-top">
                <td className="p-2">
                  <div className="break-all">{r.title}</div>
                  <div className="text-xs text-muted">
                    {r.indexer} · {r.protocol} · {r.languages.join(', ')}
                  </div>
                  {!r.accepted && <div className="text-xs text-danger">{r.rejections.join('; ')}</div>}
                  {r.oversize !== null && <div className="text-xs text-warning">Over the size limit ({formatBytes(r.oversize)}{season ? ' per episode' : ''})</div>}
                </td>
                <td className="whitespace-nowrap p-2">{r.quality}</td>
                <td className="whitespace-nowrap p-2">{formatBytes(r.size)}</td>
                <td className="p-2">{r.seeders ?? '—'}</td>
                <td className="p-2">
                  <button className={r.accepted ? 'btn-primary' : 'btn-secondary'} onClick={() => grab(r)}>
                    Grab
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
  const rootQuery = useRootFolders(isManager);
  const roots = rootQuery.data?.roots.filter((r) => r.kind === m.kind) ?? [];
  const [rootId, setRootId] = useState('default');
  const createSeries = useCreateSeriesCollection();
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['lookup', m.kind, m.tmdbId] });

  const run = async (fn: () => Promise<unknown>, success: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: 'success', text: success });
      await refresh();
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
  };

  const mon = lookup.data?.monitored;
  const req = lookup.data?.request;
  const fullyAvailable = m.availability.status === 'on_server';

  return (
    <>
      {!mon && !req && !(m.kind === 'movie' && fullyAvailable) && (
        <>
          {isManager && m.kind === 'movie' && <RootPicker roots={roots} value={rootId} onChange={setRootId} />}
          <button className="btn-primary" onClick={() => (m.kind === 'show' ? setRequesting(true) : run(() => api('/api/requests', { body: { kind: m.kind, tmdbId: m.tmdbId, ...(isManager ? { rootId } : {}) } }), isManager ? 'Added and searching.' : 'Requested. A manager will review it.'))}>
            {isManager ? 'Download' : 'Request'}
          </button>
        </>
      )}
      {!mon && isManager && (
        <button
          className="btn-secondary"
          title="Adds it to monitoring without searching now. Search, upgrades and the missing-file search take it from there."
          onClick={() => run(() => api('/api/monitored', { body: { kind: m.kind, tmdbId: m.tmdbId, search: false, rootId } }), fullyAvailable ? 'Monitoring. Better releases will replace the file when the profile allows an upgrade.' : 'Monitoring. Nothing was searched now; new releases and the regular missing search will download it.')}
        >
          {fullyAvailable ? 'Monitor for upgrades' : 'Monitor only'}
        </button>
      )}
      {req && !mon && <span className="self-center text-sm text-muted">Requested by {req.requestedByName} · {req.status}</span>}
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
          <button className="btn-secondary" onClick={() => run(() => api(`/api/monitored/${mon.id}/search`, { body: {} }).then((r) => r), 'Search finished.')}>
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
          </button>
        </>
      )}
      {isManager && (
        <button className="btn-secondary" onClick={() => setPosters(true)}>
          Change poster
        </button>
      )}
      {isManager && m.collection && (
        <button className="btn-secondary" onClick={() => run(() => createSeries(m.collection!), '')}>
          Add {m.collection.name} to Plex/Jellyfin
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
              <span className="label">Folder</span>
              <RootPicker roots={roots} value={rootId} onChange={setRootId} />
            </label>
          )}
          <button
            className="btn-primary mt-4"
            disabled={!seasons.length}
            onClick={async () => {
              await run(() => api('/api/requests', { body: { kind: 'show', tmdbId: m.tmdbId, seasons, ...(isManager ? { rootId } : {}) } }), isManager ? 'Added and searching.' : 'Requested. A manager will review it.');
              setRequesting(false);
            }}
          >
            {isManager ? 'Download' : 'Request'} {seasons.length} season{seasons.length === 1 ? '' : 's'}
          </button>
        </Modal>
      )}
      {manual && mon && <ManualSearch monitoredId={mon.id} onClose={() => setManual(false)} />}
      {folderSize && mon && <FolderAndSize mon={mon} kind={m.kind} roots={roots} onClose={() => setFolderSize(false)} onSaved={() => (refresh(), setMsg({ kind: 'success', text: 'Saved.' }))} />}
    </>
  );
}
