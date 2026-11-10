import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import type { MediaDetail } from '../pages/MediaDetail';
import { Modal } from './Modal';
import { Alert } from './ui';

export interface WatchmaskList {
  id: number;
  name: string;
  itemsCount: number;
  isPublic: boolean;
  publicSlug: string | null;
  owner: string | null;
}

export interface WatchmaskLists {
  connected: boolean;
  defaultListId: number | null;
  lists: WatchmaskList[];
}

/** Watchmask's lists, for managers. Shared by the title page and Settings. */
export function useWatchmaskLists(enabled: boolean) {
  return useQuery({ queryKey: ['watchmask-lists'], queryFn: () => api<WatchmaskLists>('/api/watchmask/lists'), enabled, retry: false, staleTime: 5 * 60 * 1000 });
}

/**
 * "Add to <default list>" and a picker for every Watchmask list, on a movie or show page.
 * Shows nothing until Watchmask is connected in Settings → Metadata.
 */
export function WatchmaskButtons({ m }: { m: MediaDetail }) {
  const qc = useQueryClient();
  const lists = useWatchmaskLists(true);
  const connected = Boolean(lists.data?.connected);
  const memberKey = ['watchmask-member', m.kind, m.tmdbId];
  const member = useQuery({ queryKey: memberKey, queryFn: () => api<{ listIds: number[] }>(`/api/watchmask/titles/${m.kind}/${m.tmdbId}`), enabled: connected, retry: false });
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  if (!connected || !lists.data) return null;

  const inList = new Set(member.data?.listIds ?? []);
  const def = lists.data.lists.find((l) => l.id === lists.data!.defaultListId) ?? null;
  const toggle = async (list: WatchmaskList, add: boolean) => {
    setBusy(list.id);
    setMsg(null);
    try {
      await api(`/api/watchmask/titles/${m.kind}/${m.tmdbId}/lists/${list.id}`, { method: add ? 'PUT' : 'DELETE', body: { title: m.title } });
      setMsg({ kind: 'success', text: add ? `Added to ${list.name} on Watchmask.` : `Removed from ${list.name} on Watchmask.` });
      await Promise.all([qc.invalidateQueries({ queryKey: memberKey }), qc.invalidateQueries({ queryKey: ['watchmask-lists'] })]);
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {def &&
        (inList.has(def.id) ? (
          <button className="btn-secondary" onClick={() => setPicking(true)} title="Already on this Watchmask list">
            ✓ On {def.name}
          </button>
        ) : (
          <button className="btn-secondary" disabled={busy !== null || member.isLoading} onClick={() => toggle(def, true)}>
            {busy === def.id ? 'Adding…' : `Add to ${def.name}`}
          </button>
        ))}
      <button className="btn-secondary" onClick={() => setPicking(true)}>
        Watchmask lists{inList.size ? ` (${inList.size})` : ''}
      </button>
      {msg && !picking && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {picking && (
        <Modal title={`${m.title} on Watchmask`} onClose={() => setPicking(false)}>
          {member.error && <Alert>{(member.error as Error).message}</Alert>}
          {!lists.data.lists.length && <p className="text-sm text-muted">The Watchmask token can't see any lists yet. Make one in Watchmask, or check the token's permissions.</p>}
          <ul className="space-y-2">
            {lists.data.lists.map((l) => (
              <li key={l.id}>
                <label className="flex items-center gap-3">
                  <input type="checkbox" className="h-4 w-4 accent-[var(--mm-accent)]" checked={inList.has(l.id)} disabled={busy !== null || member.isLoading} onChange={(e) => toggle(l, e.target.checked)} />
                  <span className="text-sm">
                    {l.name}
                    <span className="text-muted">
                      {' '}
                      · {l.itemsCount} titles{l.id === def?.id ? ' · default' : ''}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {msg && (
            <div className="mt-3">
              <Alert kind={msg.kind}>{msg.text}</Alert>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
