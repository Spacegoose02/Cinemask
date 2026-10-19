import type { FastifyInstance, FastifyReply } from 'fastify';
import * as client from 'openid-client';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import type { Role } from '../db/schema.js';
import type { SectionValue } from '../settings/definitions.js';
import { putAuthState, resolveExternalUser, takeAuthState } from './external.js';
import { timingSafeEqualStrings } from '../security/crypto.js';
import { createSession } from './sessions.js';

type OidcSettings = SectionValue<'auth'>['oidc'];

interface OidcState {
  codeVerifier: string;
  nonce: string;
  linkUserId?: number;
}

// Ties the SSO round trip to the browser that started it, so a callback link can't be replayed in someone else's browser.
const STATE_COOKIE = 'mm_oidc_state';

let cached: { key: string; config: client.Configuration; at: number } | undefined;

async function getConfig(s: OidcSettings): Promise<client.Configuration> {
  const key = `${s.issuer}|${s.clientId}|${s.clientSecret}`;
  if (cached && cached.key === key && Date.now() - cached.at < 10 * 60 * 1000) return cached.config;
  const issuer = new URL(s.issuer);
  const config = await client.discovery(
    issuer,
    s.clientId,
    s.clientSecret || undefined,
    undefined,
    // Self-hosted providers like tinyauth are often reached over plain HTTP on the LAN.
    issuer.protocol === 'http:' ? { execute: [client.allowInsecureRequests] } : undefined,
  );
  cached = { key, config, at: Date.now() };
  return config;
}

/** Maps IdP groups to a role. Returns undefined when the user isn't in any allowed group. */
export function roleFromGroups(s: OidcSettings, groups: string[]): Role | null | undefined {
  const has = (list: string[]) => list.some((g) => groups.includes(g));
  if (has(s.adminGroups)) return 'admin';
  if (has(s.managerGroups)) return 'manager';
  const mappingConfigured = s.adminGroups.length > 0 || s.managerGroups.length > 0;
  if (s.userGroups.length > 0) return has(s.userGroups) ? (mappingConfigured ? 'user' : null) : undefined;
  return mappingConfigured ? 'user' : null; // null = leave existing role alone
}

function claimGroups(claims: Record<string, unknown>, claim: string): string[] {
  const v = claims[claim];
  if (Array.isArray(v)) return v.filter((g): g is string => typeof g === 'string');
  if (typeof v === 'string') return v.split(',').map((g) => g.trim()).filter(Boolean);
  return [];
}

export async function oidcRoutes(app: FastifyInstance) {
  const fail = (reply: FastifyReply, reason: string) => reply.redirect(`/login?error=${encodeURIComponent(reason)}`);

  const redirectUri = () => {
    const base = app.ctx.settings.get('general').baseUrl;
    return base ? new URL('/api/auth/oidc/callback', base).toString() : null;
  };

  app.get('/api/auth/oidc/start', { config: { access: 'public', rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const s = app.ctx.settings.get('auth').oidc;
    const callback = redirectUri();
    if (!s.enabled || !s.issuer || !s.clientId) return fail(reply, 'sso_disabled');
    if (!callback) return fail(reply, 'base_url_missing');
    const { link } = z.object({ link: z.literal('1').optional() }).parse(req.query);
    if (link && !req.user) return fail(reply, 'not_signed_in');

    let config: client.Configuration;
    try {
      config = await getConfig(s);
    } catch (err) {
      req.log.warn({ err }, 'OIDC discovery failed');
      return fail(reply, 'sso_unreachable');
    }
    const codeVerifier = client.randomPKCECodeVerifier();
    const nonce = client.randomNonce();
    const state = putAuthState(app, 'oidc', { codeVerifier, nonce, linkUserId: link ? req.user!.id : undefined } satisfies OidcState);
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: callback,
      scope: s.scopes,
      state,
      nonce,
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
    });
    reply.setCookie(STATE_COOKIE, state, { path: '/api/auth/oidc', httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 600 });
    return reply.redirect(url.toString());
  });

  app.get('/api/auth/oidc/callback', { config: { access: 'public', rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = app.ctx.settings.get('auth');
    const s = auth.oidc;
    const callback = redirectUri();
    if (!s.enabled || !callback) return fail(reply, 'sso_disabled');
    const q = z.object({ state: z.string().max(200) }).safeParse(req.query);
    const cookieState = req.cookies[STATE_COOKIE];
    reply.clearCookie(STATE_COOKIE, { path: '/api/auth/oidc' });
    if (!q.success || !cookieState || !timingSafeEqualStrings(cookieState, q.data.state)) return fail(reply, 'sso_state');
    const saved = takeAuthState<OidcState>(app, 'oidc', q.data.state);
    if (!saved) return fail(reply, 'sso_state');
    // Linking must finish in the same signed-in account that started it.
    if (saved.linkUserId !== undefined && saved.linkUserId !== req.user?.id) return fail(reply, 'sso_state');

    let claims: Record<string, unknown>;
    try {
      const config = await getConfig(s);
      const current = new URL(req.url, callback);
      const tokens = await client.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: saved.codeVerifier,
        expectedNonce: saved.nonce,
        expectedState: q.data.state,
        idTokenExpected: true,
      });
      claims = { ...(tokens.claims() ?? {}) };
      if (!claimGroups(claims, s.groupsClaim).length && typeof claims.sub === 'string') {
        try {
          Object.assign(claims, await client.fetchUserInfo(config, tokens.access_token, claims.sub));
        } catch {
          // userinfo is optional
        }
      }
    } catch (err) {
      req.log.warn({ err }, 'OIDC callback failed');
      audit(app.ctx.db, req, 'auth.sso_failed', { user: null, details: { provider: 'oidc' } });
      return fail(reply, 'sso_failed');
    }

    const sub = String(claims.sub ?? '');
    if (!sub) return fail(reply, 'sso_failed');
    const role = roleFromGroups(s, claimGroups(claims, s.groupsClaim));
    if (role === undefined && saved.linkUserId === undefined) {
      audit(app.ctx.db, req, 'auth.sso_denied', { user: null, target: sub, details: { provider: 'oidc', reason: 'group' } });
      return fail(reply, 'sso_not_allowed');
    }
    const result = resolveExternalUser(
      app,
      {
        provider: 'oidc',
        externalId: `${s.issuer}#${sub}`,
        username: String(claims.preferred_username ?? claims.email ?? sub).split('@')[0]!,
        displayName: typeof claims.name === 'string' ? claims.name : null,
        email: claims.email_verified === true && typeof claims.email === 'string' ? claims.email : null,
      },
      { autoCreate: s.autoCreateUsers, role: role ?? null, defaultRole: s.defaultRole, linkUserId: saved.linkUserId },
    );
    if (!result.ok) {
      audit(app.ctx.db, req, 'auth.sso_denied', { user: null, target: sub, details: { provider: 'oidc', reason: result.reason } });
      return fail(reply, `sso_${result.reason}`);
    }
    if (saved.linkUserId !== undefined) {
      audit(app.ctx.db, req, 'auth.sso_linked', { details: { provider: 'oidc' } });
      return reply.redirect('/account?linked=oidc');
    }
    createSession(app.ctx.db, req, reply, result.userId, auth.sessionDays);
    audit(app.ctx.db, req, 'auth.login', { user: { id: result.userId, username: result.username }, details: { method: 'oidc' } });
    return reply.redirect('/');
  });
}
