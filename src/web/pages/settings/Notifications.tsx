import { Field, SecretInput, Toggle } from '../../components/ui';
import { EVENT_LABELS } from '../../components/NotificationPrefs';
import { useSettingsSection } from '../../lib/settings';
import { SaveBar } from './SaveBar';
import { TestButton } from './TestButton';

type Section = ReturnType<typeof useSettingsSection>;

/** A secret field (token, webhook URL) in the notifications section. */
function Secret({ n, name, label, hint, placeholder }: { n: Section; name: string; label: string; hint?: string; placeholder?: string }) {
  return (
    <Field label={label} hint={hint}>
      <SecretInput isSet={n.secretsSet[name]!} value={n.secrets[name]} onChange={(v) => n.setSecret(name, v)} placeholder={placeholder} />
    </Field>
  );
}

/** Settings → Notifications: shared channels for the household, and email for people's own notifications. */
export function NotificationSettings() {
  const n = useSettingsSection('notifications');
  const e = useSettingsSection('email');
  if (n.loading || e.loading) return null;
  const events: string[] = n.values.events;
  const test = (channel: string) => <TestButton service={channel} beforeTest={n.save} endpoint="/api/notifications/test" body={{ channel }} label="Save and send a test" />;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        Everyone picks their own notifications in Account → Notifications: phone and browser notifications, and email if you set it up below. The channels here are shared ones, such as a family Discord channel, and get the events you tick.
      </p>

      <section className="card space-y-4">
        <h2 className="font-semibold">Shared channels</h2>
        <Toggle label="Send events to the shared channels" checked={n.values.enabled} onChange={(v) => n.set('enabled', v)} />
        <fieldset className="space-y-2">
          <legend className="label">Events</legend>
          {Object.entries(EVENT_LABELS).map(([id, label]) => (
            <label key={id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={events.includes(id)} onChange={(ev) => n.set('events', ev.target.checked ? [...events, id] : events.filter((x) => x !== id))} />
              {label.replace(/\bmy\b/g, 'a').replace(/\bI\b/g, 'someone')}
            </label>
          ))}
        </fieldset>
        <SaveBar onSave={n.save} saving={n.saving} message={n.message} />
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">Discord</h2>
        <Secret n={n} name="discordWebhookUrl" label="Channel webhook URL" hint="Discord → channel settings → Integrations → Webhooks → New webhook → Copy URL." placeholder="https://discord.com/api/webhooks/…" />
        {test('discord')}
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">Telegram</h2>
        <Secret n={n} name="telegramBotToken" label="Bot token" hint="Make a bot with @BotFather and paste its token. Add the bot to your group." />
        <Field label="Chat id" hint="Your chat or group id (groups start with -100), or @channelname.">
          <input className="input" value={n.values.telegramChatId} onChange={(ev) => n.set('telegramChatId', ev.target.value)} />
        </Field>
        {test('telegram')}
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">ntfy</h2>
        <Secret n={n} name="ntfyUrl" label="Topic URL" hint="Your ntfy server and topic. Anyone who knows a public topic can read it, so pick a long, unguessable name." placeholder="https://ntfy.sh/cinemask-family-7f3a" />
        <Secret n={n} name="ntfyToken" label="Access token (optional)" hint="For a topic on your own server that needs a sign-in." />
        {test('ntfy')}
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">Gotify</h2>
        <Field label="Server URL">
          <input className="input" value={n.values.gotifyUrl} placeholder="https://gotify.example.com" onChange={(ev) => n.set('gotifyUrl', ev.target.value)} />
        </Field>
        <Secret n={n} name="gotifyToken" label="Application token" hint="Gotify → Apps → Create application." />
        {test('gotify')}
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">Pushover</h2>
        <Secret n={n} name="pushoverUser" label="User or group key" />
        <Secret n={n} name="pushoverToken" label="Application token" hint="pushover.net → Create an Application/API Token." />
        {test('pushover')}
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">Webhook (Home Assistant and others)</h2>
        <p className="text-sm text-muted">Cinemask POSTs a small JSON message to this address. In Home Assistant, create an automation with a Webhook trigger and paste its URL here. The guide in docs/home-assistant.md has examples.</p>
        <Secret n={n} name="webhookUrl" label="Webhook URL" hint="Kept secret, since the id in the URL is what lets anyone call it." placeholder="http://homeassistant.local:8123/api/webhook/cinemask" />
        {test('webhook')}
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">Email</h2>
        <p className="text-sm text-muted">With email set up, people can choose to get their notifications by email in Account → Notifications.</p>
        <Toggle label="Allow email notifications" checked={e.values.enabled} onChange={(v) => e.set('enabled', v)} />
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="SMTP server">
            <input className="input" value={e.values.host} placeholder="smtp.example.com" onChange={(ev) => e.set('host', ev.target.value)} />
          </Field>
          <Field label="Port">
            <input className="input w-28" type="number" value={e.values.port} onChange={(ev) => e.set('port', Number(ev.target.value))} />
          </Field>
          <Field label="Security">
            <select className="input" value={e.values.security} onChange={(ev) => e.set('security', ev.target.value)}>
              <option value="starttls">STARTTLS (usually port 587)</option>
              <option value="tls">TLS (usually port 465)</option>
              <option value="none">None (local relay only)</option>
            </select>
          </Field>
          <Field label="Username">
            <input className="input" autoComplete="off" value={e.values.username} onChange={(ev) => e.set('username', ev.target.value)} />
          </Field>
          <Field label="Password">
            <SecretInput isSet={e.secretsSet['password']!} value={e.secrets['password']} onChange={(v) => e.setSecret('password', v)} />
          </Field>
          <Field label="From address">
            <input className="input" type="email" value={e.values.from} placeholder="cinemask@example.com" onChange={(ev) => e.set('from', ev.target.value)} />
          </Field>
        </div>
        <TestButton service="email" beforeTest={e.save} endpoint="/api/notifications/email/test" body={{}} label="Save and email me a test" />
        <SaveBar onSave={e.save} saving={e.saving} message={e.message} />
      </section>
    </div>
  );
}
