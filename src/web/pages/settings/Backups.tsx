import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Alert, Field, SecretInput, Toggle } from '../../components/ui';
import { api, formatBytes, formatDate } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useSettingsSection } from '../../lib/settings';
import { SaveBar } from './SaveBar';

interface BackupList {
  backups: { name: string; size: number; createdAt: number; encrypted: boolean; reason: string }[];
  status: { lastBackupAt: number | null; lastError: string | null; lastRemoteAt: number | null; lastRemoteError: string | null };
  nextScheduled: number | null;
}

export function BackupSettings() {
  const { me, refresh } = useAuth();
  const qc = useQueryClient();
  const s = useSettingsSection('backup');
  const list = useQuery({ queryKey: ['backups'], queryFn: () => api<BackupList>('/api/backups') });
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: 'success', text: success });
      await qc.invalidateQueries({ queryKey: ['backups'] });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const afterRestore = async () => {
    alert('Restore complete. Everyone has been signed out; sign in with an account from the backup.');
    await refresh();
  };

  const restore = (name: string, encrypted: boolean) => {
    if (!confirm(`Restore ${name}? Everything since then will be replaced. A safety backup is taken first.`)) return;
    const passphrase = encrypted ? (prompt('Backup passphrase (leave blank to use the saved one):') ?? undefined) : undefined;
    void run(() => api(`/api/backups/${name}/restore`, { body: { passphrase: passphrase || undefined } }).then(afterRestore), 'Restored.');
  };

  const uploadRestore = (file: File) => {
    if (!confirm(`Restore from ${file.name}? Everything will be replaced. A safety backup is taken first.`)) return;
    const passphrase = prompt('Passphrase, if the backup is encrypted:') ?? '';
    void run(
      () =>
        api('/api/backups/upload-restore', {
          raw: file,
          headers: { 'content-type': 'application/octet-stream', ...(passphrase ? { 'x-backup-passphrase': passphrase } : {}) },
        }).then(afterRestore),
      'Restored.',
    );
  };

  const st = list.data?.status;
  const r = s.values.remote;

  return (
    <div className="max-w-3xl space-y-6">
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <section className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <div>Last backup: {formatDate(st?.lastBackupAt)}</div>
            <div className="text-muted">Next scheduled: {formatDate(list.data?.nextScheduled)}</div>
            {st?.lastError && <div className="text-danger">Last backup failed: {st.lastError}</div>}
            {st?.lastRemoteError && <div className="text-danger">Remote copy failed: {st.lastRemoteError}</div>}
          </div>
          <div className="flex gap-2">
            <button className="btn-primary" disabled={busy} onClick={() => run(() => api('/api/backups', { method: 'POST' }), 'Backup created.')}>
              Back up now
            </button>
            {me?.isOwner && (
              <>
                <button className="btn-secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
                  Restore from file
                </button>
                <input ref={fileRef} type="file" className="hidden" onChange={(e) => e.target.files?.[0] && uploadRestore(e.target.files[0])} />
              </>
            )}
          </div>
        </div>
        <ul className="divide-y divide-border text-sm">
          {list.data?.backups.map((b) => (
            <li key={b.name} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>
                <div className="font-mono text-xs">{b.name}</div>
                <div className="text-xs text-muted">
                  {formatDate(b.createdAt)} · {formatBytes(b.size)} · {b.encrypted ? 'encrypted' : 'not encrypted'}
                </div>
              </div>
              {me?.isOwner && (
                <div className="flex gap-2">
                  <a className="btn-secondary" href={`/api/backups/${b.name}/download`}>
                    Download
                  </a>
                  <button className="btn-secondary" disabled={busy} onClick={() => restore(b.name, b.encrypted)}>
                    Restore
                  </button>
                  <button
                    className="btn-danger"
                    disabled={busy}
                    onClick={() => confirm(`Delete ${b.name}?`) && run(() => api(`/api/backups/${b.name}`, { method: 'DELETE' }), 'Deleted.')}
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
          {list.data?.backups.length === 0 && <li className="py-2 text-muted">No backups yet.</li>}
        </ul>
      </section>

      {!s.loading && (
        <>
          <section className="card space-y-4">
            <h2 className="font-semibold">Schedule</h2>
            <Toggle label="Back up automatically" checked={s.values.scheduleEnabled} onChange={(v) => s.set('scheduleEnabled', v)} />
            <Field label="Schedule (cron)" hint="Default 0 3 * * * runs every night at 3am.">
              <input className="input" value={s.values.cron} onChange={(e) => s.set('cron', e.target.value)} />
            </Field>
            <Field label="Backups to keep">
              <input className="input w-32" type="number" min={1} value={s.values.retention} onChange={(e) => s.set('retention', Number(e.target.value))} />
            </Field>
            <Field label="Encryption passphrase" hint="Encrypts backup files. Store it somewhere safe: without it an encrypted backup can't be restored.">
              <SecretInput isSet={s.secretsSet['passphrase']!} value={s.secrets['passphrase']} onChange={(v) => s.setSecret('passphrase', v)} />
            </Field>
          </section>

          <section className="card space-y-4">
            <h2 className="font-semibold">Remote copy</h2>
            <Field label="Copy each backup to">
              <select className="input" value={r.type} onChange={(e) => s.set('remote.type', e.target.value)}>
                <option value="none">Nowhere (local only)</option>
                <option value="path">A folder (another share, NAS or mounted drive)</option>
                <option value="s3">S3-compatible storage (Backblaze B2, Wasabi, MinIO, AWS)</option>
              </select>
            </Field>
            {r.type === 'path' && (
              <Field label="Folder path" hint="Path inside the container, e.g. /remote-backups mapped to another Unraid share.">
                <input className="input" value={r.path} onChange={(e) => s.set('remote.path', e.target.value)} />
              </Field>
            )}
            {r.type === 's3' && (
              <>
                <Field label="Endpoint" hint="Leave blank for AWS.">
                  <input className="input" value={r.s3.endpoint} onChange={(e) => s.set('remote.s3.endpoint', e.target.value)} />
                </Field>
                <Field label="Region">
                  <input className="input" value={r.s3.region} onChange={(e) => s.set('remote.s3.region', e.target.value)} />
                </Field>
                <Field label="Bucket">
                  <input className="input" value={r.s3.bucket} onChange={(e) => s.set('remote.s3.bucket', e.target.value)} />
                </Field>
                <Field label="Prefix">
                  <input className="input" value={r.s3.prefix} onChange={(e) => s.set('remote.s3.prefix', e.target.value)} />
                </Field>
                <Field label="Access key ID">
                  <input className="input" value={r.s3.accessKeyId} onChange={(e) => s.set('remote.s3.accessKeyId', e.target.value)} />
                </Field>
                <Field label="Secret access key">
                  <SecretInput
                    isSet={s.secretsSet['remote.s3.secretAccessKey']!}
                    value={s.secrets['remote.s3.secretAccessKey']}
                    onChange={(v) => s.setSecret('remote.s3.secretAccessKey', v)}
                  />
                </Field>
                <Toggle label="Path-style URLs" checked={r.s3.forcePathStyle} onChange={(v) => s.set('remote.s3.forcePathStyle', v)} hint="Needed for MinIO and most self-hosted S3." />
              </>
            )}
            {r.type !== 'none' && (
              <Field label="Remote backups to keep">
                <input className="input w-32" type="number" min={1} value={r.retention} onChange={(e) => s.set('remote.retention', Number(e.target.value))} />
              </Field>
            )}
          </section>
          <SaveBar onSave={s.save} saving={s.saving} message={s.message} />
        </>
      )}
    </div>
  );
}
