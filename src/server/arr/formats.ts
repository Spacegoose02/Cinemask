import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { customFormats } from '../db/schema.js';
import type { Release } from './indexers.js';
import type { ParsedRelease } from './parser.js';

/**
 * Custom formats: named rules that pick out things in a release beyond its resolution and source
 * (HDR, Dolby Vision, Atmos, a streaming service, a release group…). Each quality profile gives
 * each format a score; a release's format score is the sum of the formats it matches.
 */
const pattern = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((p) => {
    try {
      new RegExp(p, 'i');
      return true;
    } catch {
      return false;
    }
  }, 'Not a valid regular expression');

export const ruleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('title'), pattern, negate: z.boolean().default(false), required: z.boolean().default(false) }),
  z.object({ kind: z.literal('group'), pattern, negate: z.boolean().default(false), required: z.boolean().default(false) }),
  z.object({ kind: z.literal('indexer'), pattern, negate: z.boolean().default(false), required: z.boolean().default(false) }),
  z.object({ kind: z.literal('language'), language: z.string().regex(/^([a-z]{2}|multi)$/), negate: z.boolean().default(false), required: z.boolean().default(false) }),
  z.object({ kind: z.literal('protocol'), protocol: z.enum(['usenet', 'torrent']), negate: z.boolean().default(false), required: z.boolean().default(false) }),
  z.object({ kind: z.literal('size'), minGb: z.number().min(0).max(1000).default(0), maxGb: z.number().min(0).max(1000).default(0), negate: z.boolean().default(false), required: z.boolean().default(false) }),
]);
export type FormatRule = z.output<typeof ruleSchema>;

export const formatBody = z.object({
  name: z.string().trim().min(1).max(60),
  rules: z.array(ruleSchema).min(1).max(20),
});

export interface CustomFormat {
  id: number;
  name: string;
  rules: FormatRule[];
}

export function listFormats(ctx: AppContext): CustomFormat[] {
  return ctx.db
    .select()
    .from(customFormats)
    .orderBy(asc(customFormats.name))
    .all()
    .map((f) => ({ id: f.id, name: f.name, rules: JSON.parse(f.rules) as FormatRule[] }));
}

export function getFormat(ctx: AppContext, id: number): CustomFormat | null {
  const f = ctx.db.select().from(customFormats).where(eq(customFormats.id, id)).get();
  return f ? { id: f.id, name: f.name, rules: JSON.parse(f.rules) as FormatRule[] } : null;
}

const regexCache = new Map<string, RegExp>();
function re(p: string): RegExp {
  let r = regexCache.get(p);
  if (!r) {
    r = new RegExp(p, 'i');
    if (regexCache.size > 500) regexCache.clear();
    regexCache.set(p, r);
  }
  return r;
}

function ruleHit(rule: FormatRule, release: Pick<Release, 'title' | 'indexer' | 'protocol' | 'size'>, parsed: Pick<ParsedRelease, 'group' | 'languages'>, perItemSize: number | null): boolean {
  let hit: boolean;
  switch (rule.kind) {
    case 'title':
      hit = re(rule.pattern).test(release.title);
      break;
    case 'group':
      hit = parsed.group !== null && re(rule.pattern).test(parsed.group);
      break;
    case 'indexer':
      hit = re(rule.pattern).test(release.indexer ?? '');
      break;
    case 'language':
      hit = parsed.languages.includes(rule.language);
      break;
    case 'protocol':
      hit = release.protocol === rule.protocol;
      break;
    case 'size': {
      const gb = (perItemSize ?? release.size ?? 0) / 1024 ** 3;
      hit = gb >= rule.minGb && (!rule.maxGb || gb <= rule.maxGb);
      break;
    }
  }
  return rule.negate ? !hit : hit;
}

/**
 * Whether a release matches a format: every required rule must hold, and of the other rules at
 * least one of each kind (so "HDR10 or HDR10+ or HLG" are three title rules, any one will do).
 */
export function formatMatches(f: CustomFormat, release: Pick<Release, 'title' | 'indexer' | 'protocol' | 'size'>, parsed: Pick<ParsedRelease, 'group' | 'languages'>, perItemSize: number | null = null): boolean {
  if (!f.rules.length) return false;
  const byKind = new Map<string, boolean>();
  for (const r of f.rules) {
    const hit = ruleHit(r, release, parsed, perItemSize);
    if (r.required) {
      if (!hit) return false;
      continue;
    }
    byKind.set(r.kind, (byKind.get(r.kind) ?? false) || hit);
  }
  return [...byKind.values()].every(Boolean);
}

export interface FormatScore {
  score: number;
  matched: string[];
}

/** The formats a release matches and its total score under a profile's scores. */
export function scoreRelease(
  formats: CustomFormat[],
  scores: Record<string, number>,
  release: Pick<Release, 'title' | 'indexer' | 'protocol' | 'size'>,
  parsed: Pick<ParsedRelease, 'group' | 'languages'>,
  perItemSize: number | null = null,
): FormatScore {
  let score = 0;
  const matched: string[] = [];
  for (const f of formats) {
    if (!formatMatches(f, release, parsed, perItemSize)) continue;
    matched.push(f.name);
    score += scores[String(f.id)] ?? 0;
  }
  return { score, matched };
}

/**
 * Ready-made formats in the spirit of the community guides, with suggested scores. They're plain
 * formats once added, so they can be changed or removed like any other.
 */
export const PRESETS: { name: string; score: number; rules: FormatRule[]; about: string }[] = [
  { name: 'Dolby Vision', score: 300, about: 'Dynamic HDR most new TVs play', rules: [{ kind: 'title', pattern: '\\b(DV|DoVi|Dolby[ .]?Vision)\\b', negate: false, required: false }] },
  { name: 'HDR10+', score: 400, about: 'Dynamic HDR on Samsung and others', rules: [{ kind: 'title', pattern: '\\bHDR10(\\+|P(lus)?)\\b', negate: false, required: false }] },
  { name: 'HDR', score: 500, about: 'HDR10, HDR or HLG', rules: [{ kind: 'title', pattern: '\\b(HDR(10)?|HLG|PQ)\\b', negate: false, required: false }] },
  { name: 'Atmos', score: 200, about: 'Dolby Atmos sound', rules: [{ kind: 'title', pattern: '\\bAtmos\\b', negate: false, required: false }] },
  { name: 'Lossless audio', score: 150, about: 'TrueHD, DTS-HD MA, DTS:X or FLAC', rules: [{ kind: 'title', pattern: '\\b(TrueHD|DTS[ .-]?HD[ .-]?MA|DTS[ .-]?X|FLAC|LPCM)\\b', negate: false, required: false }] },
  { name: 'Streaming service', score: 100, about: 'A clean copy from Netflix, Amazon, Apple TV+, Disney+, Max and others', rules: [{ kind: 'title', pattern: '\\b(NF|AMZN|ATVP|DSNP|HMAX|MAX|PCOK|HULU|PMTP|iT|CRAV|STAN)\\b', negate: false, required: false }] },
  { name: 'Repack or proper', score: 50, about: 'A fixed re-release', rules: [{ kind: 'title', pattern: '\\b(REPACK\\d?|PROPER|RERIP)\\b', negate: false, required: false }] },
  { name: 'x265 / HEVC', score: 0, about: 'Smaller files; some older devices struggle with it', rules: [{ kind: 'title', pattern: '\\b(x265|HEVC|h\\.?265)\\b', negate: false, required: false }] },
  { name: 'AV1', score: -10000, about: 'Very new codec many TVs can\'t play yet', rules: [{ kind: 'title', pattern: '\\bAV1\\b', negate: false, required: false }] },
  { name: 'Low-quality groups', score: -10000, about: 'Heavily compressed re-encodes', rules: [{ kind: 'group', pattern: '^(YIFY|YTS(\\.\\w+)?|aXXo|PSA)$', negate: false, required: false }] },
  { name: 'Hardcoded subtitles', score: -10000, about: 'Subtitles burned into the picture', rules: [{ kind: 'title', pattern: '\\b(HC|HARDSUBS?|KORSUB|SUBBED)\\b', negate: false, required: false }] },
  { name: 'Upscaled', score: -10000, about: 'Blown up from a lower resolution', rules: [{ kind: 'title', pattern: '\\b(Upscaled?|AI[ .]?Upscale|Regraded)\\b', negate: false, required: false }] },
  { name: '3D', score: -10000, about: 'Needs a 3D TV', rules: [{ kind: 'title', pattern: '\\b(3D|SBS|Half[ .-]?(SBS|OU)|HSBS|HOU)\\b', negate: false, required: false }] },
  { name: 'Extras only', score: -10000, about: 'Bonus discs and featurettes', rules: [{ kind: 'title', pattern: '\\b(Extras|Bonus[ .]?Disc|Featurettes?)\\b', negate: false, required: false }] },
];
