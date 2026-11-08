import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Field, Toggle } from '../../components/ui';
import { api, formatDate } from '../../lib/api';
import { useAuth } from '../../lib/auth';

interface Invite {
  id: number;
  label: string | null;
  role: string;
  maxAge: number | null;
  usesLeft: number | null;
  used: number;
  expiresAt: number | null;
  plexShare: boolean;
  jellyfinAccount: boolean;
  path: string;
  url: string | null;
  active: boolean;
  joined: { username: string; usedAt: number; note: string | null }[];
}

/** Settings → Users: invite links people use to make their own accounts. */
export function Invites() {
  const qc = useQueryClient();
  const { me } = useAuth();
  const q = useQuery({ queryKey: ['invites'], queryFn: () => api<{ invites: Invite[]; plex: boolean; jellyfin: boolean }>('/api/invites') });
  const [form, setForm] = useState({ label: '', role: 'user', maxAge: 0, uses: 1, expiresInDays: 7, plexShare: false, plexSections: [] as string[], jellyfinAccount: false });
  const libs = useQuery({ queryKey: ['invites', 'plex-libraries'], queryFn: () => api<{ libraries: { key: string; title: string }[] }>('/api/invites/plex-libraries'), enabled: form.plexShare });
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<number | null>(null);

  const link = (i: Invite) => i.url ?? `${window.location.origin}${i.path}`;
  const create = async () => {
    setError('');
    try {
      const inv = await api<Invite>('/api/invites', {
        body: { label: form.label || undefined, role: form.role, maxAge: form.role === 'user' && form.maxAge ? form.maxAge : null, uses: form.uses || null, expiresInDays: form.expiresInDays || null, plexShare: form.plexShare, plexSections: form.plexShare && form.plexSections.length ? form.plexSections : null, jellyfinAccount: form.jellyfinAccount },
      });
      await navigator.clipboard?.writeText(link(inv)).then(() => setCopied(inv.id)).catch(() => undefined);
      await qc.invalidateQueries({ queryKey: ['invites'] });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async (i: Invite) => {
    if (!confirm('Delete this invite? The link stops working.')) return;
    await api(`/api/invites/${i.id}`, { method: 'DELETE' });
    await qc.invalidateQueries({ queryKey: ['invites'] });
  };

  return (
    <section className="card space-y-4">
      <div>
        <h2 className="font-semibold">Invite links</h2>
        <p className="text-sm text-muted">Send someone a link and they make their own account, with a password or with Plex. You choose their role and age limit, and whether they also get the Plex server shared or a Jellyfin account.</p>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name (for you)">
          <input className="input" placeholder="Grandma" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        </Field>
        <Field label="Role">
          <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="user">User</option>
            <option value="manager">Manager</option>
            {me?.isOwner && <option value="admin">Admin</option>}
          </select>
        </Field>
        {form.role === 'user' && (
          <Field label="Age limit">
            <select className="input" value={form.maxAge} onChange={(e) => setForm({ ...form, maxAge: Number(e.target.value) })}>
              <option value={0}>None</option>
              {[7, 9, 12, 14, 16].map((a) => (
                <option key={a} value={a}>
                  Up to {a}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Can be used">
          <select className="input" value={form.uses} onChange={(e) => setForm({ ...form, uses: Number(e.target.value) })}>
            <option value={1}>Once</option>
            <option value={5}>5 times</option>
            <option value={20}>20 times</option>
            <option value={0}>Any number of times</option>
          </select>
        </Field>
        <Field label="Expires">
          <select className="input" value={form.expiresInDays} onChange={(e) => setForm({ ...form, expiresInDays: Number(e.target.value) })}>
            <option value={1}>In a day</option>
            <option value={7}>In a week</option>
            <option value={30}>In a month</option>
            <option value={0}>Never</option>
          </select>
        </Field>
      </div>
      {q.data?.plex && <Toggle label="Share the Plex server with people who join with Plex" checked={form.plexShare} onChange={(v) => setForm({ ...form, plexShare: v })} />}
      {form.plexShare && (
        <div className="flex flex-wrap gap-3 text-sm">
          {libs.data?.libraries.map((l) => (
            <label key={l.key} className="flex items-center gap-1">
              <input type="checkbox" checked={!form.plexSections.length || form.plexSections.includes(l.key)} onChange={(e) => setForm({ ...form, plexSections: e.target.checked ? [...form.plexSections, l.key] : (form.plexSections.length ? form.plexSections : libs.data!.libraries.map((x) => x.key)).filter((k) => k !== l.key) })} />
              {l.title}
            </label>
          ))}
        </div>
      )}
      {q.data?.jellyfin && <Toggle label="Also make a Jellyfin account with the same username and password" checked={form.jellyfinAccount} onChange={(v) => setForm({ ...form, jellyfinAccount: v })} />}
      <button className="btn-primary" onClick={create}>
        Make an invite link
      </button>
      {!!q.data?.invites.length && (
        <ul className="divide-y divide-border text-sm">
          {q.data.invites.map((i) => (
            <li key={i.id} className="space-y-1 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={i.active ? '' : 'text-muted line-through'}>
                  {i.label ?? `Invite #${i.id}`} <span className="text-xs text-muted">· {i.role}{i.maxAge ? `, up to ${i.maxAge}` : ''} · {i.usesLeft === null ? `${i.used} joined` : `${i.usesLeft} use${i.usesLeft === 1 ? '' : 's'} left`}{i.expiresAt ? ` · ${i.active ? 'expires' : 'until'} ${formatDate(i.expiresAt)}` : ''}</span>
                </span>
                <div className="flex gap-2">
                  {i.active && (
                    <button className="btn-secondary px-2 py-1 text-xs" onClick={() => navigator.clipboard?.writeText(link(i)).then(() => setCopied(i.id))}>
                      {copied === i.id ? 'Copied' : 'Copy link'}
                    </button>
                  )}
                  <button className="btn-danger px-2 py-1 text-xs" onClick={() => remove(i)}>
                    Delete
                  </button>
                </div>
              </div>
              {i.joined.map((j) => (
                <div key={j.username} className="text-xs text-muted">
                  {j.username} joined {formatDate(j.usedAt)}
                  {j.note ? ` (${j.note})` : ''}
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
