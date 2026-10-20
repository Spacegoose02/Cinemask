import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tmdbClient } from '../library/service.js';
import { upstream } from '../library/routes.js';
import { parse } from '../lib/validate.js';
import { discover, discoverFilter, NETWORKS, providerKey, SORTS } from './service.js';

export async function discoverRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.get('/api/discover', { config: { access: 'user' } }, async (req) => {
    const q = parse(discoverFilter.extend({ page: z.coerce.number().int().min(1).max(500).default(1) }), req.query);
    return upstream(() => discover(ctx, q, q.page));
  });

  /** Everything the Discover filters offer: genres and streaming services come from TMDB. */
  app.get('/api/discover/options', { config: { access: 'user' } }, async (req) => {
    const { kind } = parse(z.object({ kind: z.enum(['movie', 'tv']).default('movie') }), req.query);
    const tmdb = tmdbClient(ctx);
    const [genres, providers] = tmdb.configured ? await upstream(() => Promise.all([tmdb.genres(kind), tmdb.watchProviders(kind)])) : [{ genres: [] }, { results: [] }];
    return {
      genres: genres.genres,
      providers: providers.results
        .sort((a, b) => a.display_priority - b.display_priority)
        .map((p) => ({ id: p.provider_id, name: p.provider_name, logoPath: p.logo_path })),
      networks: NETWORKS.filter((n) => kind === 'tv' || n.companies?.length).map((n) => ({ id: n.id, name: n.name })),
      /** Services whose own shows or films can be picked out with "Originals only". */
      originals: providers.results.filter((p) => NETWORKS.some((n) => n.provider?.test(providerKey(p.provider_name)))).map((p) => p.provider_id),
      sorts: Object.keys(SORTS),
      region: ctx.settings.get('metadata').region,
    };
  });
}
