import { and, eq, isNotNull } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { customFormats, qualityProfiles } from '../db/schema.js';
import { fetchJson, IntegrationError } from '../integrations/http.js';
import type { FormatRule } from './formats.js';
import { getProfile } from './profiles.js';
import { QUALITY_IDS, qualityRank, type QualityId } from './quality.js';

/**
 * TRaSH Guides sync (what Recyclarr and Notifiarr do for Sonarr and Radarr): the guides' quality
 * profiles, custom formats and scores, read from their JSON files on GitHub and turned into
 * Cinemask profiles and formats. A profile linked to a guide profile is synced again every week,
 * so improved release group lists and new formats arrive by themselves.
 */
export type TrashApp = 'radarr' | 'sonarr';
export const TRASH_APPS: TrashApp[] = ['radarr', 'sonarr'];

const REPO = 'TRaSH-Guides/Guides';
const TREE = `https://api.github.com/repos/${REPO}/git/trees/master?recursive=1`;
const RAW = `https://raw.githubusercontent.com/${REPO}/master/`;
const SERVICE = 'TRaSH Guides';

interface Spec {
  name: string;
  implementation: string;
  negate: boolean;
  required: boolean;
  fields: { value?: unknown; min?: number; max?: number } | { name: string; value: unknown }[];
}
export interface TrashFormat {
  trash_id: string;
  name: string;
  trash_scores?: Record<string, number>;
  specifications: Spec[];
}
interface TrashGroup {
  name: string;
  default?: boolean | string;
  custom_formats: { name: string; trash_id: string; required?: boolean; default?: boolean | string }[];
  quality_profiles?: { include?: Record<string, string>; exclude?: Record<string, string> };
}
export interface TrashProfile {
  trash_id: string;
  name: string;
  trash_description?: string;
  trash_score_set?: string;
  upgradeAllowed?: boolean;
  cutoff: string;
  minFormatScore?: number;
  cutoffFormatScore?: number;
  items: { name: string; allowed: boolean; items?: string[] }[];
  formatItems?: Record<string, string>;
}
export interface Guide {
  profiles: TrashProfile[];
  formats: Map<string, TrashFormat>;
  groups: TrashGroup[];
}

const cache = new Map<TrashApp, { at: number; guide: Guide }>();
const HOUR = 60 * 60 * 1000;

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!);
      }
    }),
  );
  return out;
}

/** Everything the guides publish for one app. Read once an hour at most. */
export async function loadGuide(app: TrashApp, fresh = false): Promise<Guide> {
  const hit = cache.get(app);
  if (hit && !fresh && Date.now() - hit.at < HOUR) return hit.guide;
  const tree = await fetchJson<{ tree: { path: string; type: string }[] }>(SERVICE, TREE, { headers: { 'User-Agent': 'Cinemask' } }, 30_000);
  const under = (dir: string) => tree.tree.filter((t) => t.type === 'blob' && t.path.startsWith(`docs/json/${app}/${dir}/`) && t.path.endsWith('.json')).map((t) => t.path);
  const read = <T>(path: string) => fetchJson<T>(SERVICE, RAW + path.split('/').map(encodeURIComponent).join('/'), {}, 30_000).catch(() => null);
  const [profiles, formats, groups] = await Promise.all([pool(under('quality-profiles'), 8, read<TrashProfile>), pool(under('cf'), 12, read<TrashFormat>), pool(under('cf-groups'), 8, read<TrashGroup>)]);
  const guide: Guide = {
    profiles: profiles.filter((p): p is TrashProfile => !!p?.trash_id && Array.isArray(p.items)).sort((a, b) => a.name.localeCompare(b.name)),
    formats: new Map(formats.filter((f): f is TrashFormat => !!f?.trash_id && Array.isArray(f.specifications)).map((f) => [f.trash_id, f])),
    groups: groups.filter((g): g is TrashGroup => !!g && Array.isArray(g.custom_formats)),
  };
  if (!guide.profiles.length) throw new IntegrationError(SERVICE, 'no quality profiles were found');
  cache.set(app, { at: Date.now(), guide });
  return guide;
}

export function forgetGuideCache() {
  cache.clear();
}

// ---------------------------------------------------------------- formats

/** Radarr's language ids (Sonarr uses the same for these) → the codes Cinemask's release parser gives. */
const LANGUAGES: Record<number, string> = { 1: 'en', 2: 'fr', 3: 'es', 4: 'de', 5: 'it', 6: 'da', 7: 'nl', 8: 'ja', 9: 'is', 10: 'zh', 11: 'ru', 12: 'pl', 13: 'vi', 14: 'sv', 15: 'no', 16: 'fi', 17: 'tr', 18: 'pt', 20: 'el', 21: 'ko', 22: 'hu', 23: 'he', 24: 'lt', 25: 'cs', 26: 'hi', 27: 'ro', 28: 'th', 29: 'bg', 31: 'ar', 32: 'uk', 33: 'fa' };
const RADARR_SOURCES: Record<number, string> = {
  1: '\\b(HD)?CAM(Rip)?\\b',
  2: '\\b(HD)?(TS|TELESYNC)\\b',
  3: '\\b(TC|TELECINE)\\b',
  4: '\\bWORKPRINT\\b',
  5: '\\bDVD(Rip|5|9|R)?\\b',
  6: '\\b(HDTV|PDTV|SDTV|DSR)\\b',
  7: '\\bWEB[ ._-]?(DL|HD)?\\b(?![ ._-]?Rip)',
  8: '\\bWEB[ ._-]?Rip\\b',
  9: '\\b(Blu[ ._-]?Ray|BD(Rip|25|50)?|BRRip|UHD[ ._-]?BD)\\b',
};
const SONARR_SOURCES: Record<number, string> = {
  1: '\\b(HDTV|PDTV|SDTV|DSR)\\b',
  2: '\\bRaw[ ._-]?HD\\b',
  3: RADARR_SOURCES[7]!,
  4: RADARR_SOURCES[8]!,
  5: RADARR_SOURCES[5]!,
  6: RADARR_SOURCES[9]!,
  7: '\\b(REMUX|BDMV|BD(25|50)|COMPLETE[ ._-]BLURAY)\\b',
};
const MODIFIERS: Record<number, string> = {
  1: '\\bR[1-6]\\b',
  2: '\\b(DVD)?SCR(EENER)?\\b',
  3: '\\bRaw[ ._-]?HD\\b',
  4: '\\b(BDMV|BD(25|50)|COMPLETE[ ._-]BLURAY|AVC[ ._-]?REMUX)\\b',
  5: '\\bREMUX\\b',
};

function fieldValue(spec: Spec, name = 'value'): unknown {
  if (Array.isArray(spec.fields)) return spec.fields.find((f) => f.name === name)?.value;
  return (spec.fields as Record<string, unknown>)[name];
}

/** .NET regular expressions mostly work as they are in JavaScript; the few that don't are skipped. */
function jsPattern(p: unknown): string | null {
  if (typeof p !== 'string' || !p || p.length > 2000) return null;
  const cleaned = p.replace(/^\(\?i\)/, '');
  try {
    new RegExp(cleaned, 'i');
    return cleaned;
  } catch {
    return null;
  }
}

/** A guide spec as a Cinemask rule (before grouping), or null when Cinemask can't check it. */
function translate(app: TrashApp, s: Spec): { kind: FormatRule['kind']; impl: string; rule: FormatRule } | null {
  const base = { negate: Boolean(s.negate), required: Boolean(s.required) };
  const title = (pattern: string | null | undefined) => (pattern ? { kind: 'title' as const, impl: s.implementation, rule: { kind: 'title' as const, pattern, ...base } } : null);
  switch (s.implementation) {
    case 'ReleaseTitleSpecification':
    case 'EditionSpecification':
      return title(jsPattern(fieldValue(s)));
    case 'ReleaseGroupSpecification': {
      const pattern = jsPattern(fieldValue(s));
      return pattern ? { kind: 'group', impl: s.implementation, rule: { kind: 'group', pattern, ...base } } : null;
    }
    case 'SourceSpecification':
      return title((app === 'radarr' ? RADARR_SOURCES : SONARR_SOURCES)[Number(fieldValue(s))]);
    case 'ResolutionSpecification': {
      const v = Number(fieldValue(s));
      return Number.isInteger(v) && v > 0 ? title(`\\b${v}[pi]\\b`) : null;
    }
    case 'QualityModifierSpecification':
      return title(MODIFIERS[Number(fieldValue(s))]);
    case 'LanguageSpecification': {
      const language = LANGUAGES[Number(fieldValue(s))];
      // "Original" and "except" languages need the title's own language, which a format can't see.
      if (!language || fieldValue(s, 'exceptLanguage')) return null;
      return { kind: 'language', impl: s.implementation, rule: { kind: 'language', language, ...base } };
    }
    case 'SizeSpecification': {
      const min = Number(fieldValue(s, 'min') ?? 0);
      const max = Number(fieldValue(s, 'max') ?? 0);
      if (!(min >= 0 && max >= 0 && min <= 1000 && max <= 1000)) return null;
      return { kind: 'size', impl: s.implementation, rule: { kind: 'size', minGb: min, maxGb: max, ...base } };
    }
    default:
      // Indexer flags, release types, years: nothing to match them against here.
      return null;
  }
}

/**
 * The guide's format as Cinemask rules, or null when any part can't be checked (a format that
 * matched less than it should would score the wrong releases). Sonarr and Radarr need one match
 * per kind of spec; Cinemask needs one per kind of rule, so specs that became title rules beside
 * the real title specs are folded into one required rule each.
 */
export function toRules(app: TrashApp, f: TrashFormat): FormatRule[] | null {
  const parts = f.specifications.map((s) => translate(app, s));
  if (!parts.length || parts.some((p) => p === null)) return null;
  const list = parts as NonNullable<ReturnType<typeof translate>>[];
  const rules: FormatRule[] = [];
  const byImpl = new Map<string, typeof list>();
  for (const p of list) byImpl.set(p.impl, [...(byImpl.get(p.impl) ?? []), p]);
  // The one implementation per rule kind whose optional specs stay "any of these".
  const owner = new Map<string, string>();
  for (const p of list) {
    if (p.rule.required) continue;
    const cur = owner.get(p.kind);
    if (!cur || p.impl === 'ReleaseTitleSpecification') owner.set(p.kind, p.impl);
  }
  for (const [impl, specs] of byImpl) {
    for (const p of specs.filter((x) => x.rule.required)) rules.push(p.rule);
    const optional = specs.filter((x) => !x.rule.required);
    if (!optional.length) continue;
    if (owner.get(optional[0]!.kind) === impl) {
      rules.push(...optional.map((x) => x.rule));
      continue;
    }
    // Folded: "any of these" becomes one required rule. Only plain title patterns fold.
    if (optional.length === 1) rules.push({ ...optional[0]!.rule, required: true });
    else if (optional.every((x) => x.rule.kind === 'title' && !x.rule.negate)) rules.push({ kind: 'title', pattern: optional.map((x) => `(?:${(x.rule as { pattern: string }).pattern})`).join('|'), negate: false, required: true });
    else return null;
  }
  return rules.length <= 20 ? rules : null;
}

// ---------------------------------------------------------------- profiles

/** A guide quality name ("Bluray-1080p Remux", "Bluray-576p") as a Cinemask quality. */
function quality(name: string): QualityId | null {
  const n = name.replace(/^Bluray-(\d+p) Remux$/, 'Remux-$1');
  if ((QUALITY_IDS as string[]).includes(n)) return n as QualityId;
  if (/^(Bluray-(480|576)p|DVD-R|DVD)$/.test(n)) return 'DVD';
  return null;
}

function qualitiesOf(p: TrashProfile): { qualities: QualityId[]; cutoff: QualityId } {
  const allowed = new Set<QualityId>();
  let cutoff: QualityId | null = null;
  for (const item of p.items) {
    const members = (item.items?.length ? item.items : [item.name]).map(quality).filter((q): q is QualityId => !!q);
    if (item.allowed) members.forEach((q) => allowed.add(q));
    // A group as the cutoff ("WEB 1080p") means its best member.
    if (item.name === p.cutoff && members.length) cutoff = members.reduce((a, b) => (qualityRank(b) > qualityRank(a) ? b : a));
  }
  const qualities = [...allowed].sort((a, b) => qualityRank(a) - qualityRank(b));
  if (!cutoff || !allowed.has(cutoff)) cutoff = qualities.at(-1) ?? 'WEBDL-1080p';
  return { qualities, cutoff };
}

const truthy = (v: unknown) => v === true || v === 'true';

/** The formats a guide profile uses: its own list, plus the default groups that include it. */
export function formatsFor(guide: Guide, p: TrashProfile): string[] {
  const ids = new Set(Object.values(p.formatItems ?? {}));
  for (const g of guide.groups) {
    const qp = g.quality_profiles;
    const included = qp?.include ? Object.values(qp.include).includes(p.trash_id) : !Object.values(qp?.exclude ?? {}).includes(p.trash_id);
    if (!included || !truthy(g.default)) continue;
    for (const cf of g.custom_formats) if (truthy(cf.required) || truthy(cf.default)) ids.add(cf.trash_id);
  }
  return [...ids];
}

export interface ApplyResult {
  profileId: number;
  formats: number;
  skipped: string[];
}

/**
 * Creates or updates a Cinemask profile from a guide profile: qualities, cutoff, format scores and
 * minimum score. Formats from the guide are created or refreshed (matched by their guide id);
 * scores the guide doesn't set, for formats added by hand, are left as they are.
 */
export function applyGuideProfile(ctx: AppContext, app: TrashApp, guide: Guide, trashId: string, profileId: number | null): ApplyResult {
  const p = guide.profiles.find((x) => x.trash_id === trashId);
  if (!p) throw new IntegrationError(SERVICE, "that profile isn't in the guides any more");
  const scoreSet = p.trash_score_set ?? 'default';
  const skipped: string[] = [];
  const scores: Record<string, number> = {};
  const now = Date.now();
  for (const id of formatsFor(guide, p)) {
    const f = guide.formats.get(id);
    if (!f) continue;
    const rules = toRules(app, f);
    if (!rules) {
      skipped.push(f.name);
      continue;
    }
    const score = f.trash_scores?.[scoreSet] ?? f.trash_scores?.default ?? 0;
    const json = JSON.stringify(rules);
    let row = ctx.db.select().from(customFormats).where(eq(customFormats.trashId, id)).get();
    if (row) ctx.db.update(customFormats).set({ rules: json }).where(eq(customFormats.id, row.id)).run();
    else {
      // A format of the same name made by hand keeps its name; the guide's gets "(TRaSH)". The
      // movie and TV guides share many names, so the second gets "(TV)" or "(Movies)".
      const clash = ctx.db.select().from(customFormats).where(eq(customFormats.name, f.name.slice(0, 60))).get();
      const suffix = !clash ? '' : clash.trashId ? (app === 'sonarr' ? ' (TV)' : ' (Movies)') : ' (TRaSH)';
      row = ctx.db
        .insert(customFormats)
        .values({ name: `${f.name.slice(0, 60 - suffix.length)}${suffix}`, rules: json, trashId: id, createdAt: now })
        .onConflictDoUpdate({ target: customFormats.name, set: { rules: json, trashId: id } })
        .returning()
        .get();
    }
    scores[String(row.id)] = score;
  }
  const { qualities, cutoff } = qualitiesOf(p);
  const existing = profileId ? getProfile(ctx, profileId) : null;
  // Formats from the guides that this profile no longer uses lose their score here.
  const guideIds = new Set(ctx.db.select({ id: customFormats.id }).from(customFormats).where(isNotNull(customFormats.trashId)).all().map((r) => String(r.id)));
  const kept = Object.fromEntries(Object.entries(existing?.formatScores ?? {}).filter(([k]) => !guideIds.has(k)));
  const values = {
    qualities: JSON.stringify(qualities),
    cutoff,
    upgradesAllowed: p.upgradeAllowed ?? true,
    formatScores: JSON.stringify({ ...kept, ...scores }),
    minFormatScore: p.minFormatScore ?? 0,
    upgradeUntilFormatScore: p.upgradeAllowed === false ? 0 : (p.cutoffFormatScore ?? 0),
    trashApp: app,
    trashId: p.trash_id,
    trashSyncedAt: now,
  };
  if (existing) {
    ctx.db.update(qualityProfiles).set(values).where(eq(qualityProfiles.id, existing.id)).run();
    return { profileId: existing.id, formats: Object.keys(scores).length, skipped };
  }
  let name = `TRaSH ${p.name}`.slice(0, 60);
  for (let n = 2; ctx.db.select().from(qualityProfiles).where(eq(qualityProfiles.name, name)).get(); n++) name = `TRaSH ${p.name} ${n}`.slice(0, 60);
  const row = ctx.db.insert(qualityProfiles).values({ name, language: 'any', createdAt: now, ...values }).returning().get();
  return { profileId: row.id, formats: Object.keys(scores).length, skipped };
}

/** The weekly run: every profile linked to a guide profile is applied again. Returns how many were synced. */
export async function syncLinkedProfiles(ctx: AppContext): Promise<number> {
  const linked = ctx.db.select().from(qualityProfiles).where(and(isNotNull(qualityProfiles.trashApp), isNotNull(qualityProfiles.trashId))).all();
  let synced = 0;
  for (const app of TRASH_APPS) {
    const mine = linked.filter((p) => p.trashApp === app);
    if (!mine.length) continue;
    const guide = await loadGuide(app, true);
    for (const p of mine) {
      try {
        applyGuideProfile(ctx, app, guide, p.trashId!, p.id);
        synced++;
      } catch {
        // Dropped from the guides: keeps its last settings.
      }
    }
  }
  return synced;
}
