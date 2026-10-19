import { Field, SecretInput } from '../../components/ui';
import { useSettingsSection } from '../../lib/settings';
import { SaveBar } from './SaveBar';
import { TestButton } from './TestButton';

export function MetadataSettings() {
  const s = useSettingsSection('metadata');
  if (s.loading) return null;
  return (
    <div className="max-w-2xl space-y-6">
      <section className="card space-y-4">
        <h2 className="font-semibold">TMDB</h2>
        <p className="text-sm text-muted">Posters, summaries, release dates, trailers and search. Free key at themoviedb.org → Settings → API. One key serves the whole family.</p>
        <Field label="API key or read access token">
          <SecretInput isSet={s.secretsSet['tmdbApiKey']!} value={s.secrets['tmdbApiKey']} onChange={(v) => s.setSecret('tmdbApiKey', v)} />
        </Field>
        <TestButton service="tmdb" beforeTest={s.save} />
      </section>
      <section className="card space-y-4">
        <h2 className="font-semibold">mdblist</h2>
        <p className="text-sm text-muted">Optional. Adds IMDb, Rotten Tomatoes and other ratings, and lets you import mdblist lists.</p>
        <Field label="API key">
          <SecretInput isSet={s.secretsSet['mdblistApiKey']!} value={s.secrets['mdblistApiKey']} onChange={(v) => s.setSecret('mdblistApiKey', v)} />
        </Field>
        <TestButton service="mdblist" beforeTest={s.save} />
      </section>
      <section className="card space-y-4">
        <h2 className="font-semibold">Region and language</h2>
        <Field label="Language" hint="Used for titles and summaries, e.g. en-US, fr-FR.">
          <input className="input w-40" value={s.values.language} onChange={(e) => s.set('language', e.target.value)} />
        </Field>
        <Field label="Region" hint="Used for release dates and streaming providers, e.g. US, GB.">
          <input className="input w-24" value={s.values.region} onChange={(e) => s.set('region', e.target.value.toUpperCase())} />
        </Field>
        <SaveBar onSave={s.save} saving={s.saving} message={s.message} />
      </section>
    </div>
  );
}
