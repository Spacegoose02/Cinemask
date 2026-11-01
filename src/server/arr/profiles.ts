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
  /** Custom format id → score. */
  formatScores: Record<string, number>;
  minFormatScore: number;
  /** Upgrades continue past the cutoff quality until a file's format score reaches this (0: off). */
  upgradeUntilFormatScore: number;
}

export function seedProfiles(ctx: AppContext) {
  if (ctx.db.select({ n: count() }).from(qualityProfiles).get()!.n > 0) return;
  for (const p of DEFAULT_PROFILES) {
    ctx.db.insert(qualityProfiles).values({ name: p.name, qualities: JSON.stringify(p.qualities), cutoff: p.cutoff, language: 'en', createdAt: Date.now() }).run();
  }
}

function toProfile(r: typeof qualityProfiles.$inferSelect): Profile {
  return {
    id: r.id,
    name: r.name,
    qualities: JSON.parse(r.qualities) as QualityId[],
    cutoff: r.cutoff as QualityId,
    upgradesAllowed: r.upgradesAllowed,
    language: r.language,
    formatScores: JSON.parse(r.formatScores) as Record<string, number>,
    minFormatScore: r.minFormatScore,
    upgradeUntilFormatScore: r.upgradeUntilFormatScore,
  };
}

export function listProfiles(ctx: AppContext): Profile[] {
  return ctx.db.select().from(qualityProfiles).orderBy(asc(qualityProfiles.id)).all().map(toProfile);
}

export function getProfile(ctx: AppContext, id: number): Profile | null {
  const r = ctx.db.select().from(qualityProfiles).where(eq(qualityProfiles.id, id)).get();
  return r ? toProfile(r) : null;
}

/** The profile as searches use it: upgrades also need the global switch (Settings → Media management). */
export function searchProfile(ctx: AppContext, id: number): Profile | null {
  const p = getProfile(ctx, id);
  return p && { ...p, upgradesAllowed: p.upgradesAllowed && ctx.settings.get('downloading').upgrades };
}

/**
 * Would a file of this quality (and format score, when known) still be upgraded under the profile?
 * Files whose format score isn't known (imported before scores, or only on a media server) are only
 * upgraded for quality, so turning scores on doesn't re-download the whole library.
 */
export function belowCutoff(profile: Profile, current: string | null, formatScore: number | null = null): boolean {
  if (!current) return true;
  if (!profile.upgradesAllowed) return false;
  if (qualityRank(current) < qualityRank(profile.cutoff)) return true;
  return formatScore !== null && profile.upgradeUntilFormatScore > 0 && formatScore < profile.upgradeUntilFormatScore;
}

export function defaultProfileId(ctx: AppContext, kind: 'movie' | 'show'): number {
  const s = ctx.settings.get('downloading');
  const chosen = kind === 'movie' ? s.defaultMovieProfile : s.defaultShowProfile;
  if (chosen && getProfile(ctx, chosen)) return chosen;
  const all = listProfiles(ctx);
  return (all.find((p) => p.name === '1080p or above') ?? all[0])!.id;
}
