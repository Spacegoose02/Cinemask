import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { calendar } from './service.js';
import { airing } from '../arr/overview.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const DAY = 24 * 60 * 60 * 1000;

export async function calendarRoutes(app: FastifyInstance) {
  /** Each followed show's next episode and its latest one, for "Airing next" and "Recently aired". */
  app.get('/api/airing', { config: { access: 'user' } }, async (req) => {
    const q = parse(z.object({ days: z.coerce.number().int().min(1).max(30).default(7) }), req.query);
    return airing(app.ctx, q.days);
  });

  app.get('/api/calendar', { config: { access: 'user' } }, async (req) => {
    const q = parse(z.object({ start: date, end: date }), req.query);
    const span = (Date.parse(q.end) - Date.parse(q.start)) / DAY;
    if (!(span >= 0)) throw badRequest('end must be on or after start');
    if (span > 100) throw badRequest('Pick a range of 100 days or less');
    return calendar(app.ctx, q.start, q.end);
  });
}
