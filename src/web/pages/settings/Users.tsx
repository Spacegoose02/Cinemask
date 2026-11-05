import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Field } from '../../components/ui';
import { api, formatDate, type Role } from '../../lib/api';
import { useAuth } from '../../lib/auth';

interface UserRow {
  id: number;
  username: string;
  displayName: string | null;
  email: string | null;
  role: Role;
  isOwner: boolean;
  disabled: boolean;
  autoApproveMovies: boolean;
  autoApproveShows: boolean;
  movieRequestLimit: number | null;
  seasonRequestLimit: number | null;
  canRequest4k: boolean;
  maxAge: number | null;
  jellyfinUserId: string | null;
  hasPassword: boolean;
  linked: { oidc: boolean; plex: boolean };
  locked: boolean;
  lastLoginAt: number | null;
}

/** A per-user request limit: empty means the default from Settings → Requests, 0 means none. Saved when the box loses focus. */
/** Kids profile choices: the oldest rating allowed, with the US ratings that fit. */
const AGE_LIMITS: [number | null, string][] = [
  [null, 'No limit'],
  [7, 'Up to 7 (G, TV-Y7, U)'],
  [9, 'Up to 9 (PG, TV-PG)'],
  [12, 'Up to 12 (12A)'],
  [14, 'Up to 14 (PG-13, TV-14)'],
  [16, 'Up to 16 (15, 16)'],
];

function LimitInput({ label, value, onSave }: { label: string; value: number | null; onSave: (v: number | null) => void }) {
  const [text, setText] = useState(value === null ? '' : String(value));
  return (
    <label className="flex items-center gap-1.5">
      <input
        className="input w-16 px-2 py-0.5 text-xs"
        inputMode="numeric"
        placeholder="default"
        aria-label={`${label} request limit`}
        value={text}
        onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={() => {
          const next = text === '' ? null : Math.min(1000, Number(text));
          if (next !== value) onSave(next);
        }}
      />
      {label}
    </label>
  );
}

const ROLE_HELP: Record<Role, string> = {
  user: 'Can browse and request movies and shows. Requests need approval, unless you let their movies or shows download without it.',
  manager: 'Can approve requests, download and manage media, posters and collections.',
  admin: 'Full control, including settings, API keys and users.',
};

export function UserSettings() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserRow[]>('/api/users') });
  const jfUsers = useQuery({ queryKey: ['jellyfin-users'], queryFn: () => api<{ users: { id: string; name: string }[] }>('/api/watchlist/jellyfin-users') });
  const [error, setError] = useState('');
  const [form, setForm] = useState({ username: '', password: '', role: 'user' as Role });
  const roles: Role[] = me?.isOwner ? ['user', 'manager', 'admin'] : ['user', 'manager'];

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['users'] });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const create = useMutation({
    mutationFn: () => run(() => api('/api/users', { body: form }).then(() => setForm({ username: '', password: '', role: 'user' }))),
  });
  const patch = (id: number, body: object) => run(() => api(`/api/users/${id}`, { method: 'PATCH', body }));
  const remove = (u: UserRow) => {
    if (confirm(`Delete ${u.username}? This cannot be undone.`)) void run(() => api(`/api/users/${u.id}`, { method: 'DELETE' }));
  };
  const resetPassword = (u: UserRow) => {
    const password = prompt(`New password for ${u.username} (at least 12 characters):`);
    if (password) void patch(u.id, { password });
  };

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="text-left text-muted">
            <tr className="border-b border-border">
              <th className="p-3">User</th>
              <th className="p-3">Role</th>
              <th className="p-3">Sign-in</th>
              <th className="p-3">Last seen</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {users.data?.map((u) => {
              const editable = !u.isOwner && (me?.isOwner || u.role !== 'admin');
              return (
                <tr key={u.id} className="border-b border-border last:border-0">
                  <td className="p-3">
                    <div className="font-medium">{u.displayName || u.username}</div>
                    <div className="text-xs text-muted">
                      {u.username}
                      {u.isOwner && ' · owner'}
                      {u.disabled && ' · disabled'}
                      {u.locked && ' · locked'}
                    </div>
                  </td>
                  <td className="p-3">
                    {editable ? (
                      <select className="input w-auto" value={u.role} onChange={(e) => patch(u.id, { role: e.target.value })}>
                        {roles.map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                      </select>
                    ) : (
                      u.role
                    )}
                    {editable && u.role === 'user' && (
                      <div className="mt-2 space-y-1 text-xs" title="Their requests download right away instead of waiting for a manager.">
                        <div className="text-muted">Downloads without approval</div>
                        <label className="flex items-center gap-1.5">
                          <input type="checkbox" checked={u.autoApproveMovies} onChange={(e) => patch(u.id, { autoApproveMovies: e.target.checked })} /> Movies
                        </label>
                        <label className="flex items-center gap-1.5">
                          <input type="checkbox" checked={u.autoApproveShows} onChange={(e) => patch(u.id, { autoApproveShows: e.target.checked })} /> Shows
                        </label>
                        <label className="flex items-center gap-1.5" title="They can tick 4K when requesting. Set the 4K profile and folder in Settings → Requests.">
                          <input type="checkbox" checked={u.canRequest4k} onChange={(e) => patch(u.id, { canRequest4k: e.target.checked })} /> Can request 4K
                        </label>
                        <div className="pt-1 text-muted" title="Empty uses the default from Settings → Requests. 0 means no limit.">
                          Request limit
                        </div>
                        <LimitInput label="Movies" value={u.movieRequestLimit} onSave={(v) => patch(u.id, { movieRequestLimit: v })} />
                        <LimitInput label="Seasons" value={u.seasonRequestLimit} onSave={(v) => patch(u.id, { seasonRequestLimit: v })} />
                        <label className="block pt-1" title="Kids profile: they only see and request titles rated for this age or younger. Unrated titles are hidden too.">
                          <span className="text-muted">Kids profile</span>
                          <select className="input mt-0.5 w-auto py-0.5 text-xs" value={u.maxAge ?? ''} onChange={(e) => patch(u.id, { maxAge: e.target.value === '' ? null : Number(e.target.value) })}>
                            {AGE_LIMITS.map(([v, label]) => (
                              <option key={label} value={v ?? ''}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    )}
                    {editable && (jfUsers.data?.users.length ?? 0) > 0 && (
                      <label className="mt-2 block text-xs" title="Their Jellyfin favourites count as their watchlist (Account → Watchlist).">
                        <span className="text-muted">Jellyfin account</span>
                        <select className="input mt-0.5 w-auto py-0.5 text-xs" value={u.jellyfinUserId ?? ''} onChange={(e) => patch(u.id, { jellyfinUserId: e.target.value || null })}>
                          <option value="">None</option>
                          {jfUsers.data!.users.map((j) => (
                            <option key={j.id} value={j.id}>
                              {j.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </td>
                  <td className="p-3 text-xs text-muted">{[u.hasPassword && 'password', u.linked.oidc && 'SSO', u.linked.plex && 'Plex'].filter(Boolean).join(', ') || 'none'}</td>
                  <td className="p-3 text-xs text-muted">{formatDate(u.lastLoginAt)}</td>
                  <td className="p-3">
                    {editable && (
                      <div className="flex flex-wrap justify-end gap-2">
                        {u.locked && (
                          <button className="btn-secondary" onClick={() => patch(u.id, { unlock: true })}>
                            Unlock
                          </button>
                        )}
                        <button className="btn-secondary" onClick={() => resetPassword(u)}>
                          Reset password
                        </button>
                        <button className="btn-secondary" onClick={() => patch(u.id, { disabled: !u.disabled })}>
                          {u.disabled ? 'Enable' : 'Disable'}
                        </button>
                        <button className="btn-danger" onClick={() => remove(u)}>
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <form
        className="card max-w-xl space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <h2 className="font-semibold">Add a user</h2>
        <Field label="Username">
          <input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required />
        </Field>
        <Field label="Password" hint="At least 12 characters. They can change it after signing in.">
          <input className="input" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
        </Field>
        <Field label="Role" hint={ROLE_HELP[form.role]}>
          <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {roles.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </Field>
        <button className="btn-primary" disabled={create.isPending}>
          Add user
        </button>
      </form>
    </div>
  );
}
