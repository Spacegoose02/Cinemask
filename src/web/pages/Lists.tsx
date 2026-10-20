import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MediaGrid } from '../components/media';
import { Modal } from '../components/Modal';
import { Alert, Field, Toggle } from '../components/ui';
import { api, formatDate, hasRole } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { MediaCardData } from '../lib/media';

export interface ListRow {
  id: number;
  name: string;
  source: 'mdblist' | 'tmdb_list' | 'tmdb_discover' | 'csv';
  kind: 'movie' | 'show' | null;
  autoAdd: boolean;
  profileId: number | null;
  searchOnAdd: boolean;
  syncHours: number;
  lastSyncAt: number | null;
  lastError: string | null;
  itemCount: number;
}

const SOURCE_LABEL = { mdblist: 'mdblist', tmdb_list: 'TMDB list', tmdb_discover: 'Discover search', csv: 'Imported file' };

function ListSettings({ list, onClose }: { list: ListRow; onClose: () => void }) {
  const qc = useQueryClient();
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api<{ id: number; name: string }[]>('/api/profiles') });
  const [v, setV] = useState({ name: list.name, autoAdd: list.autoAdd, searchOnAdd: list.searchOnAdd, syncHours: list.syncHours, profileId: list.profileId });
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await api(`/api/lists/${list.id}`, { method: 'PUT', body: v });
      await qc.invalidateQueries({ queryKey: ['lists'] });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete the list "${list.name}"? Nothing that was downloaded is removed.`)) return;
    await api(`/api/lists/${list.id}`, { method: 'DELETE' });
    await qc.invalidateQueries({ queryKey: ['lists'] });
    onClose();
  };
  return (
    <Modal title={`${list.name} settings`} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name">
          <input className="input" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </Field>
        <Toggle label="Download new titles automatically" checked={v.autoAdd} onChange={(autoAdd) => setV({ ...v, autoAdd })} hint="Titles not on the server are monitored, up to 25 per sync." />
        {v.autoAdd && (
          <>
            <Toggle label="Search right away" checked={v.searchOnAdd} onChange={(searchOnAdd) => setV({ ...v, searchOnAdd })} />
            <Field label="Quality profile">
              <select className="input" value={v.profileId ?? ''} onChange={(e) => setV({ ...v, profileId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Default</option>
                {profiles.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
        {list.source !== 'csv' && (
          <Field label="Sync every (hours)">
            <input className="input" type="number" min={1} max={168} value={v.syncHours} onChange={(e) => setV({ ...v, syncHours: Number(e.target.value) })} />
          </Field>
        )}
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-between">
          <button className="btn-primary" onClick={save}>
            Save
          </button>
          <button className="btn-danger" onClick={remove}>
            Delete list
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AddList({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'url' | 'csv'>('url');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [autoAdd, setAutoAdd] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (tab === 'url') {
        const r = await api<{ sync: { ok: boolean; items?: number; error?: string } }>('/api/lists', { body: { name, url, autoAdd } });
        setMsg(r.sync.ok ? { kind: 'success', text: `Added with ${r.sync.items} titles.` } : { kind: 'error', text: `Added, but the first sync failed: ${r.sync.error}` });
      } else {
        const f = file.current?.files?.[0];
        if (!f) throw new Error('Pick a CSV file');
        const r = await api<{ imported: number; skipped: number }>(`/api/lists/import-csv?name=${encodeURIComponent(name)}`, { raw: await f.text(), headers: { 'content-type': 'text/plain' } });
        setMsg({ kind: 'success', text: `Imported ${r.imported} titles${r.skipped ? `; ${r.skipped} rows could not be matched` : ''}.` });
      }
      await qc.invalidateQueries({ queryKey: ['lists'] });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Add a list" onClose={onClose}>
      <div className="mb-4 flex gap-1 border-b border-border">
        {(['url', 'csv'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`border-b-2 px-3 py-2 text-sm ${tab === t ? 'border-accent text-accent' : 'border-transparent text-muted'}`}>
            {t === 'url' ? 'From a link' : 'Import a file'}
          </button>
        ))}
      </div>
      <div className="space-y-3">
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {tab === 'url' ? (
          <>
            <Field label="List link" hint="An mdblist.com list (needs the mdblist key in Settings → Metadata) or a themoviedb.org list. To follow a Discover search, use Save as list on the Discover page.">
              <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mdblist.com/lists/user/list-name" />
            </Field>
            <Toggle label="Download new titles automatically" checked={autoAdd} onChange={setAutoAdd} />
          </>
        ) : (
          <Field label="CSV file" hint="Exports from Yamtrack, IMDb lists, Letterboxd, or any sheet with a tmdb_id, imdb_id or title column.">
            <input ref={file} type="file" accept=".csv,text/csv" className="input" />
          </Field>
        )}
        {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
        <button className="btn-primary" disabled={busy || !name.trim()} onClick={submit}>
          {busy ? 'Working…' : 'Add list'}
        </button>
      </div>
    </Modal>
  );
}

export function ListsPage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const isManager = hasRole(me, 'manager');
  const lists = useQuery({ queryKey: ['lists'], queryFn: () => api<ListRow[]>('/api/lists') });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ListRow | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const sync = async (l: ListRow) => {
    const r = await api<{ ok: boolean; items?: number; added?: number; error?: string }>(`/api/lists/${l.id}/sync`, { body: {} });
    setMsg(r.ok ? { kind: 'success', text: `${l.name}: ${r.items} titles${r.added ? `, ${r.added} new ones monitored` : ''}.` } : { kind: 'error', text: `${l.name}: ${r.error}` });
    await qc.invalidateQueries({ queryKey: ['lists'] });
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Lists</h1>
        {isManager && (
          <button className="btn-primary" onClick={() => setAdding(true)}>
            Add list
          </button>
        )}
      </div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {lists.data && !lists.data.length && <div className="card text-sm text-muted">No lists yet. {isManager ? 'Add one from mdblist or TMDB, import a CSV, or save a Discover search.' : 'A manager can add some.'}</div>}
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {lists.data?.map((l) => (
          <li key={l.id} className="card space-y-2">
            <Link to={`/lists/${l.id}`} className="block text-lg font-semibold hover:text-accent">
              {l.name}
            </Link>
            <div className="text-sm text-muted">
              {SOURCE_LABEL[l.source]} · {l.itemCount} titles{l.autoAdd ? ' · auto-download' : ''}
            </div>
            <div className="text-xs text-muted">Synced {formatDate(l.lastSyncAt)}</div>
            {l.lastError && <div className="text-xs text-danger">{l.lastError}</div>}
            {isManager && (
              <div className="flex gap-2 pt-1">
                {l.source !== 'csv' && (
                  <button className="btn-secondary" onClick={() => sync(l)}>
                    Sync now
                  </button>
                )}
                <button className="btn-secondary" onClick={() => setEditing(l)}>
                  Settings
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {adding && <AddList onClose={() => setAdding(false)} />}
      {editing && <ListSettings list={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

export function ListDetailPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['list', id], queryFn: () => api<{ list: ListRow; items: MediaCardData[] }>(`/api/lists/${id}/items`) });
  if (q.error) return <Alert>{(q.error as Error).message}</Alert>;
  return (
    <div className="space-y-4">
      <div>
        <Link to="/lists" className="text-sm text-muted hover:text-accent">
          ← Lists
        </Link>
        <h1 className="text-2xl font-semibold">{q.data?.list.name}</h1>
        {q.data && <p className="text-sm text-muted">{q.data.items.length} titles</p>}
      </div>
      <MediaGrid items={q.data?.items ?? []} />
    </div>
  );
}
