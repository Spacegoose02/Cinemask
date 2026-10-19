import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Field, SecretInput, Toggle } from '../../components/ui';
import { api } from '../../lib/api';

const TYPES = {
  qbittorrent: { label: 'qBittorrent', port: 8080, user: true, pass: 'Password' },
  transmission: { label: 'Transmission', port: 9091, user: true, pass: 'Password' },
  deluge: { label: 'Deluge', port: 8112, user: false, pass: 'Web UI password' },
  rtorrent: { label: 'rTorrent / ruTorrent', port: 80, user: true, pass: 'Password', hint: 'XML-RPC URL, e.g. http://host/RPC2' },
  flood: { label: 'Flood', port: 3000, user: true, pass: 'Password' },
  utorrent: { label: 'uTorrent', port: 8080, user: true, pass: 'Password' },
  sabnzbd: { label: 'SABnzbd', port: 8080, user: false, pass: 'API key' },
  nzbget: { label: 'NZBGet', port: 6789, user: true, pass: 'Password' },
} as const;
type ClientType = keyof typeof TYPES;

interface ClientRow {
  id: number;
  name: string;
  type: ClientType;
  url: string;
  username: string | null;
  hasPassword: boolean;
  category: string;
  enabled: boolean;
  priority: number;
  protocol: string;
}

const EMPTY = { name: '', type: 'qbittorrent' as ClientType, url: '', username: '', password: undefined as string | null | undefined, category: 'media-manager', enabled: true, priority: 1 };

export function DownloadClientSettings() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['clients'], queryFn: () => api<ClientRow[]>('/api/download-clients') });
  const [form, setForm] = useState<typeof EMPTY & { id?: number }>(EMPTY);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const t = TYPES[form.type];

  const run = async (fn: () => Promise<unknown>, success?: string) => {
    setMsg(null);
    try {
      const r = (await fn()) as { ok?: boolean; message?: string } | undefined;
      if (r && typeof r === 'object' && 'ok' in r) setMsg({ kind: r.ok ? 'success' : 'error', text: r.message ?? '' });
      else if (success) setMsg({ kind: 'success', text: success });
      await qc.invalidateQueries({ queryKey: ['clients'] });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <section className="card space-y-3 p-0">
        <h2 className="px-5 pt-5 font-semibold">Download clients</h2>
        <ul className="divide-y divide-border">
          {list.data?.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
              <div>
                <div className="font-medium">
                  {c.name} {!c.enabled && <span className="text-xs text-muted">(off)</span>}
                </div>
                <div className="text-xs text-muted">
                  {TYPES[c.type].label} · {c.url} · category "{c.category}"
                </div>
              </div>
              <div className="flex gap-2">
                <button className="btn-secondary" onClick={() => run(() => api(`/api/download-clients/${c.id}/test`, { method: 'POST' }))}>
                  Test
                </button>
                <button className="btn-secondary" onClick={() => setForm({ id: c.id, name: c.name, type: c.type, url: c.url, username: c.username ?? '', password: undefined, category: c.category, enabled: c.enabled, priority: c.priority })}>
                  Edit
                </button>
                <button className="btn-danger" onClick={() => confirm(`Delete ${c.name}?`) && run(() => api(`/api/download-clients/${c.id}`, { method: 'DELETE' }), 'Deleted.')}>
                  Delete
                </button>
              </div>
            </li>
          ))}
          {list.data?.length === 0 && <li className="px-5 py-3 text-sm text-muted">No download clients yet.</li>}
        </ul>
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">{form.id ? 'Edit client' : 'Add a client'}</h2>
        <Field label="Type">
          <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as ClientType })}>
            {Object.entries(TYPES).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Name">
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t.label} />
        </Field>
        <Field label="URL" hint={'hint' in t ? t.hint : `e.g. http://192.168.1.10:${t.port}`}>
          <input className="input" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
        </Field>
        {t.user && (
          <Field label="Username">
            <input className="input" autoComplete="off" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </Field>
        )}
        <Field label={t.pass}>
          <SecretInput isSet={Boolean(form.id)} value={form.password} onChange={(v) => setForm({ ...form, password: v })} />
        </Field>
        <Field label="Category / label" hint="Downloads are tagged with this so the app only touches its own.">
          <input className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
        </Field>
        <Field label="Priority" hint="When several clients handle the same protocol, 1 is used first.">
          <input className="input w-24" type="number" min={1} max={50} value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} />
        </Field>
        <Toggle label="Enabled" checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} />
        <div className="flex gap-2">
          <button
            className="btn-primary"
            disabled={!form.url}
            onClick={() =>
              run(async () => {
                const body = { ...form, id: undefined, name: form.name || t.label, username: form.username || null };
                await api(form.id ? `/api/download-clients/${form.id}` : '/api/download-clients', { method: form.id ? 'PUT' : 'POST', body });
                setForm(EMPTY);
              }, 'Client saved. Press Test to check the connection.')
            }
          >
            {form.id ? 'Save' : 'Add client'}
          </button>
          {form.id && (
            <button className="btn-secondary" onClick={() => setForm(EMPTY)}>
              Cancel
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
