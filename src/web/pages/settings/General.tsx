import { Field } from '../../components/ui';
import { useSettingsSection } from '../../lib/settings';
import { SaveBar } from './SaveBar';

export function GeneralSettings() {
  const s = useSettingsSection('general');
  if (s.loading) return null;
  return (
    <div className="card max-w-2xl space-y-4">
      <Field label="Public URL" hint="The address your family uses to reach this app, e.g. https://media.example.com. Needed for single sign-on.">
        <input className="input" value={s.values.baseUrl} onChange={(e) => s.set('baseUrl', e.target.value)} placeholder="https://media.example.com" />
      </Field>
      <SaveBar onSave={s.save} saving={s.saving} message={s.message} />
    </div>
  );
}
