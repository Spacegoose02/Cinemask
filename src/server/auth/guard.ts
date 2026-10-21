import type { FastifyInstance } from 'fastify';
import type { Role } from '../db/schema.js';
import { forbidden, HttpError, unauthorized } from '../lib/errors.js';
import { timingSafeEqualStrings } from '../security/crypto.js';
import { apiKeyFrom, loadApiKey } from './apikeys.js';
import { loadSession, SESSION_COOKIE } from './sessions.js';

/** Who may call a route. Every /api route must declare one; there is no default. */
export type Access = 'public' | Role | 'owner';

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: Access;
    /**
     * Whether API keys may call this route. Defaults to yes for public, user and manager
     * routes, and no for admin and owner routes. Account routes under /api/auth never allow keys.
     */
    apiKey?: boolean;
  }
  interface FastifyInstance {
    /** Every API route and its access level, for tests and audits. */
    apiRoutes: { method: string; url: string; access: Access; apiKey: boolean }[];
  }
}

const RANK: Record<Role, number> = { user: 1, manager: 2, admin: 3 };
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-csrf-token';
export const REQUESTED_WITH_HEADER = 'x-requested-with';

export function hasRole(role: Role, needed: Role): boolean {
  return RANK[role] >= RANK[needed];
}

/** API keys can't manage accounts, sessions or other keys, and only reach admin routes that opt in. */
export function apiKeyAllowed(url: string, config: { access?: Access; apiKey?: boolean }): boolean {
  if (url.startsWith('/api/auth/') && url !== '/api/auth/me' && url !== '/api/auth/status') return false;
  if (config.apiKey !== undefined) return config.apiKey;
  return config.access !== 'admin' && config.access !== 'owner';
}

export function registerGuard(app: FastifyInstance): void {
  app.decorateRequest('user', null);
  app.decorateRequest('session', null);
  app.decorateRequest('apiKey', null);

  // Fail at startup if anyone adds an API route without saying who may call it.
  app.decorate('apiRoutes', []);
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api')) return;
    if (!route.config?.access) throw new Error(`Route ${route.method} ${route.url} has no access level`);
    for (const method of [route.method].flat()) {
      if (method !== 'HEAD') app.apiRoutes.push({ method, url: route.url, access: route.config.access, apiKey: apiKeyAllowed(route.url, route.config) });
    }
  });

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api')) return;
    const access = req.routeOptions.config?.access;
    // Unknown /api URLs fall through to the 404 handler, which has no access config.
    if (!access && req.routeOptions.url !== undefined) throw new HttpError(500, 'Route misconfigured');

    const key = apiKeyFrom(req.headers);
    if (key) {
      // A key replaces the cookie entirely, so a browser session can never be mixed in.
      if (!app.ctx.settings.get('auth').apiKeysEnabled) throw unauthorized('API keys are turned off');
      const found = loadApiKey(app.ctx.db, app.ctx.secretKey, key);
      if (!found) throw unauthorized('Invalid API key');
      if (!access || !apiKeyAllowed(req.routeOptions.url ?? '', req.routeOptions.config)) throw forbidden('API keys cannot use this endpoint');
      if (found.apiKey.access === 'read' && !SAFE_METHODS.has(req.method)) throw forbidden('This API key is read-only');
      req.user = found.user;
      req.apiKey = found.apiKey;
    } else {
      const sessionDays = app.ctx.settings.get('auth').sessionDays;
      const loaded = loadSession(app.ctx.db, req.cookies[SESSION_COOKIE], sessionDays);
      if (loaded) {
        req.user = loaded.user;
        req.session = loaded.session;
      }
    }

    // API keys aren't sent automatically by browsers, so they need no CSRF protection.
    if (!SAFE_METHODS.has(req.method) && !req.apiKey) {
      // Custom header forces a CORS preflight, which this server never approves, so other sites can't send it.
      if (req.headers[REQUESTED_WITH_HEADER] !== 'fetch') throw forbidden('Missing request header');
      if (req.session) {
        const token = req.headers[CSRF_HEADER];
        if (typeof token !== 'string' || !timingSafeEqualStrings(token, req.session.csrfToken)) {
          throw new HttpError(403, 'Invalid CSRF token', 'csrf');
        }
      }
    }

    if (!access || access === 'public') return;
    if (!req.user) throw unauthorized();
    if (access === 'owner') {
      if (!req.user.isOwner) throw forbidden();
    } else if (!hasRole(req.user.role, access)) {
      throw forbidden();
    }
  });
}
