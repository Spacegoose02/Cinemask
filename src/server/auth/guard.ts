import type { FastifyInstance } from 'fastify';
import type { Role } from '../db/schema.js';
import { forbidden, HttpError, unauthorized } from '../lib/errors.js';
import { timingSafeEqualStrings } from '../security/crypto.js';
import { loadSession, SESSION_COOKIE } from './sessions.js';

/** Who may call a route. Every /api route must declare one; there is no default. */
export type Access = 'public' | Role | 'owner';

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: Access;
  }
  interface FastifyInstance {
    /** Every API route and its access level, for tests and audits. */
    apiRoutes: { method: string; url: string; access: Access }[];
  }
}

const RANK: Record<Role, number> = { user: 1, manager: 2, admin: 3 };
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-csrf-token';
export const REQUESTED_WITH_HEADER = 'x-requested-with';

export function hasRole(role: Role, needed: Role): boolean {
  return RANK[role] >= RANK[needed];
}

export function registerGuard(app: FastifyInstance): void {
  app.decorateRequest('user', null);
  app.decorateRequest('session', null);

  // Fail at startup if anyone adds an API route without saying who may call it.
  app.decorate('apiRoutes', []);
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api')) return;
    if (!route.config?.access) throw new Error(`Route ${route.method} ${route.url} has no access level`);
    for (const method of [route.method].flat()) {
      if (method !== 'HEAD') app.apiRoutes.push({ method, url: route.url, access: route.config.access });
    }
  });

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api')) return;
    const access = req.routeOptions.config?.access;
    // Unknown /api URLs fall through to the 404 handler, which has no access config.
    if (!access && req.routeOptions.url !== undefined) throw new HttpError(500, 'Route misconfigured');

    const sessionDays = app.ctx.settings.get('auth').sessionDays;
    const loaded = loadSession(app.ctx.db, req.cookies[SESSION_COOKIE], sessionDays);
    if (loaded) {
      req.user = loaded.user;
      req.session = loaded.session;
    }

    if (!SAFE_METHODS.has(req.method)) {
      // Custom header forces a CORS preflight, which this server never approves, so other sites can't send it.
      if (req.headers[REQUESTED_WITH_HEADER] !== 'fetch') throw forbidden('Missing request header');
      if (req.session) {
        const token = req.headers[CSRF_HEADER];
        if (typeof token !== 'string' || !timingSafeEqualStrings(token, req.session.csrfToken)) {
          throw forbidden('Invalid CSRF token');
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
