import { useQuery } from '@tanstack/react-query';
import { api, formatDate } from '../../lib/api';

interface Entry {
  id: number;
  username: string | null;
  action: string;
  target: string | null;
  details: unknown;
  ip: string | null;
  createdAt: number;
}

export function ActivitySettings() {
  const q = useQuery({ queryKey: ['audit'], queryFn: () => api<Entry[]>('/api/audit?limit=200') });
  return (
    <div className="card overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead className="text-left text-muted">
          <tr className="border-b border-border">
            <th className="p-3">When</th>
            <th className="p-3">Who</th>
            <th className="p-3">What</th>
            <th className="p-3">Target</th>
            <th className="p-3">IP</th>
          </tr>
        </thead>
        <tbody>
          {q.data?.map((e) => (
            <tr key={e.id} className="border-b border-border last:border-0">
              <td className="whitespace-nowrap p-3 text-xs text-muted">{formatDate(e.createdAt)}</td>
              <td className="p-3">{e.username ?? '—'}</td>
              <td className="p-3 font-mono text-xs">{e.action}</td>
              <td className="p-3">{e.target ?? ''}</td>
              <td className="p-3 text-xs text-muted">{e.ip}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
