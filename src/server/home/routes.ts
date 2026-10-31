import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { users } from '../db/schema.js';
import { parse } from '../lib/validate.js';

export const homeRow = z.discriminatedUnion('type', [
  z.object({ type: z.literal('featured') }),
  // Optionally only movies or shows, or one Plex library ("Kids Movies").
  z.object({ type: z.literal('recent'), kind: z.enum(['movie', 'show']).optional(), library: z.string().trim().min(1).max(200).optional() }),
  z.object({ type: z.literal('upcoming') }),
  z.object({ type: z.literal('airing_next') }),
  z.object({ type: z.literal('airing_recent') }),
  z.object({ type: z.literal('requests') }),
  z.object({ type: z.literal('trending'), kind: z.enum(['all', 'movie', 'tv']).default('all') }),
  z.object({ type: z.literal('popular'), kind: z.enum(['movie', 'tv']) }),
  z.object({ type: z.literal('list'), id: z.number().int().positive() }),
  z.object({ type: z.literal('collection'), id: z.number().int().positive() }),
  z.object({ type: z.literal('collections') }),
  z.object({ type: z.literal('family_favorites') }),
  z.object({ type: z.literal('because_you_liked') }),
  z.object({ type: z.literal('movie_nights') }),
]);
export type HomeRow = z.infer<typeof homeRow>;

export const DEFAULT_HOME: HomeRow[] = [
  { type: 'featured' },
  { type: 'recent', kind: 'movie' },
  { type: 'recent', kind: 'show' },
  { type: 'airing_next' },
  { type: 'airing_recent' },
  { type: 'upcoming' },
  { type: 'trending', kind: 'movie' },
  { type: 'trending', kind: 'tv' },
  { type: 'collections' },
  { type: 'movie_nights' },
  { type: 'family_favorites' },
  { type: 'because_you_liked' },
];

/** Each person picks and orders the rows on their own homepage. */
export async function homeRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const layoutOf = (userId: number): { rows: HomeRow[]; custom: boolean } => {
    const raw = ctx.db.select({ l: users.homeLayout }).from(users).where(eq(users.id, userId)).get()?.l;
    if (!raw) return { rows: DEFAULT_HOME, custom: false };
    const parsed = z.array(homeRow).safeParse(JSON.parse(raw));
    return parsed.success ? { rows: parsed.data, custom: true } : { rows: DEFAULT_HOME, custom: false };
  };

  app.get('/api/home/layout', { config: { access: 'user' } }, async (req) => layoutOf(req.user!.id));

  app.put('/api/home/layout', { config: { access: 'user' } }, async (req) => {
    const { rows } = parse(z.object({ rows: z.array(homeRow).max(20) }), req.body);
    ctx.db.update(users).set({ homeLayout: JSON.stringify(rows) }).where(eq(users.id, req.user!.id)).run();
    return layoutOf(req.user!.id);
  });

  app.delete('/api/home/layout', { config: { access: 'user' } }, async (req) => {
    ctx.db.update(users).set({ homeLayout: null }).where(eq(users.id, req.user!.id)).run();
    return layoutOf(req.user!.id);
  });
}
