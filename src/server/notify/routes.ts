import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { pushSubscriptions, users } from '../db/schema.js';
import { badRequest, HttpError, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { allowedPushEndpoint, eventsFor, prefsOf, prefsSchema, removeSubscription, sendEmail, sendPush, subscriptionsOf, vapidKeys } from './personal.js';
import { cleanError } from './channels.js';

const base64url = z.string().min(10).max(200).regex(/^[\w-]+=*$/);

/** Account → Notifications: each person's own devices, email and which events they want. */
export async function notificationRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const me = (id: number) => ctx.db.select().from(users).where(eq(users.id, id)).get()!;

  app.get('/api/notifications/me', { config: { access: 'user' } }, async (req) => {
    const u = me(req.user!.id);
    return {
      prefs: prefsOf(u.notifyPrefs),
      events: eventsFor(u.role),
      publicKey: vapidKeys(ctx).publicKey,
      devices: subscriptionsOf(ctx, u.id).map((s) => ({ id: s.id, device: s.device, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt })),
      emailAvailable: ctx.settings.get('email').enabled,
      email: u.email,
    };
  });

  app.put('/api/notifications/me', { config: { access: 'user' } }, async (req) => {
    const body = parse(prefsSchema.extend({ address: z.union([z.literal(''), z.email().max(254)]).optional() }), req.body);
    const { address: email, ...prefs } = body;
    // Only events this person can hear about are kept.
    const allowed = eventsFor(me(req.user!.id).role) as string[];
    prefs.off = prefs.off.filter((e) => allowed.includes(e));
    ctx.db
      .update(users)
      .set({ notifyPrefs: JSON.stringify(prefs), ...(email !== undefined ? { email: email || null } : {}) })
      .where(eq(users.id, req.user!.id))
      .run();
    return prefs;
  });

  /** Saves this browser's push subscription for the signed-in person. */
  app.post('/api/notifications/push', { config: { access: 'user' } }, async (req) => {
    const body = parse(
      z.object({
        endpoint: z.url().max(1000),
        keys: z.object({ p256dh: base64url, auth: z.string().min(10).max(100).regex(/^[\w-]+=*$/) }),
        device: z.string().trim().max(80).optional(),
      }),
      req.body,
    );
    if (!allowedPushEndpoint(body.endpoint)) throw badRequest("That browser's push service isn't supported");
    const values = { userId: req.user!.id, endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth, device: body.device ?? null, createdAt: Date.now() };
    // A shared device signed in by someone else now belongs to whoever turned notifications on last.
    ctx.db
      .insert(pushSubscriptions)
      .values(values)
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId: values.userId, p256dh: values.p256dh, auth: values.auth, device: values.device } })
      .run();
    return { ok: true };
  });

  app.delete('/api/notifications/push', { config: { access: 'user' } }, async (req) => {
    const { endpoint } = parse(z.object({ endpoint: z.string().max(1000) }), req.body);
    removeSubscription(ctx, req.user!.id, endpoint);
    return { ok: true };
  });

  app.delete('/api/notifications/push/:id', { config: { access: 'user' } }, async (req) => {
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const res = ctx.db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, req.user!.id))).run();
    if (!res.changes) throw notFound('That device was not found');
    return { ok: true };
  });

  /** Sends a test to the signed-in person's own devices and email. */
  app.post('/api/notifications/me/test', { config: { access: 'user', rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req.user!.id);
    const prefs = prefsOf(u.notifyPrefs);
    const n = { event: 'request.available' as const, title: 'Test from Cinemask', message: 'Notifications work on this device.', url: '/account' };
    const devices = prefs.push ? await sendPush(ctx, [u.id], n) : 0;
    let emailed = false;
    if (prefs.email && u.email && ctx.settings.get('email').enabled) {
      try {
        await sendEmail(ctx, u.email, n);
        emailed = true;
      } catch (err) {
        throw new HttpError(502, `The email couldn't be sent: ${cleanError(err)}`, 'upstream');
      }
    }
    if (!devices && !emailed) return { ok: false, message: 'Nothing to send to. Turn on notifications on this device, or email.' };
    return { ok: true, message: [devices && `Sent to ${devices} device${devices === 1 ? '' : 's'}`, emailed && `emailed ${u.email}`].filter(Boolean).join(' and ') + '.' };
  });

  /** Sends a test email to the admin, with the saved email settings. */
  app.post('/api/notifications/email/test', { config: { access: 'admin' } }, async (req) => {
    const u = me(req.user!.id);
    if (!u.email) throw badRequest('Add your own email address in Account first, so the test has somewhere to go');
    try {
      await sendEmail(ctx, u.email, { title: 'Test from Cinemask', message: 'If you can read this, email works.', url: '/' });
    } catch (err) {
      return { ok: false, message: cleanError(err) };
    }
    audit(ctx.db, req, 'notifications.tested', { target: 'email' });
    return { ok: true, message: `Sent a test to ${u.email}` };
  });
}
