import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { monitored, monitoredEpisodes } from '../db/schema.js';
import { getProfile } from '../arr/profiles.js';

/** What a video file really holds, read with ffprobe rather than trusted from its name. */
export interface FileInfo {
  width: number | null;
  height: number | null;
  /** 2160p, 1080p, 720p, 480p or SD, from the picture size. */
  resolution: string | null;
  videoCodec: string | null;
  /** Dolby Vision, HDR10, HLG or null for SDR. */
  hdr: string | null;
  durationMin: number | null;
  audio: { codec: string; channels: number | null; language: string | null; title: string | null }[];
  subtitles: { codec: string; language: string | null; forced: boolean }[];
  /** Subtitle files next to the video, such as Movie.en.srt. */
  externalSubtitles: string[];
  /** Things that don't match what the release name or profile promised. */
  problems: string[];
  probedAt: number;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  channels?: number;
  color_transfer?: string;
  tags?: Record<string, string>;
  disposition?: { forced?: number; attached_pic?: number };
  side_data_list?: { side_data_type?: string }[];
}

const LANG3: Record<string, string> = {
  eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it', dut: 'nl', nld: 'nl', jpn: 'ja', kor: 'ko', hin: 'hi', por: 'pt', rus: 'ru', pol: 'pl', swe: 'sv',
  chi: 'zh', zho: 'zh', dan: 'da', nor: 'no', nob: 'no', fin: 'fi', hun: 'hu', cze: 'cs', ces: 'cs', tur: 'tr', heb: 'he', ukr: 'uk', gre: 'el', ell: 'el', ara: 'ar', tha: 'th', vie: 'vi',
};

/** ISO 639-1 code for a stream's language tag ("eng" → "en"), or null when untagged. */
export function langCode(tag: string | undefined): string | null {
  if (!tag) return null;
  const t = tag.toLowerCase();
  if (t === 'und' || t === 'unk' || t === 'mis' || t === 'zxx') return null;
  return t.length === 2 ? t : (LANG3[t] ?? t);
}

export function resolutionOf(width: number | null, height: number | null): string | null {
  if (!width || !height) return null;
  // Width matters for cinema crops (1920×800 is still 1080p).
  if (width >= 3200 || height >= 1800) return '2160p';
  if (width >= 1700 || height >= 1000) return '1080p';
  if (width >= 1200 || height >= 700) return '720p';
  if (height >= 470) return '480p';
  return 'SD';
}

const SUB_EXT = /\.(srt|ass|ssa|vtt|sub|idx|sup)$/i;

function sidecars(file: string): string[] {
  const dir = path.dirname(file);
  const base = path.parse(file).name;
  try {
    return fs.readdirSync(dir).filter((f) => SUB_EXT.test(f) && f.startsWith(base));
  } catch {
    return [];
  }
}

/** Parses ffprobe's JSON. Exported for tests. */
export function fromProbe(json: { streams?: ProbeStream[]; format?: { duration?: string } }, file: string | null): Omit<FileInfo, 'problems'> {
  const streams = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const dv = streams.some((s) => s.side_data_list?.some((d) => /dovi|dolby vision/i.test(d.side_data_type ?? ''))) || /dvhe|dvh1/i.test(video?.codec_name ?? '');
  const transfer = video?.color_transfer ?? '';
  const hdr = dv ? 'Dolby Vision' : transfer === 'smpte2084' ? 'HDR10' : transfer === 'arib-std-b67' ? 'HLG' : null;
  const width = video?.width ?? null;
  const height = video?.height ?? null;
  const duration = Number(json.format?.duration);
  return {
    width,
    height,
    resolution: resolutionOf(width, height),
    videoCodec: video?.codec_name ?? null,
    hdr,
    durationMin: Number.isFinite(duration) && duration > 0 ? Math.round(duration / 60) : null,
    audio: streams
      .filter((s) => s.codec_type === 'audio')
      .map((s) => ({ codec: s.codec_name ?? '?', channels: s.channels ?? null, language: langCode(s.tags?.language), title: s.tags?.title ?? null })),
    subtitles: streams.filter((s) => s.codec_type === 'subtitle').map((s) => ({ codec: s.codec_name ?? '?', language: langCode(s.tags?.language), forced: Boolean(s.disposition?.forced) })),
    externalSubtitles: file ? sidecars(file) : [],
    probedAt: Date.now(),
  };
}

const RES_OF_QUALITY = (q: string) => /2160p/.test(q) ? '2160p' : /1080p/.test(q) ? '1080p' : /720p/.test(q) ? '720p' : /480p|DVD|SDTV/.test(q) ? '480p' : null;
const RES_RANK: Record<string, number> = { SD: 0, '480p': 1, '720p': 2, '1080p': 3, '2160p': 4 };

/** Compares what's in the file with what its quality and the profile's language promised. */
export function problemsOf(info: Omit<FileInfo, 'problems'>, quality: string | null, language: string | null): string[] {
  const out: string[] = [];
  const claimed = quality ? RES_OF_QUALITY(quality) : null;
  if (claimed && info.resolution && RES_RANK[info.resolution]! < RES_RANK[claimed]!) out.push(`Sold as ${claimed} but the picture is ${info.resolution} (${info.width}×${info.height})`);
  if (language && language !== 'any' && language !== 'multi') {
    const langs = info.audio.map((a) => a.language);
    // Untagged audio could be anything; only a file whose audio is all tagged otherwise is flagged.
    if (info.audio.length && !langs.includes(language) && langs.every((l) => l !== null)) out.push(`No ${language.toUpperCase()} audio (has ${[...new Set(langs)].join(', ')})`);
  }
  if (!info.audio.length && info.videoCodec) out.push('No audio track');
  return out;
}

/** Runs ffprobe on a file. Rejects when ffprobe is missing or the file can't be read. */
export function probe(file: string, ffprobe = process.env.FFPROBE_PATH || 'ffprobe'): Promise<Omit<FileInfo, 'problems'>> {
  return new Promise((resolve, reject) => {
    execFile(ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', '--', file], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`Couldn't read ${path.basename(file)}: ${err.message.split('\n')[0]}`));
      try {
        resolve(fromProbe(JSON.parse(stdout), file));
      } catch (e) {
        reject(e);
      }
    });
  });
}

export function infoOf(raw: string | null): FileInfo | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FileInfo;
  } catch {
    return null;
  }
}

/** Probes a title's files that have no details yet (or all of them) and stores what was found. */
export async function probeTitle(ctx: AppContext, monitoredId: number, opts: { all?: boolean; language?: string } = {}): Promise<number> {
  const row = ctx.db.select().from(monitored).where(eq(monitored.id, monitoredId)).get();
  if (!row) return 0;
  const language = opts.language ?? getProfile(ctx, row.profileId)?.language ?? null;
  let done = 0;
  if (row.kind === 'movie') {
    if (row.filePath && fs.existsSync(row.filePath) && (opts.all || !row.fileInfo)) {
      const info = await probe(row.filePath).catch(() => null);
      if (info) {
        ctx.db.update(monitored).set({ fileInfo: JSON.stringify({ ...info, problems: problemsOf(info, row.fileQuality, language) }) }).where(eq(monitored.id, row.id)).run();
        done++;
      }
    }
    return done;
  }
  const eps = ctx.db.select().from(monitoredEpisodes).where(and(eq(monitoredEpisodes.monitoredId, row.id), isNotNull(monitoredEpisodes.filePath))).all();
  const seen = new Map<string, string>();
  for (const e of eps) {
    if (!opts.all && e.fileInfo) continue;
    let json = seen.get(e.filePath!);
    if (!json) {
      if (!fs.existsSync(e.filePath!)) continue;
      const info = await probe(e.filePath!).catch(() => null);
      if (!info) continue;
      json = JSON.stringify({ ...info, problems: problemsOf(info, e.fileQuality, language) });
      seen.set(e.filePath!, json);
    }
    ctx.db.update(monitoredEpisodes).set({ fileInfo: json }).where(eq(monitoredEpisodes.id, e.id)).run();
    done++;
  }
  return done;
}

/** Background job: reads details for files that don't have them yet, a few titles at a time. */
export async function probeMissing(ctx: AppContext, batch = 25): Promise<number> {
  const movies = ctx.db.select({ id: monitored.id }).from(monitored).where(and(isNotNull(monitored.filePath), isNull(monitored.fileInfo))).limit(batch).all();
  const shows = ctx.db
    .selectDistinct({ id: monitoredEpisodes.monitoredId })
    .from(monitoredEpisodes)
    .where(and(isNotNull(monitoredEpisodes.filePath), isNull(monitoredEpisodes.fileInfo)))
    .limit(batch)
    .all();
  let n = 0;
  for (const r of [...movies, ...shows]) n += await probeTitle(ctx, r.id).catch(() => 0);
  return n;
}

