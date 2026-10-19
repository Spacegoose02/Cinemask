import { Field, SecretInput, Toggle } from '../../components/ui';
import { useSettingsSection } from '../../lib/settings';
import { SaveBar } from './SaveBar';

const ROLES = ['user', 'manager'];
const list = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);

export function SignInSettings() {
  const s = useSettingsSection('auth');
  if (s.loading) return null;
  const o = s.values.oidc;
  const p = s.values.plex;
  return (
    <div className="max-w-2xl space-y-6">
      <section className="card space-y-4">
        <h2 className="font-semibold">General</h2>
        <Toggle
          label="Allow password sign-in"
          checked={s.values.localLoginEnabled}
          onChange={(v) => s.set('localLoginEnabled', v)}
          hint="When off, only single sign-on and Plex work. The owner can always use their password, so a broken SSO setup can't lock you out."
        />
        <Field label="Stay signed in for (days)">
          <input className="input w-32" type="number" min={1} max={365} value={s.values.sessionDays} onChange={(e) => s.set('sessionDays', Number(e.target.value))} />
        </Field>
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">Single sign-on (OIDC)</h2>
        <p className="text-sm text-muted">
          Works with tinyauth, Authelia, Authentik, Keycloak, Pocket ID and other OpenID Connect providers. Use <code>{'<public URL>'}/api/auth/oidc/callback</code> as the redirect URL.
        </p>
        <Toggle label="Enable single sign-on" checked={o.enabled} onChange={(v) => s.set('oidc.enabled', v)} />
        <Field label="Button label">
          <input className="input" value={o.buttonLabel} onChange={(e) => s.set('oidc.buttonLabel', e.target.value)} />
        </Field>
        <Field label="Issuer URL" hint="e.g. https://auth.example.com">
          <input className="input" value={o.issuer} onChange={(e) => s.set('oidc.issuer', e.target.value)} />
        </Field>
        <Field label="Client ID">
          <input className="input" value={o.clientId} onChange={(e) => s.set('oidc.clientId', e.target.value)} />
        </Field>
        <Field label="Client secret">
          <SecretInput isSet={s.secretsSet['oidc.clientSecret']!} value={s.secrets['oidc.clientSecret']} onChange={(v) => s.setSecret('oidc.clientSecret', v)} />
        </Field>
        <Field label="Scopes">
          <input className="input" value={o.scopes} onChange={(e) => s.set('oidc.scopes', e.target.value)} />
        </Field>
        <Field label="Groups claim">
          <input className="input" value={o.groupsClaim} onChange={(e) => s.set('oidc.groupsClaim', e.target.value)} />
        </Field>
        <Field label="Admin groups" hint="Comma separated. Members become admins.">
          <input className="input" defaultValue={o.adminGroups.join(', ')} onBlur={(e) => s.set('oidc.adminGroups', list(e.target.value))} />
        </Field>
        <Field label="Manager groups" hint="Comma separated. Members become managers.">
          <input className="input" defaultValue={o.managerGroups.join(', ')} onBlur={(e) => s.set('oidc.managerGroups', list(e.target.value))} />
        </Field>
        <Field label="Allowed groups" hint="If set, only members of these groups (or the groups above) can sign in.">
          <input className="input" defaultValue={o.userGroups.join(', ')} onBlur={(e) => s.set('oidc.userGroups', list(e.target.value))} />
        </Field>
        <Toggle label="Create accounts on first sign-in" checked={o.autoCreateUsers} onChange={(v) => s.set('oidc.autoCreateUsers', v)} />
        <Field label="Role for new accounts">
          <select className="input" value={o.defaultRole} onChange={(e) => s.set('oidc.defaultRole', e.target.value)}>
            {ROLES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </Field>
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">Sign in with Plex</h2>
        <Toggle label="Enable Plex sign-in" checked={p.enabled} onChange={(v) => s.set('plex.enabled', v)} />
        <Field label="Plex server ID" hint="Only Plex accounts that can access this server may sign in. It fills in automatically once your Plex server is connected.">
          <input className="input" value={p.serverMachineId} onChange={(e) => s.set('plex.serverMachineId', e.target.value)} />
        </Field>
        <Toggle label="Create accounts on first sign-in" checked={p.autoCreateUsers} onChange={(v) => s.set('plex.autoCreateUsers', v)} />
        <Field label="Role for new accounts">
          <select className="input" value={p.defaultRole} onChange={(e) => s.set('plex.defaultRole', e.target.value)}>
            {ROLES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </Field>
      </section>

      <SaveBar onSave={s.save} saving={s.saving} message={s.message} />
    </div>
  );
}
