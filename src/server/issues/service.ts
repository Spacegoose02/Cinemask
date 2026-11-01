import { and, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { blocklist, issues, monitored, monitoredEpisodes, type IssueType } from '../db/schema.js';
import { notify } from '../notify/service.js';
import { explainedSearch } from '../arr/search.js';
import { fetchSubtitles } from '../files/subtitles.js';

export type Issue = typeof issues.$inferSelect;

export const ISSUE_LABELS: Record<IssueType, string> = {
  audio: 'Wrong language or bad audio',
  subtitles: 'Missing or wrong subtitles',
  video: 'Poor picture quality',
  playback: "Won't play",
  wrong: "It's the wrong movie or episode",
  other: 'Something else',
};

/** What a manager (or the automatic fix) can do about each kind of problem. */
export const FIXES: Record<IssueType, ('replace' | 'subtitles')[]> = {
  audio: ['replace'],
  subtitles: ['subtitles', 'replace'],
  video: ['replace'],
  playback: ['replace'],
  wrong: ['replace'],
  other: [],
};

const scopeLabel = (i: Pick<Issue, 'season' | 'episode'>) =>
  i.season !== null ? (i.episode !== null ? ` S${String(i.season).padStart(2, '0')}E${String(i.episode).padStart(2, '0')}` : ` season ${i.season}`) : '';

export const issueName = (i: Issue) => `${i.title}${scopeLabel(i)}`;

/** Marks a report fixed and tells the person who made it. */
export function issueFixed(ctx: AppContext, id: number, resolution: string, by = 'Cinemask') {
  const i = ctx.db.select().from(issues).where(eq(issues.id, id)).get();
  if (!i || i.status === 'resolved') return;
  ctx.db.update(issues).set({ status: 'resolved', resolution, resolvedByName: by, updatedAt: Date.now() }).where(eq(issues.id, id)).run();
  notify(ctx, {
    event: 'issue.resolved',
    title: 'Problem fixed',
    message: `${issueName(i)}: ${resolution}`,
    data: { kind: i.kind, tmdbId: i.tmdbId, issueId: i.id },
    to: i.reportedBy ? [i.reportedBy] : [],
  });
  ctx.live.publish({ topic: 'issues', access: 'user' });
}

function monitoredFor(ctx: AppContext, i: Issue) {
  return ctx.db.select().from(monitored).where(and(eq(monitored.kind, i.kind), eq(monitored.tmdbId, i.tmdbId))).get() ?? null;
}

/** The release names of the files a report is about, so they can be blocklisted. */
function reportedReleases(ctx: AppContext, row: typeof monitored.$inferSelect, i: Issue): string[] {
  if (row.kind === 'movie') return row.fileRelease ? [row.fileRelease] : [];
  const eps = ctx.db
    .select()
    .from(monitoredEpisodes)
    .where(eq(monitoredEpisodes.monitoredId, row.id))
    .all()
    .filter((e) => (i.season === null || e.season === i.season) && (i.episode === null || e.episode === i.episode));
  return [...new Set(eps.map((e) => e.fileRelease).filter((r): r is string => Boolean(r)))];
}

export interface FixResult {
  ok: boolean;
  message: string;
}

/**
 * Tries to fix a report: "replace" blocklists the copy that's there and grabs a different one (the
 * report is marked fixed when it's imported); "subtitles" fetches subtitles for it.
 */
export async function fixIssue(ctx: AppContext, issue: Issue, action: 'replace' | 'subtitles', by: string): Promise<FixResult> {
  const row = monitoredFor(ctx, issue);
  if (!row) return { ok: false, message: `${issue.title} isn't managed by Cinemask yet. Monitor it first, then try again.` };
  if (row.kind === 'show' && issue.season === null) return { ok: false, message: 'Say which season or episode it is, so only that is replaced.' };
  const scope = { season: issue.season ?? undefined, episode: issue.episode ?? undefined };

  if (action === 'subtitles') {
    const r = await fetchSubtitles(ctx, row, scope, { force: true });
    if (!r.saved.length) return { ok: false, message: r.missing.length ? `No subtitles found for ${r.missing.join(', ')}.` : 'There are no files to add subtitles to.' };
    issueFixed(ctx, issue.id, `Added ${r.saved.length} subtitle file${r.saved.length === 1 ? '' : 's'}.`, by);
    return { ok: true, message: `Saved ${r.saved.length} subtitle file${r.saved.length === 1 ? '' : 's'}. The report is marked fixed.` };
  }

  const releases = reportedReleases(ctx, row, issue);
  for (const t of releases) {
    const already = ctx.db.select().from(blocklist).where(and(eq(blocklist.monitoredId, row.id), eq(blocklist.releaseTitle, t))).get();
    if (!already) ctx.db.insert(blocklist).values({ monitoredId: row.id, releaseTitle: t, reason: `Reported: ${ISSUE_LABELS[issue.type]}`, createdAt: Date.now() }).run();
  }
  const r = await explainedSearch(ctx, row, { ...scope, replace: true }, { replaceFile: true, issueId: issue.id });
  if (!r.grabbed) return { ok: false, message: `${releases.length ? 'Blocklisted the copy that was there. ' : ''}${r.message}` };
  ctx.db.update(issues).set({ status: 'fixing', resolution: 'Downloading a different copy', resolvedByName: by, updatedAt: Date.now() }).where(eq(issues.id, issue.id)).run();
  return { ok: true, message: `${releases.length ? 'Blocklisted the copy that was there and grabbed' : 'Grabbed'} a different one. The report is marked fixed once it's imported.` };
}

/** Open reports for a title, for its page. */
export function openIssuesFor(ctx: AppContext, kind: 'movie' | 'show', tmdbId: number) {
  return ctx.db
    .select()
    .from(issues)
    .where(and(eq(issues.kind, kind), eq(issues.tmdbId, tmdbId), inArray(issues.status, ['open', 'fixing'])))
    .all();
}
