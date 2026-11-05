import { and, eq, inArray, lte } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { media, users, type MediaKind } from '../db/schema.js';
import { forbidden } from '../lib/errors.js';
import type { TmdbMovie, TmdbShow } from '../integrations/tmdb.js';

/**
 * Kids profiles: a user with a maximum age only sees and requests titles rated for that age or
 * younger. Ratings come from TMDB in the metadata region first, then the US, then anywhere.
 * Titles with no rating at all are hidden too, since nobody has said they're suitable.
 */

/** Ages of the ratings that aren't just a number. Numbers ("12", "FSK 16", "K-15", "15+") are read as they are. */
const NAMED: Record<string, number> = {
  // US film and TV
  G: 0, PG: 8, 'PG-13': 13, R: 17, 'NC-17': 18, NR: -1, 'TV-Y': 0, 'TV-Y7': 7, 'TV-Y7-FV': 7, 'TV-G': 0, 'TV-PG': 8, 'TV-14': 14, 'TV-MA': 17,
  // UK
  U: 0, UC: 0, '12A': 12, R18: 18, CAACCEPTED: 0,
  // Australia and New Zealand
  E: 0, M: 15, MA15: 15, 'MA15+': 15, 'R18+': 18, X18: 18, 'X18+': 18, P: 0, C: 0, RP13: 13, RP16: 16, RP18: 18,
  // Canada, France, Netherlands and others that use letters
  A: 18, AL: 0, TP: 0, ALL: 0, L: 0, 'L.': 0, BTL: 0, KT: 0, 'K-7': 7, 'K-12': 12, 'K-16': 16, 'K-18': 18,
};

/** The age a rating is for, or null when it isn't a rating Cinemask knows. */
export function ageOf(certification: string | null | undefined): number | null {
  if (!certification) return null;
  const c = certification.trim().toUpperCase();
  if (c in NAMED) return NAMED[c]! < 0 ? null : NAMED[c]!;
  const n = /(\d{1,2})/.exec(c);
  return n ? Math.min(18, Number(n[1])) : null;
}

function pick<T extends { iso_3166_1: string }>(list: T[], value: (x: T) => string | undefined, region: string): string {
  for (const r of [region, 'US', 'GB']) {
    const hit = list.filter((x) => x.iso_3166_1 === r).map(value).find((v) => v && ageOf(v) !== null);
    if (hit) return hit;
  }
  return list.map(value).find((v) => v && ageOf(v) !== null) ?? '';
}

/** The rating to store for a title ('' when TMDB has none). */
export function certificationOf(kind: MediaKind, t: TmdbMovie | TmdbShow, region: string): string {
  if (kind === 'movie') {
    const all = ((t as TmdbMovie).release_dates?.results ?? []).flatMap((r) => r.release_dates.map((d) => ({ iso_3166_1: r.iso_3166_1, certification: d.certification })));
    return pick(all, (x) => x.certification, region);
  }
  return pick((t as TmdbShow).content_ratings?.results ?? [], (x) => x.rating, region);
}

/** The user's age limit, or null for no limit. Managers and admins never have one. */
export function maxAgeOf(ctx: AppContext, userId: number): number | null {
  const u = ctx.db.select({ maxAge: users.maxAge, role: users.role }).from(users).where(eq(users.id, userId)).get();
  if (!u || u.role !== 'user') return null;
  return u.maxAge ?? null;
}

type Ref = { kind: MediaKind; tmdbId: number | null };
const key = (kind: string, id: number) => `${kind}:${id}`;

/**
 * The titles among `items` a user with this age limit may see. Titles never looked up are fetched
 * once (TMDB answers are cached), a few at a time.
 */
export async function allowedKeys(ctx: AppContext, maxAge: number, items: Ref[]): Promise<Set<string>> {
  const refs = items.filter((i): i is { kind: MediaKind; tmdbId: number } => i.tmdbId !== null);
  const out = new Set<string>();
  if (!refs.length) return out;
  const rows = new Map<string, { certification: string | null; minAge: number | null }>();
  for (const kind of ['movie', 'show'] as const) {
    const ids = [...new Set(refs.filter((r) => r.kind === kind).map((r) => r.tmdbId))];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      for (const r of ctx.db.select({ kind: media.kind, tmdbId: media.tmdbId, certification: media.certification, minAge: media.minAge }).from(media).where(and(eq(media.kind, kind), inArray(media.tmdbId, chunk))).all()) rows.set(key(r.kind, r.tmdbId), r);
    }
  }
  const unknown = [...new Map(refs.filter((r) => (rows.get(key(r.kind, r.tmdbId))?.certification ?? null) === null).map((r) => [key(r.kind, r.tmdbId), r])).values()].slice(0, 60);
  if (unknown.length) {
    const { refreshMetadata } = await import('../library/service.js');
    for (let i = 0; i < unknown.length; i += 8) {
      await Promise.all(
        unknown.slice(i, i + 8).map(async (r) => {
          const row = await refreshMetadata(ctx, r.kind, r.tmdbId, true).catch(() => null);
          if (row) rows.set(key(r.kind, r.tmdbId), row);
        }),
      );
    }
  }
  for (const r of refs) {
    const age = rows.get(key(r.kind, r.tmdbId))?.minAge;
    if (age !== null && age !== undefined && age <= maxAge) out.add(key(r.kind, r.tmdbId));
  }
  return out;
}

/** Drops the titles a kids profile may not see. Items without a TMDB id are dropped too. */
export async function forViewer<T extends { kind: MediaKind; tmdbId: number | null }>(ctx: AppContext, userId: number, items: T[]): Promise<T[]> {
  const maxAge = maxAgeOf(ctx, userId);
  if (maxAge === null) return items;
  const ok = await allowedKeys(ctx, maxAge, items);
  return items.filter((i) => i.tmdbId !== null && ok.has(key(i.kind, i.tmdbId)));
}

/** Throws 403 when a kids profile asks for a title above its age limit. */
export async function assertSuitable(ctx: AppContext, userId: number, kind: MediaKind, tmdbId: number): Promise<void> {
  const maxAge = maxAgeOf(ctx, userId);
  if (maxAge === null) return;
  const ok = await allowedKeys(ctx, maxAge, [{ kind, tmdbId }]);
  if (!ok.has(key(kind, tmdbId))) throw forbidden("This title isn't available on your profile");
}

/** SQL condition for library queries: only titles rated for the age. */
export const suitableSql = (maxAge: number) => lte(media.minAge, maxAge);
