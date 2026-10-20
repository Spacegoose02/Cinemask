import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Field, SecretInput, Toggle } from '../../components/ui';
import { api } from '../../lib/api';
import { useSettingsSection } from '../../lib/settings';
import { SaveBar } from './SaveBar';

interface IndexerRow {
  id: number;
  name: string;
  type: 'newznab' | 'torznab';
  url: string;
  hasApiKey: boolean;
  categories: number[];
  enabled: boolean;
  priority: number;
  source: 'manual' | 'prowlarr';
}

const EMPTY = { name: '', type: 'newznab' as 'newznab' | 'torznab', url: '', apiKey: undefined as string | null | undefined, enabled: true, priority: 25 };

export function IndexerSettings() {
  const qc = useQueryClient();
  const prowlarr = useSettingsSection('prowlarr');
  const list = useQuery({ queryKey: ['indexers'], queryFn: () => api<IndexerRow[]>('/api/indexers') });
  const [form, setForm] = useState<typeof EMPTY & { id?: number }>(EMPTY);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const run = async (fn: () => Promise<{ ok?: boolean; message?: string } | unknown>, success?: string) => {
    setMsg(null);
    try {
      const r = (await fn()) as { ok?: boolean; message?: string } | undefined;
      if (r && typeof r === 'object' && 'ok' in r) setMsg({ kind: r.ok ? 'success' : 'error', text: r.message ?? '' });
      else if (success) setMsg({ kind: 'success', text: success });
      await qc.invalidateQueries({ queryKey: ['indexers'] });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
  };

  const save = () =>
    run(async () => {
      const body = { name: form.name, type: form.type, url: form.url, apiKey: form.apiKey, enabled: form.enabled, priority: form.priority };
      await api(form.id ? `/api/indexers/${form.id}` : '/api/indexers', { method: form.id ? 'PUT' : 'POST', body });
      setForm(EMPTY);
    }, 'Indexer saved.');

  return (
    <div className="max-w-3xl space-y-6">
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {!prowlarr.loading && (
        <section className="card space-y-4">
          <h2 className="font-semibold">Prowlarr</h2>
          <p className="text-sm text-muted">
            The easiest way to add indexers. Every indexer in Prowlarr is added here and searched through Prowlarr. For indexers behind Cloudflare, add FlareSolverr in Prowlarr
            (Settings → Indexers → Indexer Proxies) and tag those indexers.
          </p>
          <Field label="Prowlarr URL" hint="e.g. http://192.168.1.10:9696">
            <input className="input" value={prowlarr.values.url} onChange={(e) => prowlarr.set('url', e.target.value)} />
          </Field>
          <Field label="API key" hint="Prowlarr → Settings → General.">
            <SecretInput isSet={prowlarr.secretsSet['apiKey']!} value={prowlarr.secrets['apiKey']} onChange={(v) => prowlarr.setSecret('apiKey', v)} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <SaveBar onSave={prowlarr.save} saving={prowlarr.saving} message={prowlarr.message} />
            <button
              className="btn-secondary"
              onClick={() =>
                run(async () => {
                  await prowlarr.save();
                  const r = await api<{ total: number; added: number }>('/api/indexers/prowlarr-sync', { method: 'POST' });
                  setMsg({ kind: 'success', text: `Synced ${r.total} indexers from Prowlarr (${r.added} new).` });
                })
              }
            >
              Sync indexers from Prowlarr
            </button>
          </div>
        </section>
      )}

      <section className="card space-y-3 p-0">
        <h2 className="px-5 pt-5 font-semibold">Indexers</h2>
        <ul className="divide-y divide-border">
          {list.data?.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
              <div>
                <div className="font-medium">
                  {i.name} {!i.enabled && <span className="text-xs text-muted">(off)</span>}
                </div>
                <div className="text-xs text-muted">
                  {i.type === 'torznab' ? 'Torrent' : 'Usenet'} · priority {i.priority} · {i.source === 'prowlarr' ? 'from Prowlarr' : i.url}
                </div>
              </div>
              <div className="flex gap-2">
                <button className="btn-secondary" onClick={() => run(() => api(`/api/indexers/${i.id}/test`, { method: 'POST' }))}>
                  Test
                </button>
                {i.source === 'manual' && (
                  <button className="btn-secondary" onClick={() => setForm({ id: i.id, name: i.name, type: i.type, url: i.url, apiKey: undefined, enabled: i.enabled, priority: i.priority })}>
                    Edit
                  </button>
                )}
                <button className="btn-danger" onClick={() => confirm(`Delete ${i.name}?`) && run(() => api(`/api/indexers/${i.id}`, { method: 'DELETE' }), 'Deleted.')}>
                  Delete
                </button>
              </div>
            </li>
          ))}
          {list.data?.length === 0 && <li className="px-5 py-3 text-sm text-muted">No indexers yet.</li>}
        </ul>
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">{form.id ? 'Edit indexer' : 'Add an indexer directly'}</h2>
        <p className="text-sm text-muted">For Usenet indexers like altHUB or DrunkenSlug, or any Newznab/Torznab feed you don't keep in Prowlarr.</p>
        <Field label="Name">
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Type">
          <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as 'newznab' })}>
            <option value="newznab">Newznab (Usenet)</option>
            <option value="torznab">Torznab (torrents)</option>
          </select>
        </Field>
        <Field label="URL" hint="e.g. https://api.althub.co.za or https://drunkenslug.com">
          <input className="input" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
        </Field>
        <Field label="API key">
          <SecretInput isSet={Boolean(form.id)} value={form.apiKey} onChange={(v) => setForm({ ...form, apiKey: v })} />
        </Field>
        <Field label="Priority" hint="1 is searched first.">
          <input className="input w-24" type="number" min={1} max={50} value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} />
        </Field>
        <Toggle label="Enabled" checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} />
        <div className="flex gap-2">
          <button className="btn-primary" onClick={save} disabled={!form.name || !form.url}>
            {form.id ? 'Save' : 'Add indexer'}
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
