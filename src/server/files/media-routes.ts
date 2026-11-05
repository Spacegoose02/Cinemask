import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { monitored, monitoredEpisodes } from '../db/schema.js';
import { HttpError, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { IntegrationError } from '../integrations/http.js';
import { infoOf, probeTitle } from './mediainfo.js';
import { fetchSubtitles } from './subtitles.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

/** What's really in a title's files (ffprobe), and subtitles for them. Managers only. */
export async function mediaFileRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const getRow = (id: number) => {
    const r = ctx.db.select().from(monitored).where(eq(monitored.id, id)).get();
    if (!r) throw notFound('Not monitored');
    return r;
  };

  app.get('/api/monitored/:id/details', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const row = getRow(id);
    if (row.kind === 'movie') return { files: row.filePath ? [{ path: row.filePath, release: row.fileRelease, formatScore: row.fileFormatScore, info: infoOf(row.fileInfo) }] : [] };
    const eps = ctx.db.select().from(monitoredEpisodes).where(eq(monitoredEpisodes.monitoredId, id)).orderBy(monitoredEpisodes.season, monitoredEpisodes.episode).all();
    const byPath = new Map<string, { path: string; release: string | null; formatScore: number | null; info: ReturnType<typeof infoOf>; season: number; episodes: number[] }>();
    for (const e of eps) {
      if (!e.filePath) continue;
      const f = byPath.get(e.filePath);
      if (f) f.episodes.push(e.episode);
      else byPath.set(e.filePath, { path: e.filePath, release: e.fileRelease, formatScore: e.fileFormatScore, info: infoOf(e.fileInfo), season: e.season, episodes: [e.episode] });
    }
    return { files: [...byPath.values()] };
  });

  /** Reads every file of the title again with ffprobe. */
  app.post('/api/monitored/:id/probe', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    getRow(id);
    return { probed: await probeTitle(ctx, id, { all: true }) };
  });

  app.post('/api/monitored/:id/subtitles', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(
      z.object({
        season: z.number().int().min(0).optional(),
        episode: z.number().int().min(0).optional(),
        language: z.string().regex(/^[a-z]{2}(-[a-z]{2})?$/).optional(),
        force: z.boolean().default(false),
      }),
      req.body ?? {},
    );
    const row = getRow(id);
    try {
      const r = await fetchSubtitles(ctx, row, b, { languages: b.language ? [b.language] : undefined, force: b.force });
      audit(ctx.db, req, 'subtitles.fetched', { target: row.title, details: { saved: r.saved.length, missing: r.missing.length } });
      if (r.saved.length) void probeTitle(ctx, id, { all: true }).catch(() => 0);
      return r;
    } catch (err) {
      if (err instanceof IntegrationError) throw new HttpError(502, err.message, 'upstream');
      throw err;
    }
  });
}

