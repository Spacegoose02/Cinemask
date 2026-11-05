import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { hasRole } from '../auth/guard.js';
import { ISSUE_TYPES, issues, MEDIA_KINDS } from '../db/schema.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { refreshMetadata } from '../library/service.js';
import { notify } from '../notify/service.js';
import { FIXES, fixIssue, ISSUE_LABELS, issueFixed, issueName, openIssuesFor, type Issue } from './service.js';
import { IntegrationError } from '../integrations/http.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const nameOf = (u: { displayName: string | null; username: string }) => u.displayName || u.username;

/** "Report a problem": anyone reports, managers fix (or Cinemask does, when automatic fixes are on). */
export async function issueRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const get = (id: number): Issue => {
    const i = ctx.db.select().from(issues).where(eq(issues.id, id)).get();
    if (!i) throw notFound('Report not found');
    return i;
  };
  const view = (i: Issue) => ({ ...i, label: ISSUE_LABELS[i.type], fixes: FIXES[i.type] });

  app.get('/api/issues', { config: { access: 'user' } }, async (req) => {
    const q = parse(z.object({ status: z.enum(['open', 'resolved', 'all']).default('open') }), req.query);
    const mine = !hasRole(req.user!.role, 'manager');
    const status = q.status === 'open' ? inArray(issues.status, ['open', 'fixing']) : q.status === 'resolved' ? eq(issues.status, 'resolved') : undefined;
    return ctx.db
      .select()
      .from(issues)
      .where(and(status, mine ? eq(issues.reportedBy, req.user!.id) : undefined))
      .orderBy(desc(issues.updatedAt))
      .limit(300)
      .all()
      .map(view);
  });

  app.get('/api/issues/count', { config: { access: 'manager' } }, async () => ({ open: ctx.db.select().from(issues).where(eq(issues.status, 'open')).all().length }));

  /** Open reports on a title, so people can see it's already been reported. */
  app.get('/api/issues/title/:kind/:tmdbId', { config: { access: 'user' } }, async (req) => {
    const p = parse(z.object({ kind: z.enum(MEDIA_KINDS), tmdbId: z.coerce.number().int().positive() }), req.params);
    return openIssuesFor(ctx, p.kind, p.tmdbId).map((i) => ({ id: i.id, type: i.type, label: ISSUE_LABELS[i.type], season: i.season, episode: i.episode, status: i.status, mine: i.reportedBy === req.user!.id }));
  });

  app.post('/api/issues', { config: { access: 'user', rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const b = parse(
      z.object({
        kind: z.enum(MEDIA_KINDS),
        tmdbId: z.number().int().positive(),
        type: z.enum(ISSUE_TYPES),
        season: z.number().int().min(0).max(500).nullable().optional(),
        episode: z.number().int().min(0).max(5000).nullable().optional(),
        message: z.string().trim().max(1000).optional(),
      }),
      req.body,
    );
    if (b.kind === 'movie' && (b.season != null || b.episode != null)) throw badRequest('Movies have no seasons');
    if (b.episode != null && b.season == null) throw badRequest('Pick the season too');
    if (b.type === 'other' && !b.message) throw badRequest('Say what the problem is');
    const meta = await refreshMetadata(ctx, b.kind, b.tmdbId);
    if (!meta) throw notFound('That title could not be found');
    // The same problem reported again joins the open report instead of making another.
    const dupe = openIssuesFor(ctx, b.kind, b.tmdbId).find((i) => i.type === b.type && i.season === (b.season ?? null) && i.episode === (b.episode ?? null));
    if (dupe) return { ...view(dupe), duplicate: true };
    const now = Date.now();
    const row = ctx.db
      .insert(issues)
      .values({
        kind: b.kind,
        tmdbId: b.tmdbId,
        title: meta.title,
        year: meta.year,
        posterPath: meta.posterOverride ?? meta.posterPath,
        season: b.season ?? null,
        episode: b.episode ?? null,
        type: b.type,
        message: b.message || null,
        status: 'open',
        reportedBy: req.user!.id,
        reportedByName: nameOf(req.user!),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    audit(ctx.db, req, 'issue.created', { target: issueName(row), details: { type: row.type } });
    notify(ctx, {
      event: 'issue.created',
      title: 'Problem reported',
      message: `${row.reportedByName} reported ${issueName(row)}: ${ISSUE_LABELS[row.type]}${row.message ? `. "${row.message}"` : ''}`,
      data: { kind: row.kind, tmdbId: row.tmdbId, issueId: row.id, type: row.type },
      url: '/issues',
    });
    // Automatic fixes: try the first fix right away; the report stays open if it doesn't work out.
    let autoFix: string | null = null;
    if (ctx.settings.get('issues').autoFix && FIXES[row.type].length) {
      autoFix = await fixIssue(ctx, row, FIXES[row.type][0]!, 'Cinemask')
        .then((r) => r.message)
        .catch(() => null);
    }
    return { ...view(get(row.id)), autoFix };
  });

  app.post('/api/issues/:id/fix', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { action } = parse(z.object({ action: z.enum(['replace', 'subtitles']) }), req.body);
    const i = get(id);
    if (i.status === 'resolved') throw conflict('This report is already fixed');
    if (!FIXES[i.type].includes(action)) throw badRequest("That fix doesn't apply to this kind of problem");
    try {
      const r = await fixIssue(ctx, i, action, nameOf(req.user!));
      audit(ctx.db, req, 'issue.fix', { target: issueName(i), details: { action, ok: r.ok } });
      return { ...r, issue: view(get(id)) };
    } catch (err) {
      if (err instanceof IntegrationError) throw new HttpError(502, err.message, 'upstream');
      throw err;
    }
  });

  app.post('/api/issues/:id/resolve', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { note } = parse(z.object({ note: z.string().trim().max(500).optional() }), req.body ?? {});
    const i = get(id);
    if (i.status === 'resolved') throw conflict('This report is already fixed');
    issueFixed(ctx, id, note || 'Marked as fixed.', nameOf(req.user!));
    audit(ctx.db, req, 'issue.resolved', { target: issueName(i) });
    return view(get(id));
  });

  /** The person who reported it (or a manager) can say it's still not right. */
  app.post('/api/issues/:id/reopen', { config: { access: 'user' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const i = get(id);
    if (i.reportedBy !== req.user!.id && !hasRole(req.user!.role, 'manager')) throw forbidden('You can only reopen your own reports');
    if (i.status !== 'resolved') throw conflict("This report isn't fixed yet");
    ctx.db.update(issues).set({ status: 'open', updatedAt: Date.now() }).where(eq(issues.id, id)).run();
    audit(ctx.db, req, 'issue.reopened', { target: issueName(i) });
    return view(get(id));
  });

  app.delete('/api/issues/:id', { config: { access: 'user' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const i = get(id);
    const own = i.reportedBy === req.user!.id && i.status === 'open';
    if (!own && !hasRole(req.user!.role, 'manager')) throw forbidden('You can only withdraw your own open reports');
    ctx.db.delete(issues).where(eq(issues.id, id)).run();
    audit(ctx.db, req, 'issue.deleted', { target: issueName(i) });
    return { ok: true };
  });
}
