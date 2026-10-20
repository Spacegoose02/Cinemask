import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDate } from '../lib/api';
import { Alert, Field } from './ui';

interface ApiKeyRow {
  id: number;
  name: string;
  prefix: string;
  access: 'read' | 'full';
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  expired: boolean;
}

/** Personal API keys for scripts and Home Assistant. A new key is shown once and never again. */
export function ApiKeys() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => api<ApiKeyRow[]>('/api/auth/api-keys') });
  const [name, setName] = useState('');
  const [access, setAccess] = useState<'read' | 'full'>('read');
  const [expires, setExpires] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState('');

  const create = async () => {
    setError('');
    try {
      const r = await api<ApiKeyRow & { key: string }>('/api/auth/api-keys', { body: { name, access, expiresDays: expires ? Number(expires) : null } });
      setCreated(r.key);
      setName('');
      await qc.invalidateQueries({ queryKey: ['api-keys'] });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async (k: ApiKeyRow) => {
    if (!confirm(`Delete "${k.name}"? Anything using it stops working.`)) return;
    await api(`/api/auth/api-keys/${k.id}`, { method: 'DELETE' });
    await qc.invalidateQueries({ queryKey: ['api-keys'] });
  };

  return (
    <section className="card space-y-4">
      <div>
        <h2 className="font-semibold">API keys</h2>
        <p className="text-sm text-muted">
          For scripts and Home Assistant. A key acts as you, with your role. Read-only keys can look but not change anything. See the{' '}
          <Link to="/developer" className="text-accent">
            API reference
          </Link>
          .
        </p>
      </div>
      {error && <Alert>{error}</Alert>}
      {created && (
        <Alert kind="success">
          <div className="space-y-2">
            <div>Copy this key now. It won't be shown again.</div>
            <code className="block break-all rounded bg-surface-2 p-2 text-xs text-text">{created}</code>
            <div className="flex gap-2">
              <button className="btn-secondary px-2 py-1 text-xs" onClick={() => void navigator.clipboard?.writeText(created)}>
                Copy
              </button>
              <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setCreated(null)}>
                Done
              </button>
            </div>
          </div>
        </Alert>
      )}
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Home Assistant" maxLength={100} />
        </Field>
        <Field label="Access">
          <select className="input" value={access} onChange={(e) => setAccess(e.target.value as 'read' | 'full')}>
            <option value="read">Read-only</option>
            <option value="full">Read and write</option>
          </select>
        </Field>
        <Field label="Expires">
          <select className="input" value={expires} onChange={(e) => setExpires(e.target.value)}>
            <option value="">Never</option>
            <option value="30">In 30 days</option>
            <option value="90">In 90 days</option>
            <option value="365">In a year</option>
          </select>
        </Field>
        <button className="btn-primary mb-[1px]" disabled={!name.trim()} onClick={create}>
          Create key
        </button>
      </div>
      {keys.data?.length ? (
        <ul className="divide-y divide-border text-sm">
          {keys.data.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {k.name} <span className="text-xs text-muted">({k.access === 'read' ? 'read-only' : 'read and write'})</span>
                </div>
                <div className="text-xs text-muted">
                  <code>{k.prefix}…</code> · created {formatDate(k.createdAt)} · {k.lastUsedAt ? `last used ${formatDate(k.lastUsedAt)}` : 'never used'}
                  {k.expiresAt ? ` · ${k.expired ? 'expired' : 'expires'} ${formatDate(k.expiresAt)}` : ''}
                </div>
              </div>
              <button className="btn-danger px-2 py-1 text-xs" onClick={() => remove(k)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No keys yet.</p>
      )}
    </section>
  );
}
