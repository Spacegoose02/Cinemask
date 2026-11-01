import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, LoadError } from '../components/ui';
import { api, formatDate, hasRole } from '../lib/api';
import { useAuth } from '../lib/auth';
import { mediaPath, poster, type MediaKind } from '../lib/media';

export interface IssueRow {
  id: number;
  kind: MediaKind;
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  season: number | null;
  episode: number | null;
  type: string;
  label: string;
  message: string | null;
  status: 'open' | 'fixing' | 'resolved';
  reportedBy: number | null;
  reportedByName: string | null;
  resolvedByName: string | null;
  resolution: string | null;
  createdAt: number;
  updatedAt: number;
  fixes: ('replace' | 'subtitles')[];
}

const FIX_LABEL = { replace: 'Find a different copy', subtitles: 'Fetch subtitles' };
const pad = (n: number) => String(n).padStart(2, '0');
export const scopeOf = (i: { season: number | null; episode: number | null }) => (i.season === null ? '' : i.episode === null ? ` · season ${i.season}` : ` · S${pad(i.season)}E${pad(i.episode)}`);

/** Problem reports: managers see everyone's and can fix them; others see their own. */
export function IssuesPage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const isManager = hasRole(me, 'manager');
  const [status, setStatus] = useState<'open' | 'resolved' | 'all'>('open');
  const list = useQuery({ queryKey: ['issues', status], queryFn: () => api<IssueRow[]>(`/api/issues?status=${status}`) });
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const act = async (id: number, fn: () => Promise<unknown>) => {
    setMsg(null);
    setBusy(id);
    try {
      const r = (await fn()) as { ok?: boolean; message?: string } | undefined;
      if (r?.message) setMsg({ kind: r.ok === false ? 'error' : 'success', text: r.message });
      await qc.invalidateQueries({ queryKey: ['issues'] });
      await qc.invalidateQueries({ queryKey: ['issue-count'] });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{isManager ? 'Problems' : 'My problem reports'}</h1>
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Status">
          <option value="open">Open</option>
          <option value="resolved">Fixed</option>
          <option value="all">All</option>
        </select>
      </div>
      <p className="text-sm text-muted">Something wrong with a movie or episode? Use “Report a problem” on its page.</p>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <LoadError queries={[list]} />
      {list.data?.length === 0 && <div className="card text-sm text-muted">Nothing here.</div>}
      <ul className="space-y-3">
        {list.data?.map((i) => (
          <li key={i.id} className="card flex flex-wrap items-start gap-4 p-3">
            <Link to={mediaPath(i.kind, i.tmdbId)} className="w-14 shrink-0 overflow-hidden rounded border border-border bg-surface-2">
              {i.posterPath ? <img src={poster(i.posterPath, 'w185')!} alt="" className="w-full" /> : <div className="aspect-[2/3]" />}
            </Link>
            <div className="min-w-0 flex-1 space-y-1">
              <Link to={mediaPath(i.kind, i.tmdbId)} className="font-medium hover:text-accent">
                {i.title} {i.year && <span className="text-muted">({i.year})</span>}
              </Link>
              <div className="text-xs text-muted">
                {i.label}
                {scopeOf(i)} · reported by {i.reportedByName} · {formatDate(i.createdAt)}
              </div>
              {i.message && <div className="text-sm italic text-muted">“{i.message}”</div>}
              <div className={`text-sm ${i.status === 'resolved' ? 'text-success' : i.status === 'fixing' ? 'text-accent' : 'text-text'}`}>
                {i.status === 'resolved' ? 'Fixed' : i.status === 'fixing' ? 'Being fixed' : 'Open'}
                {i.resolution && <span className="text-muted">: {i.resolution}</span>}
                {i.resolvedByName && i.status !== 'open' && <span className="text-muted"> ({i.resolvedByName})</span>}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {isManager &&
                i.status !== 'resolved' &&
                i.fixes.map((f) => (
                  <button key={f} className="btn-primary" disabled={busy === i.id} onClick={() => act(i.id, () => api(`/api/issues/${i.id}/fix`, { body: { action: f } }))}>
                    {FIX_LABEL[f]}
                  </button>
                ))}
              {isManager && i.status !== 'resolved' && (
                <button
                  className="btn-secondary"
                  onClick={() => {
                    const note = prompt('What was done? (optional, the reporter sees this)');
                    if (note === null) return;
                    void act(i.id, () => api(`/api/issues/${i.id}/resolve`, { body: { note: note.trim() || undefined } }));
                  }}
                >
                  Mark fixed
                </button>
              )}
              {i.status === 'resolved' && (isManager || i.reportedBy === me?.id) && (
                <button className="btn-secondary" onClick={() => act(i.id, () => api(`/api/issues/${i.id}/reopen`, { body: {} }))}>
                  Still not right
                </button>
              )}
              {(isManager || (i.reportedBy === me?.id && i.status === 'open')) && (
                <button className="btn-secondary" onClick={() => confirm('Remove this report?') && act(i.id, () => api(`/api/issues/${i.id}`, { method: 'DELETE' }))}>
                  {isManager ? 'Remove' : 'Withdraw'}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
