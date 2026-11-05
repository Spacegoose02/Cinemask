import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Field, LoadError, Toggle } from '../components/ui';
import { api, formatBytes, formatDate, hasRole } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useSettingsSection } from '../lib/settings';
import { mediaPath, type MediaKind } from '../lib/media';
import { SaveBar } from './settings/SaveBar';

interface TitleUse {
  id: number;
  kind: MediaKind;
  tmdbId: number;
  title: string;
  year: number | null;
  size: number;
  keep: boolean;
  addedAt: number;
  viewCount: number | null;
  lastViewedAt: number | null;
  why?: string;
}

interface StorageData {
  disks: { id: string; name: string; kind: MediaKind; path: string; total: number | null; free: number | null }[];
  used: number;
  largest: TitleUse[];
  kept: TitleUse[];
  suggestions: (TitleUse & { why: string })[];
  recycleBin: { items: { id: number; title: string; originalPath: string; size: number; reason: string | null; deletedByName: string | null; deletedAt: number }[]; size: number };
}

/** Storage: how full the disks are, what takes the room, what could go, and the recycle bin. */
export function StoragePage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['storage'], queryFn: () => api<StorageData>('/api/storage') });
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const run = async (fn: () => Promise<string>) => {
    setMsg(null);
    try {
      setMsg({ kind: 'success', text: await fn() });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
    await qc.invalidateQueries({ queryKey: ['storage'] });
  };
  const d = q.data;
  const toggle = (id: number) => setPicked((p) => (p.has(id) ? new Set([...p].filter((x) => x !== id)) : new Set([...p, id])));
  const keep = (t: TitleUse, v: boolean) => run(async () => (await api(`/api/monitored/${t.id}`, { method: 'PATCH', body: { keep: v } }), v ? `${t.title} will be kept.` : `${t.title} is no longer kept.`));
  const freeUp = (ids: number[]) =>
    run(async () => {
      const r = await api<{ removed: number; freed: number; skipped: string[] }>('/api/storage/free-up', { body: { ids } });
      setPicked(new Set());
      return `Removed ${r.removed} title${r.removed === 1 ? '' : 's'} (${formatBytes(r.freed)}) into the recycle bin.${r.skipped.length ? ` Skipped: ${r.skipped.join('; ')}` : ''}`;
    });
  const disks = d ? [...new Map(d.disks.filter((x) => x.total).map((x) => [`${x.total}:${x.free}`, x])).values()] : [];

  const row = (t: TitleUse, selectable: boolean) => (
    <li key={t.id} className="flex items-center gap-3 py-2 text-sm">
      {selectable && <input type="checkbox" checked={picked.has(t.id)} onChange={() => toggle(t.id)} aria-label={`Pick ${t.title}`} />}
      <div className="min-w-0 flex-1">
        <Link to={mediaPath(t.kind, t.tmdbId)} className="block truncate font-medium hover:underline">
          {t.title} {t.year ? <span className="text-muted">({t.year})</span> : null}
        </Link>
        <div className="text-xs text-muted">{t.why ?? (t.lastViewedAt ? `Last watched ${formatDate(t.lastViewedAt)}` : t.viewCount === 0 ? 'Never watched' : `Added ${formatDate(t.addedAt)}`)}</div>
      </div>
      <span className="w-20 shrink-0 text-right tabular-nums">{formatBytes(t.size)}</span>
      <button className="btn-secondary shrink-0" onClick={() => keep(t, !t.keep)}>
        {t.keep ? 'Unkeep' : 'Keep'}
      </button>
    </li>
  );

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold">Storage</h1>
      <LoadError queries={[q]} />
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {d && (
        <>
          <section className="card space-y-3">
            <h2 className="font-semibold">Disks</h2>
            {disks.map((x) => {
              const used = x.total! - x.free!;
              const pct = Math.round((used / x.total!) * 100);
              return (
                <div key={x.path}>
                  <div className="flex justify-between text-sm">
                    <span>{d.disks.filter((y) => y.total === x.total && y.free === x.free).map((y) => y.name).join(', ')}</span>
                    <span className="text-muted">
                      {formatBytes(x.free!)} free of {formatBytes(x.total!)}
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded bg-surface-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                    <div className={`h-full ${pct > 90 ? 'bg-danger' : pct > 75 ? 'bg-warning' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
            {!disks.length && <p className="text-sm text-muted">Set your media folders in Settings → Media management.</p>}
            <p className="hint">Titles Cinemask manages use {formatBytes(d.used)}.</p>
          </section>

          <section className="card space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">Could go</h2>
              <button className="btn-danger" disabled={!picked.size} onClick={() => confirm(`Remove ${picked.size} title(s)? Their files go to the recycle bin and they stop being monitored.`) && void freeUp([...picked])}>
                Remove picked
              </button>
            </div>
            <p className="hint">Watched long ago, or never watched since they arrived (Plex or Jellyfin play counts). Titles marked Keep, still requested or with an open problem report never show here.</p>
            {d.suggestions.length ? <ul className="divide-y divide-border">{d.suggestions.map((t) => row(t, true))}</ul> : <p className="text-sm text-muted">Nothing to suggest.</p>}
          </section>

          <section className="card space-y-3">
            <h2 className="font-semibold">Biggest titles</h2>
            <ul className="divide-y divide-border">{d.largest.map((t) => row(t, false))}</ul>
          </section>

          <section className="card space-y-3">
            <h2 className="font-semibold">Recycle bin</h2>
            <p className="hint">Deleted and replaced files wait here before they're gone for good. {formatBytes(d.recycleBin.size)} in the bin.</p>
            {d.recycleBin.items.length ? (
              <ul className="divide-y divide-border">
                {d.recycleBin.items.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{r.title}</div>
                      <div className="truncate text-xs text-muted" title={r.originalPath}>
                        {r.reason ?? 'Deleted'}
                        {r.deletedByName ? ` by ${r.deletedByName}` : ''} · {formatDate(r.deletedAt)}
                      </div>
                    </div>
                    <span className="w-20 shrink-0 text-right tabular-nums">{formatBytes(r.size)}</span>
                    <button className="btn-secondary" onClick={() => run(async () => (await api<{ hint: string }>(`/api/storage/recycle/${r.id}/restore`, { body: {} })).hint)}>
                      Restore
                    </button>
                    <button className="btn-danger" onClick={() => confirm(`Delete ${r.title} for good?`) && void run(async () => (await api(`/api/storage/recycle/${r.id}`, { method: 'DELETE' }), 'Deleted for good.'))}>
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Empty.</p>
            )}
          </section>
        </>
      )}
      {hasRole(me, 'admin') && <StorageRules />}
    </div>
  );
}

function StorageRules() {
  const s = useSettingsSection('storage');
  if (s.loading) return null;
  return (
    <section className="card space-y-4">
      <h2 className="font-semibold">Rules</h2>
      <Toggle label="Use the recycle bin" checked={s.values.recycleBin} onChange={(v) => s.set('recycleBin', v)} hint="Off: deleted and replaced files are gone straight away." />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Keep deleted files for (days)">
          <input className="input w-28" type="number" min={1} max={365} value={s.values.recycleDays} onChange={(e) => s.set('recycleDays', Number(e.target.value))} />
        </Field>
        <Field label="Suggest watched titles after (days)" hint="0 is off">
          <input className="input w-28" type="number" min={0} value={s.values.watchedDays} onChange={(e) => s.set('watchedDays', Number(e.target.value))} />
        </Field>
        <Field label="Suggest unwatched titles after (days)" hint="0 is off">
          <input className="input w-28" type="number" min={0} value={s.values.unwatchedDays} onChange={(e) => s.set('unwatchedDays', Number(e.target.value))} />
        </Field>
      </div>
      <Toggle
        label="Remove the suggestions automatically"
        checked={s.values.autoDelete}
        onChange={(v) => s.set('autoDelete', v)}
        hint="Every night, into the recycle bin (only while the recycle bin is on), so anything can be restored. Each removal is in the activity log."
      />
      <SaveBar onSave={s.save} saving={s.saving} message={s.message} />
    </section>
  );
}
