import { useQuery } from '@tanstack/react-query';
import { Field, SecretInput, Toggle } from '../../components/ui';
import { api } from '../../lib/api';
import { useSettingsSection } from '../../lib/settings';
import { SaveBar } from './SaveBar';
import { TestButton } from './TestButton';

interface AbsLibrary {
  id: string;
  name: string;
  mediaType: 'book' | 'podcast';
}

export function BookSettings() {
  const abs = useSettingsSection('audiobookshelf');
  const sm = useSettingsSection('shelfmark');
  const libs = useQuery({
    queryKey: ['abs-libraries', abs.values?.url],
    queryFn: () => api<AbsLibrary[]>('/api/audiobookshelf/libraries'),
    enabled: Boolean(abs.values?.enabled && abs.values?.url && abs.secretsSet['apiKey']),
    retry: false,
  });
  if (abs.loading || sm.loading) return null;
  const pick = (type: AbsLibrary['mediaType'], key: 'audiobookLibraryId' | 'podcastLibraryId', label: string) => (
    <Field label={label}>
      {libs.data ? (
        <select className="input" value={abs.values[key]} onChange={(e) => abs.set(key, e.target.value)}>
          <option value="">None</option>
          {libs.data
            .filter((l) => l.mediaType === type)
            .map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
        </select>
      ) : (
        <p className="text-sm text-muted">{libs.error ? (libs.error as Error).message : 'Save the address and token, then pick a library here.'}</p>
      )}
    </Field>
  );
  return (
    <div className="max-w-2xl space-y-6">
      <section className="card space-y-4">
        <h2 className="font-semibold">Audiobookshelf</h2>
        <p className="text-sm text-muted">
          Shows your audiobooks and podcasts in Cinemask, rescans after an audiobook download, and subscribes to podcasts. Create an API token in Audiobookshelf under Settings → Users → your user.
        </p>
        <Toggle label="Use Audiobookshelf" checked={abs.values.enabled} onChange={(v) => abs.set('enabled', v)} />
        <Field label="Address" hint="For example http://192.168.1.10:13378">
          <input className="input" value={abs.values.url} onChange={(e) => abs.set('url', e.target.value)} placeholder="http://audiobookshelf:80" />
        </Field>
        <Field label="API token">
          <SecretInput isSet={abs.secretsSet['apiKey']!} value={abs.secrets['apiKey']} onChange={(v) => abs.setSecret('apiKey', v)} />
        </Field>
        {pick('book', 'audiobookLibraryId', 'Audiobook library')}
        {pick('podcast', 'podcastLibraryId', 'Podcast library')}
        <p className="text-xs text-muted">Downloaded audiobooks go to the audiobooks folder set in Media management, so point that at the folder this library watches.</p>
        <div className="flex flex-wrap items-center gap-3">
          <TestButton service="audiobookshelf" beforeTest={abs.save} />
        </div>
        <SaveBar onSave={abs.save} saving={abs.saving} message={abs.message} />
      </section>
      <section className="card space-y-4">
        <h2 className="font-semibold">Shelfmark</h2>
        <p className="text-sm text-muted">Optional. Finds and downloads ebooks (and audiobooks, if you choose) through Shelfmark. Book requests it can't fill fall back to your indexers.</p>
        <Toggle label="Use Shelfmark" checked={sm.values.enabled} onChange={(v) => sm.set('enabled', v)} />
        <Field label="Address">
          <input className="input" value={sm.values.url} onChange={(e) => sm.set('url', e.target.value)} placeholder="http://shelfmark:8084" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Username" hint="Only if Shelfmark has sign-in turned on.">
            <input className="input" value={sm.values.username} onChange={(e) => sm.set('username', e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Password">
            <SecretInput isSet={sm.secretsSet['password']!} value={sm.secrets['password']} onChange={(v) => sm.setSecret('password', v)} />
          </Field>
        </div>
        <Field label="Shelfmark's download folder" hint="As seen inside the Cinemask container. Finished books are moved from here into your books folder.">
          <input className="input" value={sm.values.ingestPath} onChange={(e) => sm.set('ingestPath', e.target.value)} />
        </Field>
        <Field label="Use Shelfmark for">
          <select className="input w-auto" value={sm.values.useFor} onChange={(e) => sm.set('useFor', e.target.value)}>
            <option value="ebooks">Ebooks only</option>
            <option value="both">Ebooks and audiobooks</option>
          </select>
        </Field>
        <TestButton service="shelfmark" beforeTest={sm.save} />
        <SaveBar onSave={sm.save} saving={sm.saving} message={sm.message} />
      </section>
    </div>
  );
}
