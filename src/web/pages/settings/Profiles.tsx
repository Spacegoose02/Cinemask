import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Field, Toggle } from '../../components/ui';
import { api } from '../../lib/api';
import { CustomFormats, useFormats } from './CustomFormats';

const QUALITIES = [
  'SDTV', 'DVD', 'WEBRip-480p', 'WEBDL-480p', 'HDTV-720p', 'WEBRip-720p', 'WEBDL-720p', 'Bluray-720p', 'HDTV-1080p', 'WEBRip-1080p', 'WEBDL-1080p', 'Bluray-1080p',
  'Remux-1080p', 'HDTV-2160p', 'WEBRip-2160p', 'WEBDL-2160p', 'Bluray-2160p', 'Remux-2160p',
];
const LANGUAGES = [
  ['any', 'Any language'], ['en', 'English'], ['multi', 'Multi-audio'], ['fr', 'French'], ['de', 'German'], ['es', 'Spanish'], ['it', 'Italian'], ['nl', 'Dutch'],
  ['ja', 'Japanese'], ['ko', 'Korean'], ['hi', 'Hindi'], ['pt', 'Portuguese'], ['ru', 'Russian'], ['pl', 'Polish'], ['sv', 'Swedish'], ['zh', 'Chinese'],
];

interface Profile {
  id: number;
  name: string;
  qualities: string[];
  cutoff: string;
  upgradesAllowed: boolean;
  language: string;
  formatScores: Record<string, number>;
  minFormatScore: number;
  upgradeUntilFormatScore: number;
}

export function ProfileSettings() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['profiles'], queryFn: () => api<Profile[]>('/api/profiles') });
  const [edit, setEdit] = useState<Omit<Profile, 'id'> & { id?: number }>();
  const [error, setError] = useState('');
  const formats = useFormats();

  const save = async () => {
    if (!edit) return;
    setError('');
    try {
      await api(edit.id ? `/api/profiles/${edit.id}` : '/api/profiles', { method: edit.id ? 'PUT' : 'POST', body: { ...edit, id: undefined } });
      setEdit(undefined);
      await qc.invalidateQueries({ queryKey: ['profiles'] });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      {error && <Alert>{error}</Alert>}
      <section className="card p-0">
        <ul className="divide-y divide-border">
          {list.data?.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
              <div>
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-muted">
                  {p.qualities.length} qualities · stop upgrading at {p.cutoff} · {LANGUAGES.find((l) => l[0] === p.language)?.[1] ?? p.language}
                </div>
              </div>
              <div className="flex gap-2">
                <button className="btn-secondary" onClick={() => setEdit(p)}>
                  Edit
                </button>
                <button
                  className="btn-danger"
                  onClick={async () => {
                    if (!confirm(`Delete ${p.name}?`)) return;
                    try {
                      await api(`/api/profiles/${p.id}`, { method: 'DELETE' });
                      await qc.invalidateQueries({ queryKey: ['profiles'] });
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <button className="btn-secondary" onClick={() => setEdit({ name: '', qualities: ['WEBDL-1080p', 'Bluray-1080p'], cutoff: 'Bluray-1080p', upgradesAllowed: true, language: 'any', formatScores: {}, minFormatScore: 0, upgradeUntilFormatScore: 0 })}>
        New profile
      </button>
      {edit && (
        <section className="card space-y-4">
          <h2 className="font-semibold">{edit.id ? `Edit ${edit.name}` : 'New profile'}</h2>
          <Field label="Name">
            <input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          </Field>
          <div>
            <div className="label">Allowed qualities</div>
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
              {QUALITIES.map((q) => (
                <label key={q} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={edit.qualities.includes(q)}
                    onChange={(e) => setEdit({ ...edit, qualities: e.target.checked ? QUALITIES.filter((x) => x === q || edit.qualities.includes(x)) : edit.qualities.filter((x) => x !== q) })}
                  />
                  {q}
                </label>
              ))}
            </div>
          </div>
          <Field label="Stop upgrading once a file is at least" hint="Below this, a better release replaces the file automatically.">
            <select className="input" value={edit.cutoff} onChange={(e) => setEdit({ ...edit, cutoff: e.target.value })}>
              {edit.qualities.map((q) => (
                <option key={q}>{q}</option>
              ))}
            </select>
          </Field>
          <Toggle label="Allow upgrades" checked={edit.upgradesAllowed} onChange={(v) => setEdit({ ...edit, upgradesAllowed: v })} />
          <Field label="Language" hint="Releases tagged with another language are skipped. Untagged releases count as English.">
            <select className="input" value={edit.language} onChange={(e) => setEdit({ ...edit, language: e.target.value })}>
              {LANGUAGES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          {!!formats.data?.formats.length && (
            <div className="space-y-3">
              <div>
                <div className="label">Format scores</div>
                <p className="hint">Releases matching a format get its score; the total decides between releases of the same quality. A big negative score keeps a format out.</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {formats.data.formats.map((f) => (
                  <label key={f.id} className="flex items-center justify-between gap-2 text-sm">
                    <span>{f.name}</span>
                    <input
                      className="input w-28"
                      type="number"
                      value={edit.formatScores[String(f.id)] ?? 0}
                      onChange={(e) => setEdit({ ...edit, formatScores: { ...edit.formatScores, [String(f.id)]: Number(e.target.value) || 0 } })}
                    />
                  </label>
                ))}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Minimum format score" hint="Releases scoring less aren't grabbed automatically.">
                  <input className="input w-28" type="number" value={edit.minFormatScore} onChange={(e) => setEdit({ ...edit, minFormatScore: Number(e.target.value) || 0 })} />
                </Field>
                <Field label="Keep upgrading until the score reaches" hint="At the cutoff quality, a release with a higher score still replaces the file until this score. 0 turns it off.">
                  <input className="input w-28" type="number" min={0} value={edit.upgradeUntilFormatScore} onChange={(e) => setEdit({ ...edit, upgradeUntilFormatScore: Math.max(0, Number(e.target.value) || 0) })} />
                </Field>
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <button className="btn-primary" onClick={save} disabled={!edit.name || !edit.qualities.length}>
              Save profile
            </button>
            <button className="btn-secondary" onClick={() => setEdit(undefined)}>
              Cancel
            </button>
          </div>
        </section>
      )}
      <CustomFormats profiles={list.data ?? []} />
    </div>
  );
}
