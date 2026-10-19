import { asc, count, eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { qualityProfiles } from '../db/schema.js';
import { DEFAULT_PROFILES, qualityRank, type QualityId } from './quality.js';

export interface Profile {
  id: number;
  name: string;
  qualities: QualityId[];
  cutoff: QualityId;
  upgradesAllowed: boolean;
  language: string;
}

export function seedProfiles(ctx: AppContext) {
  if (ctx.db.select({ n: count() }).from(qualityProfiles).get()!.n > 0) return;
  for (const p of DEFAULT_PROFILES) {
    ctx.db.insert(qualityProfiles).values({ name: p.name, qualities: JSON.stringify(p.qualities), cutoff: p.cutoff, createdAt: Date.now() }).run();
  }
}

function toProfile(r: typeof qualityProfiles.$inferSelect): Profile {
  return { id: r.id, name: r.name, qualities: JSON.parse(r.qualities) as QualityId[], cutoff: r.cutoff as QualityId, upgradesAllowed: r.upgradesAllowed, language: r.language };
}

export function listProfiles(ctx: AppContext): Profile[] {
  return ctx.db.select().from(qualityProfiles).orderBy(asc(qualityProfiles.id)).all().map(toProfile);
}

export function getProfile(ctx: AppContext, id: number): Profile | null {
  const r = ctx.db.select().from(qualityProfiles).where(eq(qualityProfiles.id, id)).get();
  return r ? toProfile(r) : null;
}

/** Would a file of this quality still be upgraded under the profile? */
export function belowCutoff(profile: Profile, current: string | null): boolean {
  if (!current) return true;
  return profile.upgradesAllowed && qualityRank(current) < qualityRank(profile.cutoff);
}

export function defaultProfileId(ctx: AppContext, kind: 'movie' | 'show'): number {
  const s = ctx.settings.get('downloading');
  const chosen = kind === 'movie' ? s.defaultMovieProfile : s.defaultShowProfile;
  if (chosen && getProfile(ctx, chosen)) return chosen;
  const all = listProfiles(ctx);
  return (all.find((p) => p.name === '1080p or above') ?? all[0])!.id;
}
