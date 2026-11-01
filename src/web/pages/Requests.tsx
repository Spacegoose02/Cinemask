import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { RootPicker, useRootFolders } from '../components/MediaActions';
import { Alert, LoadError } from '../components/ui';
import { api, formatDate, hasRole } from '../lib/api';
import { useAuth } from '../lib/auth';
import { usePageState } from '../lib/history';
import { mediaPath, poster, type MediaKind } from '../lib/media';

interface RequestRow {
  id: number;
  kind: MediaKind;
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  seasons: string | null;
  status: 'pending' | 'approved' | 'declined' | 'available';
  requestedBy: number | null;
  requestedByName: string | null;
  decidedByName: string | null;
  reason: string | null;
  createdAt: number;
}

const STATUS_STYLE: Record<RequestRow['status'], string> = {
  pending: 'text-accent',
  approved: 'text-text',
  declined: 'text-danger',
  available: 'text-success',
};

export function RequestsPage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const isManager = hasRole(me, 'manager');
  const [status, setStatus] = usePageState('status', isManager ? 'pending' : 'all');
  const [error, setError] = useState('');
  const list = useQuery({ queryKey: ['requests', status], queryFn: () => api<RequestRow[]>(`/api/requests?status=${status}`) });
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api<{ id: number; name: string }[]>('/api/profiles'), enabled: isManager });
  const [profileFor, setProfileFor] = useState<Record<number, number>>({});
  // With several library folders for a kind, the manager picks one before approving.
  const roots = useRootFolders(isManager).data?.roots ?? [];
  const [rootFor, setRootFor] = useState<Record<number, string>>({});
  const rootsOf = (kind: MediaKind) => roots.filter((x) => x.kind === kind);
  const needsRoot = (r: RequestRow) => rootsOf(r.kind).length > 1 && !rootFor[r.id];

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['requests'] });
      await qc.invalidateQueries({ queryKey: ['request-count'] });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{isManager ? 'Requests' : 'My requests'}</h1>
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="all">All</option>
          <option value="pending">Waiting for approval</option>
          <option value="approved">Approved</option>
          <option value="available">Available</option>
          <option value="declined">Declined</option>
        </select>
      </div>
      {error && <Alert>{error}</Alert>}
      <LoadError queries={[list]} />
      {list.data?.length === 0 && <div className="card text-sm text-muted">No requests here. Find something with the search bar and press Request.</div>}
      <ul className="space-y-3">
        {list.data?.map((r) => (
          <li key={r.id} className="card flex flex-wrap items-center gap-4 p-3">
            <Link to={mediaPath(r.kind, r.tmdbId)} className="w-14 shrink-0 overflow-hidden rounded border border-border bg-surface-2">
              {r.posterPath ? <img src={poster(r.posterPath, 'w185')!} alt="" className="w-full" /> : <div className="aspect-[2/3]" />}
            </Link>
            <div className="min-w-0 flex-1">
              <Link to={mediaPath(r.kind, r.tmdbId)} className="font-medium hover:text-accent">
                {r.title} {r.year && <span className="text-muted">({r.year})</span>}
              </Link>
              <div className="text-xs text-muted">
                {r.kind === 'movie' ? 'Movie' : `Series${r.seasons ? ` · seasons ${(JSON.parse(r.seasons) as number[]).join(', ')}` : ''}`} · requested by {r.requestedByName} · {formatDate(r.createdAt)}
              </div>
              <div className={`text-sm capitalize ${STATUS_STYLE[r.status]}`}>
                {r.status}
                {r.decidedByName && r.status !== 'pending' && <span className="normal-case text-muted"> by {r.decidedByName}</span>}
                {r.reason && <span className="normal-case text-muted">: {r.reason}</span>}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {isManager && r.status === 'pending' && (
                <>
                  <select
                    className="input w-auto"
                    aria-label="Quality profile"
                    value={profileFor[r.id] ?? ''}
                    onChange={(e) => setProfileFor({ ...profileFor, [r.id]: Number(e.target.value) })}
                  >
                    <option value="">Default quality</option>
                    {profiles.data?.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <RootPicker roots={rootsOf(r.kind)} value={rootFor[r.id] ?? ''} onChange={(id) => setRootFor({ ...rootFor, [r.id]: id })} />
                  <button
                    className="btn-primary"
                    disabled={needsRoot(r)}
                    title={needsRoot(r) ? 'Choose a library first' : undefined}
                    onClick={() => act(() => api(`/api/requests/${r.id}/approve`, { body: { profileId: profileFor[r.id] || undefined, rootId: rootFor[r.id] || undefined } }))}
                  >
                    Approve
                  </button>
                  <button
                    className="btn-danger"
                    onClick={() => {
                      const reason = prompt('Reason (optional):');
                      // Cancel means don't decline; OK with nothing typed declines without a reason.
                      if (reason === null) return;
                      void act(() => api(`/api/requests/${r.id}/decline`, { body: { reason: reason.trim() || undefined } }));
                    }}
                  >
                    Decline
                  </button>
                </>
              )}
              {(isManager || (r.requestedBy === me?.id && r.status === 'pending')) && (
                <button className="btn-secondary" onClick={() => confirm('Remove this request?') && act(() => api(`/api/requests/${r.id}`, { method: 'DELETE' }))}>
                  {r.status === 'pending' && !isManager ? 'Cancel' : 'Remove'}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
