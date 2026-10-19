import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from './api';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function setIn(obj: Json, path: string, value: unknown): Json {
  const [head, ...rest] = path.split('.');
  return { ...obj, [head!]: rest.length ? setIn(obj[head!] ?? {}, rest.join('.'), value) : value };
}

/** Loads one settings section into an editable draft. Secret fields stay blank unless changed. */
export function useSettingsSection(section: string) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings', section], queryFn: () => api<{ values: Json; secretsSet: Record<string, boolean> }>(`/api/settings/${section}`) });
  // Unsaved edits; null means "showing what the server has".
  const [edits, setEdits] = useState<Json | null>(null);
  const draft = edits ?? q.data?.values ?? null;
  const [secrets, setSecrets] = useState<Record<string, string | null | undefined>>({});
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setMessage(null);
    let body = draft;
    for (const p of Object.keys(q.data?.secretsSet ?? {})) body = setIn(body, p, secrets[p]);
    try {
      const res = await api<{ values: Json; secretsSet: Record<string, boolean> }>(`/api/settings/${section}`, { method: 'PUT', body });
      qc.setQueryData(['settings', section], res);
      setSecrets({});
      setEdits(null);
      setMessage({ kind: 'success', text: 'Saved.' });
    } catch (e) {
      setMessage({ kind: 'error', text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return {
    loading: !draft,
    values: draft ?? {},
    set: (path: string, value: unknown) => setEdits((d) => setIn(d ?? q.data?.values ?? {}, path, value)),
    secretsSet: q.data?.secretsSet ?? {},
    secrets,
    setSecret: (path: string, v: string | null | undefined) => setSecrets((s) => ({ ...s, [path]: v })),
    save,
    saving,
    message,
  };
}
