import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Field } from '../../components/ui';
import { api } from '../../lib/api';

type Rule =
  | { kind: 'title' | 'group' | 'indexer'; pattern: string; negate: boolean; required: boolean }
  | { kind: 'language'; language: string; negate: boolean; required: boolean }
  | { kind: 'protocol'; protocol: 'usenet' | 'torrent'; negate: boolean; required: boolean }
  | { kind: 'size'; minGb: number; maxGb: number; negate: boolean; required: boolean };

interface Format {
  id: number;
  name: string;
  rules: Rule[];
}

interface Preset {
  name: string;
  score: number;
  about: string;
  added: boolean;
}

export function useFormats() {
  return useQuery({ queryKey: ['custom-formats'], queryFn: () => api<{ formats: Format[]; presets: Preset[] }>('/api/custom-formats') });
}

const KIND_LABEL: Record<Rule['kind'], string> = {
  title: 'Release name matches',
  group: 'Release group matches',
  indexer: 'Indexer matches',
  language: 'Language is',
  protocol: 'Protocol is',
  size: 'Size (GB) between',
};

function blank(kind: Rule['kind']): Rule {
  if (kind === 'language') return { kind, language: 'en', negate: false, required: false };
  if (kind === 'protocol') return { kind, protocol: 'usenet', negate: false, required: false };
  if (kind === 'size') return { kind, minGb: 0, maxGb: 0, negate: false, required: false };
  return { kind, pattern: '', negate: false, required: false };
}

/** One rule of a format being edited. */
function RuleRow({ rule, onChange, onRemove }: { rule: Rule; onChange: (r: Rule) => void; onRemove: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2 text-sm">
      <select className="input w-auto" value={rule.kind} onChange={(e) => onChange(blank(e.target.value as Rule['kind']))} aria-label="Rule type">
        {Object.entries(KIND_LABEL).map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </select>
      {(rule.kind === 'title' || rule.kind === 'group' || rule.kind === 'indexer') && (
        <input className="input min-w-48 flex-1 font-mono text-xs" placeholder="\bHDR10\b (a regular expression)" value={rule.pattern} onChange={(e) => onChange({ ...rule, pattern: e.target.value })} />
      )}
      {rule.kind === 'language' && <input className="input w-20" value={rule.language} onChange={(e) => onChange({ ...rule, language: e.target.value.toLowerCase() })} aria-label="Language code" />}
      {rule.kind === 'protocol' && (
        <select className="input w-auto" value={rule.protocol} onChange={(e) => onChange({ ...rule, protocol: e.target.value as 'usenet' | 'torrent' })}>
          <option value="usenet">Usenet</option>
          <option value="torrent">Torrent</option>
        </select>
      )}
      {rule.kind === 'size' && (
        <>
          <input className="input w-20" type="number" min={0} value={rule.minGb} onChange={(e) => onChange({ ...rule, minGb: Number(e.target.value) })} aria-label="From GB" />
          and
          <input className="input w-20" type="number" min={0} value={rule.maxGb} onChange={(e) => onChange({ ...rule, maxGb: Number(e.target.value) })} aria-label="To GB (0: no top)" />
        </>
      )}
      <label className="flex items-center gap-1">
        <input type="checkbox" checked={rule.negate} onChange={(e) => onChange({ ...rule, negate: e.target.checked })} /> Not
      </label>
      <label className="flex items-center gap-1" title="Must hold. Otherwise any one rule of each type will do.">
        <input type="checkbox" checked={rule.required} onChange={(e) => onChange({ ...rule, required: e.target.checked })} /> Required
      </label>
      <button className="btn-secondary px-2 py-1 text-xs" onClick={onRemove}>
        Remove
      </button>
    </div>
  );
}

/** Settings → Quality → Custom formats: the formats profiles score, and ready-made ones to add. */
export function CustomFormats({ profiles }: { profiles: { id: number; name: string }[] }) {
  const qc = useQueryClient();
  const q = useFormats();
  const [edit, setEdit] = useState<{ id?: number; name: string; rules: Rule[] } | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [scoreProfiles, setScoreProfiles] = useState<number[]>([]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['custom-formats'] });
      await qc.invalidateQueries({ queryKey: ['profiles'] });
      if (ok) setMsg({ kind: 'success', text: ok });
      return true;
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
      return false;
    }
  };
  const missing = q.data?.presets.filter((p) => !p.added) ?? [];

  return (
    <section className="card space-y-4">
      <h2 className="font-semibold">Custom formats</h2>
      <p className="hint">Formats pick out things a release has beyond its quality, such as HDR, Dolby Vision, Atmos, a streaming service or a release group. Each profile above gives each format a score.</p>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {missing.length > 0 && (
        <div className="space-y-2 rounded-md border border-border p-3">
          <div className="text-sm font-medium">Ready-made formats</div>
          <ul className="grid gap-1 text-xs text-muted sm:grid-cols-2">
            {missing.map((p) => (
              <li key={p.name}>
                <span className="text-text">{p.name}</span> ({p.score > 0 ? `+${p.score}` : p.score}): {p.about}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-muted">Also set their suggested scores in:</span>
            {profiles.map((p) => (
              <label key={p.id} className="flex items-center gap-1">
                <input type="checkbox" checked={scoreProfiles.includes(p.id)} onChange={(e) => setScoreProfiles(e.target.checked ? [...scoreProfiles, p.id] : scoreProfiles.filter((x) => x !== p.id))} />
                {p.name}
              </label>
            ))}
          </div>
          <button className="btn-primary" onClick={() => run(() => api('/api/custom-formats/presets', { body: { profileIds: scoreProfiles } }), 'Added the ready-made formats.')}>
            Add {missing.length} format{missing.length === 1 ? '' : 's'}
          </button>
        </div>
      )}
      <ul className="divide-y divide-border">
        {q.data?.formats.map((f) => (
          <li key={f.id} className="flex items-center justify-between gap-2 py-2 text-sm">
            <span>
              {f.name} <span className="text-xs text-muted">· {f.rules.length} rule{f.rules.length === 1 ? '' : 's'}</span>
            </span>
            <span className="flex gap-2">
              <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setEdit({ id: f.id, name: f.name, rules: f.rules })}>
                Edit
              </button>
              <button className="btn-danger px-2 py-1 text-xs" onClick={() => confirm(`Delete ${f.name}? Profiles lose its score.`) && run(() => api(`/api/custom-formats/${f.id}`, { method: 'DELETE' }))}>
                Delete
              </button>
            </span>
          </li>
        ))}
      </ul>
      {!edit && (
        <button className="btn-secondary" onClick={() => setEdit({ name: '', rules: [blank('title')] })}>
          New format
        </button>
      )}
      {edit && (
        <div className="space-y-3 rounded-md border border-border p-3">
          <Field label="Name">
            <input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          </Field>
          {edit.rules.map((r, i) => (
            <RuleRow key={i} rule={r} onChange={(nr) => setEdit({ ...edit, rules: edit.rules.map((x, j) => (j === i ? nr : x)) })} onRemove={() => setEdit({ ...edit, rules: edit.rules.filter((_, j) => j !== i) })} />
          ))}
          <div className="flex flex-wrap gap-2">
            <button className="btn-secondary" onClick={() => setEdit({ ...edit, rules: [...edit.rules, blank('title')] })}>
              Add a rule
            </button>
            <button
              className="btn-primary"
              disabled={!edit.name || !edit.rules.length}
              onClick={async () => {
                const ok = await run(() => api(edit.id ? `/api/custom-formats/${edit.id}` : '/api/custom-formats', { method: edit.id ? 'PUT' : 'POST', body: { name: edit.name, rules: edit.rules } }));
                if (ok) setEdit(null);
              }}
            >
              Save format
            </button>
            <button className="btn-secondary" onClick={() => setEdit(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
