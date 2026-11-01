import type { AppContext } from '../context.js';
import type { SectionValue } from '../settings/definitions.js';
import { sendWebhook, type Notification } from './service.js';

type Shared = SectionValue<'notifications'>;
export const SHARED_CHANNELS = ['webhook', 'discord', 'telegram', 'ntfy', 'gotify', 'pushover'] as const;
export type SharedChannel = (typeof SHARED_CHANNELS)[number];

const TIMEOUT = 10_000;

async function post(name: string, url: string, init: RequestInit): Promise<void> {
  const res = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT), ...init, headers: { 'User-Agent': 'Cinemask', ...init.headers } });
  if (!res.ok) throw new Error(`${name} responded with HTTP ${res.status}`);
}

const json = (body: unknown): RequestInit => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** A full link back into Cinemask, when the public URL is set (Settings → General). */
function link(ctx: AppContext, n: Notification): string | null {
  const base = ctx.settings.get('general').baseUrl.replace(/\/+$/, '');
  return base && n.url ? `${base}${n.url}` : null;
}

/** Which shared channels have what they need to send. */
export function configuredChannels(s: Shared): SharedChannel[] {
  const out: SharedChannel[] = [];
  if (s.webhookUrl) out.push('webhook');
  if (s.discordWebhookUrl) out.push('discord');
  if (s.telegramBotToken && s.telegramChatId) out.push('telegram');
  if (s.ntfyUrl) out.push('ntfy');
  if (s.gotifyUrl && s.gotifyToken) out.push('gotify');
  if (s.pushoverUser && s.pushoverToken) out.push('pushover');
  return out;
}

export async function sendTo(ctx: AppContext, channel: SharedChannel, s: Shared, n: Notification): Promise<void> {
  const url = link(ctx, n);
  switch (channel) {
    case 'webhook':
      return sendWebhook(s.webhookUrl, n);
    case 'discord':
      return post('Discord', s.discordWebhookUrl, json({ username: 'Cinemask', embeds: [{ title: n.title, description: n.message.slice(0, 4000), ...(url ? { url } : {}), color: 0xf59e0b }], allowed_mentions: { parse: [] } }));
    case 'telegram':
      return post('Telegram', `https://api.telegram.org/bot${encodeURIComponent(s.telegramBotToken)}/sendMessage`, json({ chat_id: s.telegramChatId, text: `${n.title}\n${n.message}${url ? `\n${url}` : ''}`.slice(0, 4000), disable_web_page_preview: true }));
    case 'ntfy':
      return post('ntfy', s.ntfyUrl, {
        headers: {
          // Header values must be plain ASCII; the message body carries the rest.
          Title: n.title.replace(/[^\x20-\x7e]/g, ''),
          Tags: 'raccoon',
          ...(url ? { Click: url } : {}),
          ...(s.ntfyToken ? { Authorization: `Bearer ${s.ntfyToken}` } : {}),
        },
        body: n.message,
      });
    case 'gotify':
      return post('Gotify', `${s.gotifyUrl.replace(/\/+$/, '')}/message`, {
        headers: { 'Content-Type': 'application/json', 'X-Gotify-Key': s.gotifyToken },
        body: JSON.stringify({ title: n.title, message: n.message, priority: n.event === 'health.problem' ? 8 : 5, ...(url ? { extras: { 'client::notification': { click: { url } } } } : {}) }),
      });
    case 'pushover':
      return post('Pushover', 'https://api.pushover.net/1/messages.json', {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: s.pushoverToken, user: s.pushoverUser, title: n.title, message: n.message, ...(url ? { url, url_title: 'Open in Cinemask' } : {}) }),
      });
  }
}

/** Sends an event to every configured shared channel that wants it. One failing channel doesn't stop the others. */
export async function sendShared(ctx: AppContext, n: Notification): Promise<void> {
  const s = ctx.settings.get('notifications');
  if (!s.enabled || !s.events.includes(n.event)) return;
  await Promise.allSettled(configuredChannels(s).map((c) => sendTo(ctx, c, s, n)));
}

/** Errors from a channel without its secrets: tokens and webhook ids live in URLs. */
export function cleanError(err: unknown): string {
  const e = err as Error;
  if (e.name === 'TimeoutError') return 'It timed out';
  return e.message.replace(/https?:\/\/\S+/g, '(link)').replace(/bot\d+:[\w-]+/g, 'bot(token)');
}
