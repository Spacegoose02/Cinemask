import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { parse } from '../lib/validate.js';
import { SECTION_NAMES } from './definitions.js';

const sectionParam = z.object({ section: z.enum(SECTION_NAMES as [string, ...string[]]) });

export async function settingsRoutes(app: FastifyInstance, opts: { onChange?: (section: string) => void } = {}) {
  app.get('/api/settings', { config: { access: 'admin' } }, async () =>
    Object.fromEntries(SECTION_NAMES.map((s) => [s, app.ctx.settings.getPublic(s)])),
  );

  app.get('/api/settings/:section', { config: { access: 'admin' } }, async (req) => {
    const { section } = parse(sectionParam, req.params);
    return app.ctx.settings.getPublic(section as (typeof SECTION_NAMES)[number]);
  });

  app.put('/api/settings/:section', { config: { access: 'admin' } }, async (req) => {
    const { section } = parse(sectionParam, req.params);
    const patch = parse(z.record(z.string(), z.unknown()), req.body);
    const name = section as (typeof SECTION_NAMES)[number];
    // The store re-validates the merged result against the section schema (ZodError becomes a 400).
    app.ctx.settings.update(name, patch);
    audit(app.ctx.db, req, 'settings.updated', { target: section, details: { fields: Object.keys(patch) } });
    opts.onChange?.(section);
    return app.ctx.settings.getPublic(name);
  });
}
