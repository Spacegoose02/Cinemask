import type { AppContext } from '../context.js';

export const NOTIFY_EVENTS = ['request.created', 'request.available', 'download.imported', 'download.failed', 'health.problem'] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export interface Notification {
  event: NotifyEvent;
  title: string;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Sends an event to the configured webhook (a Home Assistant webhook trigger, n8n, etc.) as JSON.
 * Fire-and-forget: a slow or broken webhook never holds up or fails the work that triggered it.
 */
export function notify(ctx: AppContext, n: Notification): void {
  const s = ctx.settings.get('notifications');
  if (!s.enabled || !s.webhookUrl || !s.events.includes(n.event)) return;
  void sendWebhook(s.webhookUrl, n).catch(() => undefined);
}

export async function sendWebhook(url: string, n: Notification): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Cinemask' },
    body: JSON.stringify({ source: 'cinemask', ...n, at: new Date().toISOString() }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`The webhook responded with HTTP ${res.status}`);
}
