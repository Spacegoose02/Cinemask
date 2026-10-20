import { asc, eq, isNull, lt, or } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { monitored } from '../db/schema.js';
import { decide, type Decision } from './decision.js';
import { CATEGORIES, searchIndexer } from './indexers.js';
import { wantedTarget } from './monitor.js';
import { normalizeTitle, parseRelease } from './parser.js';
import { getProfile } from './profiles.js';
import { autoSearch, decideOptions, enabledIndexers, grabBest } from './search.js';
import { blocklist } from '../db/schema.js';

/**
 * Checks each indexer's latest releases and grabs anything that matches a monitored title.
 * Cheap: one request per indexer, no per-title searching.
 */
export async function rssSync(ctx: AppContext): Promise<{ checked: number; grabbed: number }> {
  const rows = ctx.db.select().from(monitored).where(eq(monitored.monitored, true)).all();
  if (!rows.length) return { checked: 0, grabbed: 0 };
  const byTitle = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = normalizeTitle(r.title);
    byTitle.set(k, [...(byTitle.get(k) ?? []), r]);
  }
  let checked = 0;
  let grabbed = 0;
  const perTitle = new Map<number, Decision[]>();
  for (const idx of enabledIndexers(ctx)) {
    let releases;
    try {
      releases = await searchIndexer(idx, { type: 'search', categories: [...CATEGORIES.movies, ...CATEGORIES.tv], limit: 100 });
    } catch {
      continue;
    }
    for (const rel of releases) {
      checked++;
      const parsed = parseRelease(rel.title);
      const candidates = byTitle.get(normalizeTitle(parsed.title)) ?? byTitle.get(normalizeTitle(parsed.title.replace(/ (19|20)\d{2}$/, ''))) ?? [];
      for (const row of candidates) {
        const target = wantedTarget(ctx, row);
        const profile = getProfile(ctx, row.profileId);
        if (!target || !profile) continue;
        const bl = new Set(ctx.db.select({ t: blocklist.releaseTitle }).from(blocklist).where(eq(blocklist.monitoredId, row.id)).all().map((b) => b.t));
        const d = decide(rel, target, profile, bl, decideOptions(ctx, row));
        if (d.accepted) perTitle.set(row.id, [...(perTitle.get(row.id) ?? []), d]);
      }
    }
  }
  for (const [id, decisions] of perTitle) {
    const row = rows.find((r) => r.id === id)!;
    grabbed += await grabBest(ctx, row, decisions).catch(() => 0);
  }
  return { checked, grabbed };
}

/** Periodic full search for missing items, oldest-searched first, a few at a time to be kind to indexers. */
export async function searchMissing(ctx: AppContext, hours: number, batch = 10): Promise<number> {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const rows = ctx.db
    .select()
    .from(monitored)
    .where(or(isNull(monitored.lastSearchAt), lt(monitored.lastSearchAt, cutoff)))
    .orderBy(asc(monitored.lastSearchAt))
    .limit(batch * 3)
    .all()
    .filter((r) => r.monitored && wantedTarget(ctx, r))
    .slice(0, batch);
  let grabbed = 0;
  for (const r of rows) grabbed += await autoSearch(ctx, r).catch(() => 0);
  return grabbed;
}
