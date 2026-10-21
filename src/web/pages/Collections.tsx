import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { MediaCard } from '../components/media';
import { Modal } from '../components/Modal';
import { Alert, Field, Toggle } from '../components/ui';
import { api, formatDate, hasRole } from '../lib/api';
import { collectionLibraries, inLibrary } from '../lib/collections';
import { useAuth } from '../lib/auth';
import { poster, type MediaCardData } from '../lib/media';
import type { ListRow } from './Lists';

interface Collection {
  id: number;
  name: string;
  description: string | null;
  poster: string | null;
  source: 'manual' | 'tmdb' | 'list' | 'plex' | 'jellyfin';
  syncPlex: boolean;
  syncJellyfin: boolean;
  plexLabel: string | null;
  fromLabel: string | null;
  lastPushAt: number | null;
  lastError: string | null;
  library: string | null;
  itemCount?: number;
  previewPosters?: (string | null)[];
  items?: (MediaCardData & { tmdbId: number })[];
}

type Msg = { kind: 'error' | 'success'; text: string } | null;

function Cover({ c }: { c: Collection }) {
  const main = poster(c.poster);
  if (main) return <img src={main} alt="" className="aspect-[2/3] w-full rounded-md border border-border object-cover" loading="lazy" />;
  // No cover yet: a 2x2 mosaic of the first posters.
  const tiles = (c.previewPosters ?? []).map((p) => poster(p, 'w185')).filter(Boolean);
  if (!tiles.length) return <div className="flex aspect-[2/3] w-full items-center justify-center rounded-md border border-border bg-surface-2 p-2 text-center text-sm text-muted">{c.name}</div>;
  return (
    <div className="grid aspect-[2/3] w-full grid-cols-2 overflow-hidden rounded-md border border-border bg-surface-2">
      {tiles.slice(0, 4).map((src, i) => (
        <img key={i} src={src!} alt="" className="h-full w-full object-cover" loading="lazy" />
      ))}
    </div>
  );
}

function NewCollection({ onClose, library: shownLibrary }: { onClose: () => void; library: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [source, setSource] = useState<'manual' | 'tmdb' | 'list' | 'label'>('manual');
  const [fromLabel, setFromLabel] = useState('');
  const [plexLabel, setPlexLabel] = useState('');
  const [name, setName] = useState('');
  const [q, setQ] = useState('');
  const [tmdb, setTmdb] = useState<{ id: number; name: string } | null>(null);
  const [listId, setListId] = useState<number | null>(null);
  const [syncPlex, setSyncPlex] = useState(true);
  const [syncJellyfin, setSyncJellyfin] = useState(false);
  // A collection made while looking at one library belongs to it.
  const [library, setLibrary] = useState(shownLibrary === 'all' ? '' : shownLibrary);
  const [error, setError] = useState<string | null>(null);
  const results = useQuery({ queryKey: ['tmdb-collections', q], queryFn: () => api<{ id: number; name: string; posterPath: string | null }[]>(`/api/collections/search-tmdb?q=${encodeURIComponent(q)}`), enabled: source === 'tmdb' && q.trim().length > 1 });
  const lists = useQuery({ queryKey: ['lists'], queryFn: () => api<ListRow[]>('/api/lists'), enabled: source === 'list' });
  const labels = useLabels();
  const create = async () => {
    try {
      const sourceId = source === 'tmdb' ? tmdb?.id : source === 'list' ? listId : undefined;
      const c = await api<Collection>('/api/collections', {
        body: { name: name || tmdb?.name || fromLabel, source: source === 'label' ? 'manual' : source, sourceId, syncPlex, syncJellyfin, fromLabel: source === 'label' ? fromLabel : null, plexLabel: plexLabel.trim() || null, library: library || null },
      });
      await qc.invalidateQueries({ queryKey: ['collections'] });
      navigate(`/collections/${c.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title="New collection" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Start from">
          <select className="input" value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
            <option value="manual">Nothing: I'll add titles myself</option>
            <option value="tmdb">A TMDB collection (e.g. a film series)</option>
            <option value="list">One of our lists (stays in sync)</option>
            <option value="label">A Plex label or Jellyfin tag (stays in sync)</option>
          </select>
        </Field>
        {source === 'label' && (
          <Field label="Label" hint="Everything carrying this label on Plex or tag on Jellyfin, as of the last library sync.">
            <input className="input" list="library-labels" value={fromLabel} onChange={(e) => setFromLabel(e.target.value)} placeholder="Kids" />
          </Field>
        )}
        {source === 'tmdb' && (
          <Field label="Search TMDB collections">
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Paddington" />
            <ul className="mt-1 max-h-48 overflow-auto">
              {results.data?.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => setTmdb(r)} className={`w-full rounded px-2 py-1 text-left text-sm ${tmdb?.id === r.id ? 'bg-accent text-accent-fg' : 'hover:bg-surface-2'}`}>
                    {r.name}
                  </button>
                </li>
              ))}
            </ul>
          </Field>
        )}
        {source === 'list' && (
          <Field label="List">
            <select className="input" value={listId ?? ''} onChange={(e) => setListId(Number(e.target.value) || null)}>
              <option value="">Pick a list</option>
              {lists.data?.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={tmdb?.name ?? 'Movie night favourites'} />
        </Field>
        <Toggle label="Keep a matching collection on Plex" checked={syncPlex} onChange={setSyncPlex} />
        <Toggle label="Keep a matching collection on Jellyfin" checked={syncJellyfin} onChange={setSyncJellyfin} />
        {syncPlex && <PlexLibraryField value={library} onChange={setLibrary} />}
        {syncPlex && (
          <Field label="Also label the items on Plex (optional)" hint="Plex smart collections and sharing restrictions can filter on labels. Pick a label only this collection uses: Cinemask takes it off anything not in the collection.">
            <input className="input" list="library-labels" value={plexLabel} onChange={(e) => setPlexLabel(e.target.value)} placeholder="Movie night" />
          </Field>
        )}
        <LabelOptions labels={labels.data?.labels} />
        {error && <Alert>{error}</Alert>}
        <button className="btn-primary" disabled={!(name.trim() || tmdb || (source === 'label' && fromLabel.trim())) || (source === 'label' && !fromLabel.trim()) || (source === 'tmdb' && !tmdb) || (source === 'list' && !listId)} onClick={create}>
          Create
        </button>
      </div>
    </Modal>
  );
}

export function CollectionsPage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const isManager = hasRole(me, 'manager');
  const cols = useQuery({ queryKey: ['collections'], queryFn: () => api<Collection[]>('/api/collections') });
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [params] = useSearchParams();
  const [picked, setPicked] = useState<string | null>(() => {
    // A link can name the library (the home page's "See all" opens Movies).
    if (params.get('library')) return params.get('library');
    try {
      return localStorage.getItem('collections-library');
    } catch {
      return null;
    }
  });
  const libraries = collectionLibraries(cols.data ?? []);
  // Movies first by default; a library that's gone falls back to it too.
  const library = picked === 'all' ? 'all' : picked && libraries.includes(picked) ? picked : (libraries[0] ?? 'all');
  const choose = (v: string) => {
    setPicked(v);
    try {
      localStorage.setItem('collections-library', v);
    } catch {
      // private window: the choice just isn't remembered
    }
  };
  // Collections made here, or from Jellyfin, belong to no library and show in every one.
  const shown = inLibrary(cols.data ?? [], library);
  const unsorted = (cols.data ?? []).some((c) => c.source === 'plex' && !c.library);
  const importFrom = async (server: 'plex' | 'jellyfin') => {
    try {
      const r = await api<{ imported: number; updated: number }>('/api/collections/import', { body: { server } });
      setMsg({ kind: 'success', text: `Imported ${r.imported} and updated ${r.updated} collections from ${server === 'plex' ? 'Plex' : 'Jellyfin'}.` });
      await qc.invalidateQueries({ queryKey: ['collections'] });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Collections</h1>
        {isManager && (
          <div className="flex flex-wrap gap-2">
            <button className="btn-secondary" onClick={() => importFrom('plex')}>
              Import from Plex
            </button>
            <button className="btn-secondary" onClick={() => importFrom('jellyfin')}>
              Import from Jellyfin
            </button>
            <button className="btn-primary" onClick={() => setCreating(true)}>
              New collection
            </button>
          </div>
        )}
      </div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {libraries.length > 0 && (
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Library</span>
          <select className="input w-auto" value={library} onChange={(e) => choose(e.target.value)}>
            {libraries.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
            <option value="all">All libraries</option>
          </select>
        </label>
      )}
      {isManager && unsorted && <Alert kind="info">Some Plex collections were imported before libraries were recorded. Import from Plex again to sort them into their libraries.</Alert>}
      {cols.data && !cols.data.length && <div className="card text-sm text-muted">No collections yet.</div>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
        {shown.map((c) => (
          <Link key={c.id} to={`/collections/${c.id}`} className="group">
            <Cover c={c} />
            <div className="mt-1.5 truncate text-sm group-hover:text-accent">{c.name}</div>
            <div className="text-xs text-muted">
              {c.itemCount} titles{library === 'all' && c.library ? ` · ${c.library}` : ''}
            </div>
          </Link>
        ))}
      </div>
      {creating && <NewCollection library={library} onClose={() => setCreating(false)} />}
    </div>
  );
}

function useLabels() {
  return useQuery({ queryKey: ['library-labels'], queryFn: () => api<{ labels: string[] }>('/api/library/labels') });
}

/** Which Plex library the collection lives in; empty puts it in every library that has its titles. */
function PlexLibraryField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const libs = useQuery({ queryKey: ['plex-libraries'], queryFn: () => api<{ libraries: string[] }>('/api/library/plex-libraries') });
  const options = libs.data?.libraries ?? [];
  return (
    <Field label="Plex library" hint="Only titles in this library join the collection on Plex, so Kids Movies and Movies keep their own collections.">
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Every library that has the titles</option>
        {[...new Set([...options, ...(value ? [value] : [])])].map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>
    </Field>
  );
}

function LabelOptions({ labels }: { labels?: string[] }) {
  return (
    <datalist id="library-labels">
      {labels?.map((l) => (
        <option key={l} value={l} />
      ))}
    </datalist>
  );
}

function EditCollection({ c, onClose }: { c: Collection; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [v, setV] = useState({ name: c.name, description: c.description ?? '', poster: c.poster?.startsWith('/') || c.poster?.startsWith('https://') ? c.poster : '', syncPlex: c.syncPlex, syncJellyfin: c.syncJellyfin, plexLabel: c.plexLabel ?? '', fromLabel: c.fromLabel ?? '', library: c.library ?? '' });
  const labels = useLabels();
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await api(`/api/collections/${c.id}`, { method: 'PUT', body: { ...v, library: v.library || null, plexLabel: v.plexLabel.trim() || null, fromLabel: c.source === 'manual' ? v.fromLabel.trim() || null : undefined, description: v.description || null, poster: v.poster || (c.poster && /^(plex|jellyfin):/.test(c.poster) ? undefined : null) } });
      await qc.invalidateQueries({ queryKey: ['collection', String(c.id)] });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete "${c.name}" from Cinemask? The collection on Plex/Jellyfin is left as it is.`)) return;
    await api(`/api/collections/${c.id}`, { method: 'DELETE' });
    await qc.invalidateQueries({ queryKey: ['collections'] });
    navigate('/collections');
  };
  return (
    <Modal title="Edit collection" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name">
          <input className="input" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </Field>
        <Field label="Description">
          <textarea className="input" rows={3} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
        </Field>
        <Field label="Cover image link" hint="An https link to an image, e.g. from ThePosterDB or TMDB. Pushed to Plex/Jellyfin with the collection.">
          <input className="input" value={v.poster ?? ''} onChange={(e) => setV({ ...v, poster: e.target.value })} placeholder="https://…" />
        </Field>
        <Toggle label="Sync to Plex" checked={v.syncPlex} onChange={(syncPlex) => setV({ ...v, syncPlex })} />
        <Toggle label="Sync to Jellyfin" checked={v.syncJellyfin} onChange={(syncJellyfin) => setV({ ...v, syncJellyfin })} />
        {v.syncPlex && <PlexLibraryField value={v.library} onChange={(library) => setV({ ...v, library })} />}
        {v.syncPlex && (
          <Field label="Label the items on Plex" hint="Leave empty for no label. Pick a label only this collection uses: Cinemask takes it off anything not in the collection.">
            <input className="input" list="library-labels" value={v.plexLabel} onChange={(e) => setV({ ...v, plexLabel: e.target.value })} />
          </Field>
        )}
        {c.source === 'manual' && (
          <Field label="Fill from a label" hint="Keeps the collection to everything with this Plex label or Jellyfin tag. Leave empty to add titles by hand.">
            <input className="input" list="library-labels" value={v.fromLabel} onChange={(e) => setV({ ...v, fromLabel: e.target.value })} />
          </Field>
        )}
        <LabelOptions labels={labels.data?.labels} />
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-between">
          <button className="btn-primary" onClick={save}>
            Save
          </button>
          <button className="btn-danger" onClick={remove}>
            Delete
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AddTitle({ id, onAdded }: { id: number; onAdded: () => void }) {
  const [q, setQ] = useState('');
  const res = useQuery({ queryKey: ['search', q], queryFn: () => api<{ results: (MediaCardData & { tmdbId: number })[] }>(`/api/search?q=${encodeURIComponent(q)}`), enabled: q.trim().length > 1 });
  const add = async (r: MediaCardData & { tmdbId: number }) => {
    await api(`/api/collections/${id}/items`, { body: { kind: r.kind, tmdbId: r.tmdbId } });
    onAdded();
  };
  return (
    <div className="space-y-2">
      <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search for a movie or show to add" aria-label="Add a title" />
      {res.data && (
        <ul className="max-h-60 overflow-auto rounded border border-border">
          {res.data.results.slice(0, 10).map((r) => (
            <li key={`${r.kind}-${r.tmdbId}`} className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5 text-sm last:border-0">
              <span className="truncate">
                {r.title} <span className="text-muted">({r.year ?? '?'}) · {r.kind === 'movie' ? 'Movie' : 'Series'}</span>
              </span>
              <button className="btn-secondary px-2 py-1 text-xs" onClick={() => add(r)}>
                Add
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CollectionDetailPage() {
  const { id } = useParams();
  const { me } = useAuth();
  const qc = useQueryClient();
  const isManager = hasRole(me, 'manager');
  const q = useQuery({ queryKey: ['collection', id], queryFn: () => api<Collection>(`/api/collections/${id}`) });
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['collection', id] });
  const run = async (fn: () => Promise<string>) => {
    setMsg(null);
    try {
      setMsg({ kind: 'success', text: await fn() });
      await refresh();
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
  };
  if (q.error) return <Alert>{(q.error as Error).message}</Alert>;
  const c = q.data;
  if (!c) return <div className="text-muted">Loading…</div>;
  const missing = c.items?.filter((i) => i.availability?.status === 'not_on_server').length ?? 0;
  const editable = c.source !== 'tmdb' && c.source !== 'list' && !c.fromLabel;
  const pushSummary = (r: Record<string, { added: number; removed: number; notOnServer: number } | null>) =>
    Object.entries(r)
      .filter(([k, v]) => v && k !== 'lastError')
      .map(([k, v]) => `${k === 'plex' ? 'Plex' : 'Jellyfin'}: ${v!.added} added, ${v!.removed} removed${v!.notOnServer ? `, ${v!.notOnServer} not on the server` : ''}`)
      .join('. ');

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-5 sm:flex-row">
        <div className="w-40 shrink-0">
          <Cover c={{ ...c, previewPosters: c.items?.slice(0, 4).map((i) => i.posterPath) }} />
        </div>
        <div className="min-w-0 space-y-2">
          <Link to="/collections" className="text-sm text-muted hover:text-accent">
            ← Collections
          </Link>
          <h1 className="text-2xl font-semibold">{c.name}</h1>
          {c.description && <p className="max-w-2xl text-sm text-muted">{c.description}</p>}
          <div className="text-xs text-muted">
            {c.items?.length} titles · {[c.syncPlex && 'Plex', c.syncJellyfin && 'Jellyfin'].filter(Boolean).join(' and ') || 'Not synced to a server'}
            {c.lastPushAt && ` · last synced ${formatDate(c.lastPushAt)}`}
          </div>
          {c.lastError && <div className="text-xs text-danger">{c.lastError}</div>}
          {isManager && (
            <div className="flex flex-wrap gap-2 pt-1">
              {(c.syncPlex || c.syncJellyfin) && (
                <button className="btn-primary" onClick={() => run(async () => pushSummary(await api(`/api/collections/${c.id}/push`, { body: {} })) || 'Synced.')}>
                  Sync to servers
                </button>
              )}
              {missing > 0 && (
                <button className="btn-secondary" onClick={() => run(async () => `Monitoring ${(await api<{ added: number }>(`/api/collections/${c.id}/download-missing`, { body: {} })).added} titles.`)}>
                  Download {missing} missing
                </button>
              )}
              {!editable && (
                <button className="btn-secondary" onClick={() => run(async () => `${(await api<{ items: number }>(`/api/collections/${c.id}/refresh`, { body: {} })).items} titles.`)}>
                  Refresh
                </button>
              )}
              <button className="btn-secondary" onClick={() => setEditing(true)}>
                Edit
              </button>
            </div>
          )}
          {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
        </div>
      </div>
      {isManager && editable && <AddTitle id={c.id} onAdded={refresh} />}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-4">
        {c.items?.map((i) => (
          <div key={`${i.kind}-${i.tmdbId}`} className="relative">
            <MediaCard item={i} />
            {isManager && editable && (
              <button
                className="absolute right-1 top-1 rounded bg-black/70 px-1.5 text-xs text-white hover:bg-danger"
                aria-label={`Remove ${i.title}`}
                onClick={() => run(async () => (await api(`/api/collections/${c.id}/items/${i.kind}/${i.tmdbId}`, { method: 'DELETE' }), `Removed ${i.title}.`))}
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
      {editing && <EditCollection c={c} onClose={() => setEditing(false)} />}
    </div>
  );
}
