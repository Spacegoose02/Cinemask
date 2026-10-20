import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AudiobookshelfClient } from './audiobookshelf.js';
import { ShelfmarkClient } from './shelfmark.js';
import { audit } from '../audit/log.js';
import { plexHeaders } from '../auth/plex.js';
import { HttpError } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { mdblistClient, tmdbClient } from '../library/service.js';
import { JellyfinClient } from './jellyfin.js';
import { PlexClient } from './plex.js';
import * as plextv from './plextv.js';

/** Connection tests for each integration, using the saved settings. Admin only. */
export async function integrationRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const run = async (fn: () => Promise<string>) => {
    try {
      return { ok: true, message: await fn() };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  };

  app.post('/api/integrations/:service/test', { config: { access: 'admin' } }, async (req) => {
    const { service } = parse(z.object({ service: z.enum(['plex', 'jellyfin', 'tmdb', 'mdblist', 'audiobookshelf', 'shelfmark']) }), req.params);
    const result = await run(async () => {
      switch (service) {
        case 'plex': {
          const s = ctx.settings.get('plex');
          if (!s.url || !s.token) throw new Error('Enter the Plex URL and token first');
          const info = await new PlexClient(s.url, s.token).test();
          // Remember the server id, and use it to gate Plex sign-in if that isn't set yet.
          ctx.settings.update('plex', { machineId: info.machineId, name: s.name || info.name });
          if (!ctx.settings.get('auth').plex.serverMachineId) ctx.settings.update('auth', { plex: { serverMachineId: info.machineId } });
          return `Connected to ${info.name} (Plex ${info.version})`;
        }
        case 'jellyfin': {
          const s = ctx.settings.get('jellyfin');
          if (!s.url || !s.apiKey) throw new Error('Enter the Jellyfin URL and API key first');
          const info = await new JellyfinClient(s.url, s.apiKey).test();
          ctx.settings.update('jellyfin', { name: s.name || info.name });
          return `Connected to ${info.name} (Jellyfin ${info.version})`;
        }
        case 'tmdb':
          await tmdbClient(ctx).test();
          return 'TMDB key works';
        case 'mdblist':
          await mdblistClient(ctx).test();
          return 'mdblist key works';
        case 'audiobookshelf': {
          const s = ctx.settings.get('audiobookshelf');
          if (!s.url || !s.apiKey) throw new Error('Enter the Audiobookshelf URL and API token first');
          return new AudiobookshelfClient(s.url, s.apiKey).test();
        }
        case 'shelfmark': {
          const s = ctx.settings.get('shelfmark');
          if (!s.url) throw new Error('Enter the Shelfmark URL first');
          return new ShelfmarkClient(s.url, s.username, s.password).test();
        }
      }
    });
    audit(ctx.db, req, 'integration.tested', { target: service, details: { ok: result.ok } });
    return result;
  });

  /** Lists Plex servers the given (or saved) Plex token can reach, to pick one without typing URLs. */
  app.post('/api/integrations/plex/servers', { config: { access: 'admin' } }, async (req) => {
    const { token } = parse(z.object({ token: z.string().max(500).optional() }), req.body ?? {});
    const useToken = token || ctx.settings.get('plex').token;
    if (!useToken) throw new HttpError(400, 'Enter a Plex token first');
    try {
      const resources = await plextv.getResources(plexHeaders(app), useToken);
      return resources
        .filter((r) => r.provides.split(',').includes('server'))
        .map((r) => ({ name: r.name, machineId: r.clientIdentifier, owned: r.owned, connections: r.connections.map((c) => ({ uri: c.uri, local: c.local, relay: c.relay })) }));
    } catch (err) {
      throw new HttpError(502, `Could not list Plex servers: ${(err as Error).message}`);
    }
  });
}
