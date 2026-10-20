import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert } from '../components/ui';
import { useRootFolders } from '../components/MediaActions';
import { MatchPicker } from '../components/MatchPicker';
import { Modal } from '../components/Modal';
import type { MediaKind } from '../lib/media';
import { api, formatBytes, formatDate } from '../lib/api';

interface DownloadRow {
  id: number;
  title: string;
  quality: string | null;
  size: number | null;
  protocol: string;
  indexer: string | null;
  status: string;
  progress: number;
  error: string | null;
  addedAt: number;
  importedAt: number | null;
  speed: number | null;
  eta: number | null;
  warning: string | null;
  monitoredId: number | null;
  bookId: number | null;
}

/** "45 s", "12 min", "3 h 20 min". */
function formatEta(sec: number): string {
  if (sec < 60) return `${Math.round(sec)} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Seconds left: the client's own estimate, or worked out from the size, progress and speed. */
function etaOf(d: DownloadRow): number | null {
  if (d.eta !== null) return d.eta;
  if (!d.speed || !d.size || d.progress >= 1) return null;
  return (d.size * (1 - d.progress)) / d.speed;
}

/** Totals across the queue: how many, how big, how fast and how long. */
function QueueTotals({ rows }: { rows: DownloadRow[] }) {
  if (!rows.length) return null;
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  const total = rows.reduce((n, r) => n + (r.size ?? 0), 0);
  const left = rows.reduce((n, r) => n + (r.size ?? 0) * (1 - r.progress), 0);
  const speed = rows.reduce((n, r) => n + (r.speed ?? 0), 0);
  const etas = rows.filter((r) => r.status === 'downloading').map(etaOf).filter((e): e is number => e !== null);
  const parts = [
    count('held') && `${count('held')} waiting for you`,
    `${count('downloading')} downloading`,
    count('queued') && `${count('queued')} queued`,
    count('paused') && `${count('paused')} paused`,
    count('importing') + count('completed') && `${count('importing') + count('completed')} importing`,
  ].filter(Boolean);
  const stats: [string, string][] = [
    ['Total size', formatBytes(total)],
    ['Left to download', formatBytes(left)],
    ['Speed', speed ? `${formatBytes(speed)}/s` : '–'],
    ['Time left', etas.length ? formatEta(Math.max(...etas)) : '–'],
  ];
  return (
    <div className="card p-3" aria-label="Queue totals">
      <div className="text-sm font-medium">{parts.join(' · ')}</div>
      <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stats.map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-muted">{k}</dt>
            <dd className="text-sm">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The bar, with the percentage done and the time left beside it. */
function Progress({ d }: { d: DownloadRow }) {
  const pct = Math.floor(d.progress * 1000) / 10;
  const eta = d.status === 'downloading' ? etaOf(d) : null;
  return (
    <div className="flex items-center gap-3">
      <div className="h-1.5 flex-1 overflow-hidden rounded bg-surface-2" role="progressbar" aria-valuenow={Math.round(d.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full bg-accent" style={{ width: `${d.progress * 100}%` }} />
      </div>
      <span className="shrink-0 text-xs tabular-nums text-muted">
        {pct}%{eta !== null ? ` · ${formatEta(eta)} left` : ''}
      </span>
    </div>
  );
}

interface FoundRelease {
  guid: string;
  title: string;
  size: number;
  quality: string;
  protocol: string;
  indexer: string;
  seeders: number | null;
  peers: number | null;
  publishedAt: number | null;
  infoUrl: string | null;
}

/** A free-text search of the indexers (Prowlarr included); a result goes to the folder picked here. */
function IndexerSearch({ destinations }: { destinations: { key: string; name: string; path: string }[] }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [type, setType] = useState('any');
  const [destination, setDestination] = useState('downloads');
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ releases: FoundRelease[]; errors: string[] } | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [sent, setSent] = useState<Set<string>>(new Set());
  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      setFound(await api<{ releases: FoundRelease[]; errors: string[] }>(`/api/indexers/search?q=${encodeURIComponent(q)}&type=${type}`));
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const grab = async (r: FoundRelease) => {
    setMsg(null);
    try {
      await api('/api/downloads/release', { body: { guid: r.guid, destination } });
      setSent((s) => new Set([...s, r.guid]));
      const where = destinations.find((d) => d.key === destination);
      setMsg({ kind: 'success', text: destination === 'downloads' ? `Sent "${r.title}" to the download client.` : `Sent "${r.title}". When it finishes it goes to ${where?.name ?? 'the folder you picked'}.` });
      await qc.invalidateQueries({ queryKey: ['downloads'] });
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    }
  };
  return (
    <div className="card space-y-3">
      <h2 className="font-semibold">Search indexers</h2>
      <p className="text-sm text-muted">Search Prowlarr and your other indexers for anything, and pick where it goes when it finishes. For movies and shows you follow, the title's own search keeps them upgraded and renamed.</p>
      <form onSubmit={search} className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
        <input className="input" placeholder="What are you looking for?" value={q} onChange={(e) => setQ(e.target.value)} minLength={2} required aria-label="Search indexers" />
        <select className="input w-auto" value={type} onChange={(e) => setType(e.target.value)} aria-label="Category">
          <option value="any">Everything</option>
          <option value="movies">Movies</option>
          <option value="tv">TV</option>
          <option value="audiobooks">Audiobooks</option>
          <option value="books">Books</option>
        </select>
        <select className="input w-auto" value={destination} onChange={(e) => setDestination(e.target.value)} aria-label="When it finishes, put it in">
          {destinations.map((d) => (
            <option key={d.key} value={d.key}>
              {d.key === 'downloads' ? 'Leave it in the downloads folder' : `Put it in ${d.name}`}
            </option>
          ))}
        </select>
        <button className="btn-primary" disabled={busy}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </form>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {found?.errors.map((e) => (
        <Alert key={e} kind="info">
          {e}
        </Alert>
      ))}
      {found && (
        <ul className="max-h-[32rem] divide-y divide-border overflow-y-auto text-sm">
          {found.releases.map((r) => (
            <li key={r.guid} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="break-all">{r.infoUrl ? <a className="hover:underline" href={r.infoUrl} target="_blank" rel="noreferrer">{r.title}</a> : r.title}</div>
                <div className="text-xs text-muted">
                  {[r.quality !== 'Unknown' ? r.quality : null, formatBytes(r.size), r.protocol === 'torrent' && r.seeders !== null ? `${r.seeders} seeders` : null, r.protocol, r.indexer, r.publishedAt ? formatDate(r.publishedAt) : null]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              <button className="btn-secondary shrink-0 text-xs" disabled={sent.has(r.guid)} onClick={() => void grab(r)}>
                {sent.has(r.guid) ? 'Sent' : 'Download'}
              </button>
            </li>
          ))}
          {!found.releases.length && <li className="py-2 text-muted">Nothing found.</li>}
        </ul>
      )}
    </div>
  );
}

interface ImportableFile {
  path: string;
  folder: string;
  name: string;
  size: number;
  modifiedAt: number;
  guess: { kind: MediaKind; title: string; year: number | null; season: number | null; episodes: number[]; quality: string };
  imported: boolean;
}

const guessText = (g: ImportableFile['guess']) =>
  `${g.kind === 'movie' ? 'Movie' : 'Show'}: ${g.title || 'unknown'}${g.year ? ` (${g.year})` : ''}${g.season !== null ? ` S${String(g.season).padStart(2, '0')}${g.episodes.map((e) => `E${String(e).padStart(2, '0')}`).join('')}` : ''}${g.quality !== 'Unknown' ? ` · ${g.quality}` : ''}`;

/** One file: say what it is (movie, or show with season and episode), then pick the title on TMDB. */
function ImportDialog({ file, onDone, onClose }: { file: ImportableFile; onDone: (text: string) => void; onClose: () => void }) {
  const [kind, setKind] = useState<MediaKind>(file.guess.kind);
  const [season, setSeason] = useState(file.guess.season ?? 1);
  const [episodes, setEpisodes] = useState(file.guess.episodes.join(', ') || '1');
  const [mode, setMode] = useState('');
  const [picking, setPicking] = useState(false);
  const eps = episodes
    .split(/[,\s]+/)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0);
  const send = async (tmdbId: number) => {
    const body = { path: file.path, kind, tmdbId, ...(kind === 'show' ? { season, episodes: eps } : {}), ...(mode ? { mode } : {}) };
    const r = await api<{ imported: string[]; skipped: string[] }>('/api/manual-import', { body });
    onDone(`Imported to ${r.imported.join(', ')}${r.skipped.length ? `. Skipped: ${r.skipped.join('; ')}` : ''}`);
  };
  if (picking) return <MatchPicker kind={kind} title={file.guess.title} heading={`Which ${kind === 'movie' ? 'movie' : 'show'} is ${file.name}?`} onPick={send} onClose={onClose} />;
  return (
    <Modal title={`Import ${file.name}`} onClose={onClose}>
      <div className="space-y-3">
        <label className="block">
          <span className="label">This file is</span>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as MediaKind)}>
            <option value="movie">A movie</option>
            <option value="show">An episode of a show</option>
          </select>
        </label>
        {kind === 'show' && (
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="label">Season</span>
              <input className="input" type="number" min={0} value={season} onChange={(e) => setSeason(Number(e.target.value))} />
            </label>
            <label className="block">
              <span className="label">Episode (or several, like 1, 2)</span>
              <input className="input" value={episodes} onChange={(e) => setEpisodes(e.target.value)} />
            </label>
          </div>
        )}
        <label className="block">
          <span className="label">How</span>
          <select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="">As set in Media management</option>
            <option value="move">Move it into the library</option>
            <option value="copy">Copy it, leave the original</option>
            <option value="hardlink">Hardlink (keeps seeding, no extra space)</option>
          </select>
        </label>
        <p className="hint">It replaces any file the title or episode already has.</p>
        <button className="btn-primary" disabled={kind === 'show' && !eps.length} onClick={() => setPicking(true)}>
          Pick the {kind === 'movie' ? 'movie' : 'show'}
        </button>
      </div>
    </Modal>
  );
}

/** Files in the downloads and watch folders that can be imported by hand, e.g. ones that got stuck. */
function ManualImport() {
  const qc = useQueryClient();
  const [showImported, setShowImported] = useState(false);
  const [file, setFile] = useState<ImportableFile | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const list = useQuery({ queryKey: ['manual-import'], queryFn: () => api<{ folders: { name: string; path: string }[]; files: ImportableFile[] }>('/api/manual-import') });
  const files = (list.data?.files ?? []).filter((f) => showImported || !f.imported);
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Video files in {list.data?.folders.map((f) => `${f.name} (${f.path})`).join(' and ') || 'the downloads folder'}. Pick one, say which movie or episode it is, and it's renamed into your library.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showImported} onChange={(e) => setShowImported(e.target.checked)} /> Show files already imported
        </label>
        <button className="btn-secondary text-xs" onClick={() => void list.refetch()}>
          Refresh
        </button>
      </div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {list.error && <Alert>{(list.error as Error).message}</Alert>}
      <ul className="space-y-2">
        {files.map((f) => (
          <li key={f.path} className="card flex flex-wrap items-center justify-between gap-2 p-3">
            <div className="min-w-0">
              <div className="break-all text-sm font-medium">{f.name}</div>
              <div className="text-xs text-muted">{[f.folder, formatBytes(f.size), formatDate(f.modifiedAt), guessText(f.guess), f.imported ? 'already imported' : null].filter(Boolean).join(' · ')}</div>
            </div>
            <button className="btn-primary text-xs" onClick={() => setFile(f)}>
              Import…
            </button>
          </li>
        ))}
        {list.data && !files.length && <li className="card text-sm text-muted">Nothing waiting to be imported.</li>}
      </ul>
      {file && (
        <ImportDialog
          file={file}
          onClose={() => setFile(null)}
          onDone={(text) => {
            setMsg({ kind: 'success', text });
            void qc.invalidateQueries({ queryKey: ['manual-import'] });
            void qc.invalidateQueries({ queryKey: ['downloads'] });
          }}
        />
      )}
    </div>
  );
}

export function DownloadsPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'queue' | 'history' | 'import'>('queue');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [destination, setDestination] = useState('downloads');
  const roots = useRootFolders(true);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const list = useQuery({
    queryKey: ['downloads', tab],
    queryFn: () => api<DownloadRow[]>(`/api/downloads${tab === 'history' ? '?history=true' : ''}`),
    refetchInterval: tab === 'queue' ? 5000 : false,
  });

  const confirmHeld = async (d: DownloadRow) => {
    setMsg(null);
    try {
      await api(`/api/downloads/${d.id}/confirm`, { method: 'POST' });
    } catch (err) {
      alert((err as Error).message);
    }
    await qc.invalidateQueries({ queryKey: ['downloads'] });
  };

  const remove = async (d: DownloadRow, blocklist: boolean) => {
    if (!confirm(blocklist ? `Remove "${d.title}", blocklist it and look for another release?` : `Remove "${d.title}" from the queue and the download client?`)) return;
    await api(`/api/downloads/${d.id}?removeFromClient=true&blocklist=${blocklist}`, { method: 'DELETE' });
    await qc.invalidateQueries({ queryKey: ['downloads'] });
  };

  const direct = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      await api('/api/downloads/direct', { body: { url, name: name || null, destination } });
      setUrl('');
      setName('');
      const where = roots.data?.destinations.find((d) => d.key === destination);
      setMsg({ kind: 'success', text: destination === 'downloads' ? 'Download started. It stays in the downloads folder.' : `Download started. When it finishes it goes to ${where?.name ?? 'the folder you picked'}.` });
      await qc.invalidateQueries({ queryKey: ['downloads'] });
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Downloads</h1>
      <div className="flex gap-1 border-b border-border">
        {(['queue', 'history', 'import'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`border-b-2 px-3 py-2 text-sm capitalize ${tab === t ? 'border-accent text-accent' : 'border-transparent text-muted'}`}>
            {t}
          </button>
        ))}
      </div>
      {tab === 'import' && <ManualImport />}
      {tab === 'queue' && list.data && <QueueTotals rows={list.data} />}
      <ul className={`space-y-2 ${tab === 'import' ? 'hidden' : ''}`}>
        {list.data?.map((d) => (
          <li key={d.id} className="card space-y-2 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="break-all text-sm font-medium">{d.title}</div>
                <div className="text-xs text-muted">
                  {[
                    d.quality,
                    d.size ? formatBytes(d.size) : null,
                    tab === 'queue' && d.status === 'downloading' && d.speed ? `${formatBytes(d.speed)}/s` : null,
                    d.protocol,
                    d.indexer,
                    formatDate(d.addedAt),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                {d.error && <div className="text-xs text-danger">{d.error}</div>}
                {d.warning && <div className="text-xs text-warning">{d.warning}</div>}
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-xs ${d.status === 'held' ? 'text-warning' : 'capitalize text-muted'}`}>{d.status === 'held' ? 'Waiting for you' : d.status}</span>
                {tab === 'queue' && d.status === 'held' && (
                  <>
                    <button className="btn-primary text-xs" onClick={() => void confirmHeld(d)}>
                      Download anyway
                    </button>
                    <button className="btn-secondary text-xs" onClick={() => remove(d, false)}>
                      Don't download
                    </button>
                  </>
                )}
                {tab === 'queue' && d.status !== 'held' && (
                  <>
                    <button className="btn-secondary text-xs" onClick={() => remove(d, false)}>
                      Remove
                    </button>
                    {(d.monitoredId || d.bookId) && (
                      <button className="btn-danger text-xs" onClick={() => remove(d, true)}>
                        Blocklist and retry
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
            {tab === 'queue' && d.status !== 'held' && <Progress d={d} />}
          </li>
        ))}
        {list.data?.length === 0 && <li className="card text-sm text-muted">{tab === 'queue' ? 'Nothing downloading.' : 'No history yet.'}</li>}
      </ul>

      <IndexerSearch destinations={roots.data?.destinations ?? [{ key: 'downloads', name: 'Downloads folder (leave it there)', path: '' }]} />

      <form onSubmit={direct} className="card max-w-2xl space-y-3">
        <h2 className="font-semibold">Download from a link</h2>
        <p className="text-sm text-muted">Paste a link to a file, a .torrent link or a magnet link. Torrents go to your torrent client. Links to your home network are blocked unless an admin allows them.</p>
        {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
        <input className="input" placeholder="https://…  or  magnet:?xt=…" value={url} onChange={(e) => setUrl(e.target.value)} required aria-label="Link" />
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block">
            <span className="label">Name (optional)</span>
            <input className="input" placeholder="Keep the original name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
          </label>
          <label className="block">
            <span className="label">When it finishes, put it in</span>
            <select className="input" value={destination} onChange={(e) => setDestination(e.target.value)}>
              {(roots.data?.destinations ?? [{ key: 'downloads', name: 'Downloads folder (leave it there)', path: '' }]).map((d) => (
                <option key={d.key} value={d.key}>
                  {d.name}
                  {d.path && d.key !== 'downloads' ? ` (${d.path})` : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button className="btn-primary">Download</button>
      </form>
    </div>
  );
}
