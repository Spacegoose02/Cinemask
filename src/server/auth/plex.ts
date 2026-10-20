import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { users } from '../db/schema.js';
import { badRequest } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { sha256 } from '../security/crypto.js';
import * as plextv from '../integrations/plextv.js';
import { peekAuthState, putAuthState, resolveExternalUser, takeAuthState } from './external.js';
import { createSession } from './sessions.js';

interface PlexState {
  pinId: number;
  linkUserId?: number;
}

export function plexHeaders(app: FastifyInstance): plextv.PlexHeaders {
  // Stable per install, derived from the instance key so it survives restarts without being stored.
  return { clientId: `mm-${sha256(app.ctx.secretKey.toString('hex')).slice(0, 24)}`, product: 'Cinemask' };
}

export async function plexAuthRoutes(app: FastifyInstance) {
  const limit = { rateLimit: { max: 30, timeWindow: '1 minute' } };

  app.post('/api/auth/plex/start', { config: { access: 'public', ...limit } }, async (req) => {
    const s = app.ctx.settings.get('auth').plex;
    const { link } = parse(z.object({ link: z.boolean().optional() }).default({}), req.body ?? {});
    if (!s.enabled && !link) throw badRequest('Plex sign-in is turned off');
    if (link && !req.user) throw badRequest('Sign in first to link a Plex account');
    const h = plexHeaders(app);
    const pin = await plextv.createPin(h);
    const state = putAuthState(app, 'plex', { pinId: pin.id, linkUserId: link ? req.user!.id : undefined } satisfies PlexState);
    return { state, authUrl: plextv.authAppUrl(h, pin.code) };
  });

  /** Polled by the browser until the user finishes signing in on plex.tv. */
  app.post('/api/auth/plex/poll', { config: { access: 'public', rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { state } = parse(z.object({ state: z.string().max(200) }), req.body);
    const saved = peekAuthState<PlexState>(app, 'plex', state);
    if (!saved) throw badRequest('Sign-in expired, please try again');
    if (saved.linkUserId !== undefined && saved.linkUserId !== req.user?.id) throw badRequest('Sign-in expired, please try again');
    const h = plexHeaders(app);
    const token = await plextv.checkPin(h, saved.pinId);
    if (!token) return { done: false };
    takeAuthState(app, 'plex', state);

    const s = app.ctx.settings.get('auth').plex;
    const account = await plextv.getAccount(h, token);
    // A Plex login only grants access when that Plex account can see the configured server.
    let hasServerAccess = false;
    if (s.serverMachineId) {
      const resources = await plextv.getResources(h, token);
      hasServerAccess = resources.some((r) => r.clientIdentifier === s.serverMachineId);
    }
    if (saved.linkUserId === undefined && !hasServerAccess) {
      audit(app.ctx.db, req, 'auth.sso_denied', { user: null, target: account.username, details: { provider: 'plex', reason: 'no_server_access' } });
      return { done: true, ok: false, error: 'This Plex account does not have access to the configured Plex server.' };
    }
    const result = resolveExternalUser(
      app,
      { provider: 'plex', externalId: String(account.id), username: account.username, displayName: account.title, email: account.email },
      { autoCreate: s.autoCreateUsers, role: null, defaultRole: s.defaultRole, linkUserId: saved.linkUserId },
    );
    if (!result.ok) {
      audit(app.ctx.db, req, 'auth.sso_denied', { user: null, target: account.username, details: { provider: 'plex', reason: result.reason } });
      const messages: Record<string, string> = {
        no_account: 'No account is linked to this Plex user. Ask an admin to invite you.',
        account_disabled: 'This account is disabled.',
        already_linked: 'That Plex account is already linked to another user.',
      };
      return { done: true, ok: false, error: messages[result.reason] ?? 'Sign-in failed' };
    }
    if (saved.linkUserId !== undefined) {
      audit(app.ctx.db, req, 'auth.sso_linked', { details: { provider: 'plex' } });
      return { done: true, ok: true };
    }
    if (!s.enabled) return { done: true, ok: false, error: 'Plex sign-in is turned off' };
    createSession(app.ctx.db, req, reply, result.userId, app.ctx.settings.get('auth').sessionDays);
    audit(app.ctx.db, req, 'auth.login', { user: { id: result.userId, username: result.username }, details: { method: 'plex' } });
    return { done: true, ok: true };
  });

  app.delete('/api/auth/links/:provider', { config: { access: 'user' } }, async (req) => {
    const { provider } = parse(z.object({ provider: z.enum(['oidc', 'plex']) }), req.params);
    if (!req.user!.hasPassword) throw badRequest('Set a password before unlinking, or you could lose access to your account');
    app.ctx.db.update(users).set(provider === 'oidc' ? { oidcSubject: null } : { plexId: null }).where(eq(users.id, req.user!.id)).run();
    audit(app.ctx.db, req, 'auth.sso_unlinked', { details: { provider } });
    return { ok: true };
  });
}
