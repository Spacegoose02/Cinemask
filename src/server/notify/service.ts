import type { AppContext } from '../context.js';
import { sendShared } from './channels.js';
import { deliverPersonal } from './personal.js';

export const NOTIFY_EVENTS = [
  'request.created',
  'request.approved',
  'request.declined',
  'request.available',
  'download.imported',
  'download.failed',
  'download.warning',
  'health.problem',
  'movie_night.created',
  'movie_night.reminder',
  'issue.created',
  'issue.resolved',
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export interface Notification {
  event: NotifyEvent;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  /**
   * People this is about (the requester and followers, say). Personal events only go to them;
   * without it they go to whoever the event's audience is (managers, admins or everyone).
   */
  to?: number[];
  /** The page in Cinemask a tap on the notification opens, such as /movie/116149. */
  url?: string;
}

/**
 * Sends an event to the household's shared channels (webhook, Discord, Telegram, ntfy, Gotify,
 * Pushover) and to each person's own devices and email, as they chose in Account → Notifications.
 * Fire-and-forget: a slow or broken channel never holds up or fails the work that triggered it.
 */
export function notify(ctx: AppContext, n: Notification): void {
  const url = n.url ?? defaultUrl(n);
  const full = { ...n, url };
  void sendShared(ctx, full).catch(() => undefined);
  void deliverPersonal(ctx, full).catch(() => undefined);
}

function defaultUrl(n: Notification): string | undefined {
  const d = n.data ?? {};
  if ((d.kind === 'movie' || d.kind === 'show') && typeof d.tmdbId === 'number') return `/${d.kind === 'movie' ? 'movie' : 'tv'}/${d.tmdbId}`;
  if (n.event.startsWith('movie_night')) return '/movie-nights';
  if (n.event.startsWith('download')) return '/downloads';
  if (n.event === 'health.problem') return '/settings/health';
  if (n.event.startsWith('request')) return '/requests';
  return undefined;
}

export async function sendWebhook(url: string, n: Notification): Promise<void> {
  // Who it was addressed to stays private.
  const rest = { ...n, to: undefined };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Cinemask' },
    body: JSON.stringify({ source: 'cinemask', ...rest, at: new Date().toISOString() }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`The webhook responded with HTTP ${res.status}`);
}
