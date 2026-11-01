import { and, eq, inArray } from 'drizzle-orm';
import nodemailer, { type Transporter } from 'nodemailer';
import webpush from 'web-push';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { pushSubscriptions, users, type Role } from '../db/schema.js';
import { hasRole } from '../auth/guard.js';
import type { Notification, NotifyEvent } from './service.js';

/** Who hears an event on their own devices when it isn't addressed to anyone in particular. */
export const AUDIENCE: Record<NotifyEvent, 'addressed' | Role | 'everyone'> = {
  'request.created': 'manager',
  'request.approved': 'addressed',
  'request.declined': 'addressed',
  'request.available': 'addressed',
  'download.imported': 'manager',
  'download.failed': 'manager',
  'download.warning': 'manager',
  'health.problem': 'admin',
  'movie_night.created': 'everyone',
  'movie_night.reminder': 'everyone',
  'issue.created': 'manager',
  'issue.resolved': 'addressed',
};

export const prefsSchema = z.object({
  /** Notifications on the devices where this person turned them on. */
  push: z.boolean().default(true),
  email: z.boolean().default(false),
  /** Events this person doesn't want. */
  off: z.array(z.string().max(40)).max(40).default(['download.imported']),
});
export type NotifyPrefs = z.output<typeof prefsSchema>;

export function prefsOf(raw: string | null): NotifyPrefs {
  try {
    return prefsSchema.parse(raw ? JSON.parse(raw) : {});
  } catch {
    return prefsSchema.parse({});
  }
}

/** The events a person of this role can hear about, for Account → Notifications. */
export function eventsFor(role: Role): NotifyEvent[] {
  return (Object.keys(AUDIENCE) as NotifyEvent[]).filter((e) => {
    const a = AUDIENCE[e];
    return a === 'addressed' || a === 'everyone' || hasRole(role, a);
  });
}

function recipients(ctx: AppContext, n: Notification) {
  const audience = AUDIENCE[n.event];
  const active = ctx.db.select().from(users).where(eq(users.disabled, false)).all();
  const chosen = n.to ? active.filter((u) => n.to!.includes(u.id)) : audience === 'addressed' ? [] : active.filter((u) => audience === 'everyone' || hasRole(u.role, audience));
  return chosen.map((u) => ({ user: u, prefs: prefsOf(u.notifyPrefs) })).filter((r) => !r.prefs.off.includes(n.event));
}

/** Push services browsers use. Subscriptions anywhere else are refused, so they can't aim the server at other hosts. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/, /^push\.services\.mozilla\.com$/];

export function allowedPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((h) => h.test(u.hostname));
  } catch {
    return false;
  }
}

/** The keys browsers check pushes against, made once and kept in settings. */
export function vapidKeys(ctx: AppContext): { publicKey: string; privateKey: string } {
  const s = ctx.settings.get('webpush');
  if (s.publicKey && s.privateKey) return s;
  const keys = webpush.generateVAPIDKeys();
  ctx.settings.update('webpush', { publicKey: keys.publicKey, privateKey: keys.privateKey });
  return keys;
}

function subject(ctx: AppContext): string {
  const base = ctx.settings.get('general').baseUrl;
  return base.startsWith('https://') ? base : 'mailto:cinemask@localhost';
}

export async function sendPush(ctx: AppContext, userIds: number[], n: Pick<Notification, 'title' | 'message' | 'url' | 'event'>): Promise<number> {
  if (!userIds.length) return 0;
  const subs = ctx.db.select().from(pushSubscriptions).where(inArray(pushSubscriptions.userId, userIds)).all();
  if (!subs.length) return 0;
  const keys = vapidKeys(ctx);
  const payload = JSON.stringify({ title: n.title, body: n.message, url: n.url ?? '/', tag: n.event });
  let sent = 0;
  await Promise.allSettled(
    subs.map(async (s) => {
      if (!allowedPushEndpoint(s.endpoint)) return;
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
          vapidDetails: { subject: subject(ctx), publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: 24 * 60 * 60,
          timeout: 10_000,
        });
        sent++;
        ctx.db.update(pushSubscriptions).set({ lastUsedAt: Date.now() }).where(eq(pushSubscriptions.id, s.id)).run();
      } catch (err) {
        // Gone: the browser dropped the subscription (app removed, permission taken back).
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) ctx.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id)).run();
      }
    }),
  );
  return sent;
}

let mailer: { key: string; transport: Transporter } | null = null;

function transport(ctx: AppContext) {
  const s = ctx.settings.get('email');
  if (!s.enabled || !s.host || !s.from) return null;
  const key = JSON.stringify(s);
  if (mailer?.key !== key) {
    mailer = {
      key,
      transport: nodemailer.createTransport({
        host: s.host,
        port: s.port,
        secure: s.security === 'tls',
        requireTLS: s.security === 'starttls',
        ignoreTLS: s.security === 'none',
        auth: s.username ? { user: s.username, pass: s.password } : undefined,
        connectionTimeout: 10_000,
        socketTimeout: 15_000,
      }),
    };
  }
  return { transport: mailer.transport, from: s.fromName ? { name: s.fromName, address: s.from } : s.from };
}

export async function sendEmail(ctx: AppContext, to: string, n: Pick<Notification, 'title' | 'message' | 'url'>): Promise<void> {
  const t = transport(ctx);
  if (!t) throw new Error('Email is not set up (Settings → Notifications)');
  const base = ctx.settings.get('general').baseUrl.replace(/\/+$/, '');
  const link = base && n.url ? `\n\nOpen in Cinemask: ${base}${n.url}` : '';
  await t.transport.sendMail({ from: t.from, to, subject: n.title, text: `${n.message}${link}\n\n(You can change which emails you get in Cinemask → Account.)` });
}

/** Sends an event to each person who should hear it, on the channels they picked. */
export async function deliverPersonal(ctx: AppContext, n: Notification): Promise<void> {
  const people = recipients(ctx, n);
  if (!people.length) return;
  await sendPush(
    ctx,
    people.filter((p) => p.prefs.push).map((p) => p.user.id),
    n,
  );
  const mail = people.filter((p) => p.prefs.email && p.user.email);
  if (mail.length && ctx.settings.get('email').enabled) await Promise.allSettled(mail.map((p) => sendEmail(ctx, p.user.email!, n)));
}

export function subscriptionsOf(ctx: AppContext, userId: number) {
  return ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).all();
}

export function removeSubscription(ctx: AppContext, userId: number, endpoint: string) {
  ctx.db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint))).run();
}
