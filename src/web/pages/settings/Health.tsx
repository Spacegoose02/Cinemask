import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Alert } from '../../components/ui';
import { api, formatDate } from '../../lib/api';

interface Check {
  id: string;
  group: string;
  name: string;
  level: 'ok' | 'warning' | 'error';
  message: string;
  fix?: string;
}

interface Report {
  checkedAt: number;
  level: 'ok' | 'warning' | 'error';
  checks: Check[];
  failedDownloads: { id: number; title: string; error: string | null; at: number }[];
}

const ICON = { ok: '✓', warning: '!', error: '✕' };
const COLOR = { ok: 'bg-success text-bg', warning: 'bg-warning text-bg', error: 'bg-danger text-bg' };
const ORDER = ['Connections', 'Storage', 'Downloads', 'Backups'];

export function HealthSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['health'], queryFn: () => api<Report>('/api/system/health') });
  const rerun = async () => {
    const r = await api<Report>('/api/system/health?refresh=true');
    qc.setQueryData(['health'], r);
    await qc.invalidateQueries({ queryKey: ['health-summary'] });
  };
  const r = q.data;
  const groups = ORDER.map((g) => ({ g, checks: r?.checks.filter((c) => c.group === g) ?? [] })).filter((x) => x.checks.length);
  const problems = r?.checks.filter((c) => c.level !== 'ok').length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          {q.isFetching ? 'Checking every connection…' : r ? `${problems ? `${problems} problem${problems === 1 ? '' : 's'}` : 'Everything looks good'} · checked ${formatDate(r.checkedAt)}` : ''}
        </p>
        <button className="btn-secondary" onClick={rerun} disabled={q.isFetching}>
          Run checks again
        </button>
      </div>
      {q.error && <Alert>{(q.error as Error).message}</Alert>}
      {groups.map(({ g, checks }) => (
        <section key={g} className="card p-0">
          <h2 className="border-b border-border px-4 py-2 font-semibold">{g}</h2>
          <ul>
            {checks.map((c) => (
              <li key={c.id} className="flex items-start gap-3 border-b border-border px-4 py-3 last:border-0">
                <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${COLOR[c.level]}`} aria-label={c.level}>
                  {ICON[c.level]}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{c.name}</div>
                  <div className="break-words text-sm text-muted">{c.message}</div>
                </div>
                {c.fix && c.level !== 'ok' && (
                  <Link className="btn-secondary shrink-0 text-xs" to={`/settings/${c.fix}`}>
                    Fix
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {!!r?.failedDownloads.length && (
        <section className="card p-0">
          <h2 className="border-b border-border px-4 py-2 font-semibold">Failed downloads (last 7 days)</h2>
          <ul>
            {r.failedDownloads.map((f) => (
              <li key={f.id} className="border-b border-border px-4 py-2 text-sm last:border-0">
                <div className="break-all">{f.title}</div>
                <div className="text-xs text-muted">
                  {formatDate(f.at)} · {f.error}
                </div>
              </li>
            ))}
          </ul>
          <div className="px-4 py-2 text-sm">
            <Link to="/downloads" className="text-accent">
              Open downloads
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
