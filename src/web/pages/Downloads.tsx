import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert } from '../components/ui';
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
}

export function DownloadsPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'queue' | 'history'>('queue');
  const [url, setUrl] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const list = useQuery({
    queryKey: ['downloads', tab],
    queryFn: () => api<DownloadRow[]>(`/api/downloads${tab === 'history' ? '?history=true' : ''}`),
    refetchInterval: tab === 'queue' ? 5000 : false,
  });

  const remove = async (d: DownloadRow, blocklist: boolean) => {
    if (!confirm(blocklist ? `Remove "${d.title}", blocklist it and look for another release?` : `Remove "${d.title}" from the queue and the download client?`)) return;
    await api(`/api/downloads/${d.id}?removeFromClient=true&blocklist=${blocklist}`, { method: 'DELETE' });
    await qc.invalidateQueries({ queryKey: ['downloads'] });
  };

  const direct = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      await api('/api/downloads/direct', { body: { url } });
      setUrl('');
      setMsg({ kind: 'success', text: 'Download started. It saves to the downloads folder under "direct".' });
      await qc.invalidateQueries({ queryKey: ['downloads'] });
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Downloads</h1>
      <div className="flex gap-1 border-b border-border">
        {(['queue', 'history'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`border-b-2 px-3 py-2 text-sm capitalize ${tab === t ? 'border-accent text-accent' : 'border-transparent text-muted'}`}>
            {t}
          </button>
        ))}
      </div>
      <ul className="space-y-2">
        {list.data?.map((d) => (
          <li key={d.id} className="card space-y-2 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="break-all text-sm font-medium">{d.title}</div>
                <div className="text-xs text-muted">
                  {[d.quality, d.size ? formatBytes(d.size) : null, d.protocol, d.indexer, formatDate(d.addedAt)].filter(Boolean).join(' · ')}
                </div>
                {d.error && <div className="text-xs text-danger">{d.error}</div>}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs capitalize text-muted">{d.status}</span>
                {tab === 'queue' && (
                  <>
                    <button className="btn-secondary text-xs" onClick={() => remove(d, false)}>
                      Remove
                    </button>
                    {d.protocol !== 'direct' && (
                      <button className="btn-danger text-xs" onClick={() => remove(d, true)}>
                        Blocklist and retry
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
            {tab === 'queue' && (
              <div className="h-1.5 overflow-hidden rounded bg-surface-2" role="progressbar" aria-valuenow={Math.round(d.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full bg-accent" style={{ width: `${Math.round(d.progress * 100)}%` }} />
              </div>
            )}
          </li>
        ))}
        {list.data?.length === 0 && <li className="card text-sm text-muted">{tab === 'queue' ? 'Nothing downloading.' : 'No history yet.'}</li>}
      </ul>

      <form onSubmit={direct} className="card max-w-2xl space-y-3">
        <h2 className="font-semibold">Download from a link</h2>
        <p className="text-sm text-muted">Paste a direct link to a file. Links to your home network are blocked unless an admin allows them.</p>
        {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
        <div className="flex gap-2">
          <input className="input" type="url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} required aria-label="Link" />
          <button className="btn-primary">Download</button>
        </div>
      </form>
    </div>
  );
}
