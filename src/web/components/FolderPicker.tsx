import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { Modal } from './Modal';
import { Alert } from './ui';

export interface BrowseResult {
  roots: { id: string; name: string; path: string }[];
  current: string | null;
  parent: string | null;
  rootId: string | null;
  dirs: { name: string; path: string }[];
}

/**
 * Browses the media folders (and only them) to pick the folder a title lives in. Starts in the
 * title's current folder's parent when it has one, otherwise at the list of root folders.
 */
export function FolderPicker({ kind, title, start, onClose, onPick }: { kind: 'movie' | 'show'; title: string; start?: string | null; onClose: () => void; onPick: (path: string) => Promise<void> }) {
  const [at, setAt] = useState<string | null>(start ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const list = useQuery({
    queryKey: ['browse', kind, at],
    queryFn: () => api<BrowseResult>(`/api/files/browse?kind=${kind}${at ? `&path=${encodeURIComponent(at)}` : ''}`),
    retry: false,
  });
  // A start folder that's gone (or outside the media folders) falls back to the root folders.
  if (list.isError && at && at === start) setAt(null);
  const go = (p: string | null) => {
    setFilter('');
    setError(null);
    setAt(p);
  };
  const pick = async (p: string) => {
    setBusy(true);
    setError(null);
    try {
      await onPick(p);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const data = list.data;
  const dirs = (data?.dirs ?? []).filter((d) => !filter || d.name.toLowerCase().includes(filter.toLowerCase()));
  const root = data?.roots.find((r) => r.id === data.rootId && data.current?.startsWith(r.path));
  const inRoot = Boolean(data?.current && root && data.current !== root.path);
  return (
    <Modal title={`Choose the folder for ${title}`} onClose={onClose} wide>
      <p className="mb-3 text-sm text-muted">
        Pick the folder that holds this {kind === 'show' ? "show's episodes" : "movie's file"}. Only folders inside your media folders are shown. Cinemask then links the files it finds; nothing is moved or renamed.
      </p>
      {error && <Alert>{error}</Alert>}
      {list.isError && <Alert>{(list.error as Error).message}</Alert>}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <button className="btn-secondary" disabled={!at} onClick={() => go(null)}>
          Media folders
        </button>
        {data?.current && (
          <button className="btn-secondary" disabled={!data.parent} onClick={() => go(data.parent)} aria-label="Up one folder">
            ↑ Up
          </button>
        )}
        <span className="min-w-0 break-all text-muted">{data?.current ?? 'Pick a media folder'}</span>
      </div>
      {data?.current && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <input className="input w-56" placeholder="Filter folders" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter folders" />
          {inRoot && (
            <button className="btn-primary" disabled={busy} onClick={() => void pick(data.current!)}>
              Use this folder
            </button>
          )}
        </div>
      )}
      <ul className="max-h-[50vh] divide-y divide-border overflow-auto rounded border border-border text-sm">
        {list.isLoading && <li className="p-2 text-muted">Loading…</li>}
        {data && !dirs.length && <li className="p-2 text-muted">{filter ? 'No folders match.' : 'No folders here.'}</li>}
        {dirs.map((d) => (
          <li key={d.path} className="flex items-center justify-between gap-2 p-2">
            <button className="min-w-0 flex-1 truncate text-left hover:text-accent" onClick={() => go(d.path)} title={d.path}>
              📁 {d.name}
            </button>
            {data?.current && (
              <button className="btn-secondary" disabled={busy} onClick={() => void pick(d.path)}>
                Use
              </button>
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}
