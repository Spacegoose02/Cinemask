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
  hasPassword: boolean;
  linked: { oidc: boolean; plex: boolean };
  locked: boolean;
  lastLoginAt: number | null;
}

const ROLE_HELP: Record<Role, string> = {
  user: 'Can browse and request movies and shows. Requests need approval.',
  manager: 'Can approve requests, download and manage media, posters and collections.',
  admin: 'Full control, including settings, API keys and users.',
};

export function UserSettings() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserRow[]>('/api/users') });
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
