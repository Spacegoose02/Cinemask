import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { AppContext } from "../context.js";
import {
  youtubeChannels,
  youtubeVideos,
  type YOUTUBE_MODES,
} from "../db/schema.js";
import { refreshMediaServers } from "../arr/tracker.js";
import { sanitizeSegment } from "../arr/naming.js";
import { insideRoot } from "../lib/paths.js";
import { ytDlpBinary } from "../trailers/service.js";

export type ChannelRow = typeof youtubeChannels.$inferSelect;
export type VideoRow = typeof youtubeVideos.$inferSelect;
export type YoutubeMode = (typeof YOUTUBE_MODES)[number];
export interface Playlist {
  id: string;
  title: string;
}

const VIDEO_ID = /^[\w-]{11}$/;
const PLAYLIST_ID = /^[\w-]{10,64}$/;
/** How many of the newest videos each check looks at; older ones were seen on earlier checks. */
const CHECK_DEPTH = 50;

/**
 * Turns what someone pasted into a canonical YouTube channel or playlist URL, or null. Only
 * youtube.com channel (@handle, /channel/, /c/, /user/) and playlist links are accepted, so
 * nothing else is ever handed to yt-dlp.
 */
export function parseChannelUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!/^(www\.|m\.)?youtube\.com$/.test(u.hostname)) return null;
  const list = u.searchParams.get("list");
  if (u.pathname === "/playlist")
    return list && PLAYLIST_ID.test(list)
      ? `https://www.youtube.com/playlist?list=${list}`
      : null;
  const m = u.pathname.match(
    /^\/(@[\w.-]{1,100}|channel\/UC[\w-]{22}|c\/[\w.-]{1,100}|user\/[\w.-]{1,100})(\/.*)?$/,
  );
  return m ? `https://www.youtube.com/${m[1]}` : null;
}

export const isPlaylistUrl = (url: string) =>
  url.startsWith("https://www.youtube.com/playlist?");

/** Runs yt-dlp with arguments (never through a shell) and returns what it printed. */
function ytDlp(
  ctx: AppContext,
  args: string[],
  timeoutMs = 5 * 60 * 1000,
): Promise<string> {
  const bin = ytDlpBinary(ctx);
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ["--no-progress", "--no-warnings", ...args],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err)
          reject(
            new Error(
              (String(stderr).trim().split("\n").pop() || err.message)
                .replace(/^ERROR:\s*/, "")
                .slice(0, 500),
            ),
          );
        else resolve(String(stdout));
      },
    );
  });
}

async function ytJson<T>(ctx: AppContext, args: string[]): Promise<T> {
  const out = await ytDlp(ctx, ["-J", ...args]);
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new Error("yt-dlp returned something that is not JSON");
  }
}

interface FlatList {
  id?: string;
  title?: string;
  channel?: string;
  uploader?: string;
  channel_id?: string;
  description?: string;
  thumbnails?: { url?: string; id?: string; width?: number }[];
  entries?: {
    id?: string;
    title?: string;
    url?: string;
    upload_date?: string;
  }[];
}

/** Lists a channel's uploads or a playlist's videos (newest first), without downloading. */
async function flatVideos(
  ctx: AppContext,
  url: string,
  limit?: number,
): Promise<FlatList> {
  const target = isPlaylistUrl(url) ? url : `${url}/videos`;
  return ytJson<FlatList>(ctx, [
    "--flat-playlist",
    ...(limit ? ["-I", `1:${limit}`] : []),
    "--",
    target,
  ]);
}

const ymd = (d: string | undefined) =>
  d && /^\d{8}$/.test(d)
    ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
    : null;

/** The channel's playlists, to pick which to follow. */
export async function channelPlaylists(
  ctx: AppContext,
  url: string,
): Promise<Playlist[]> {
  if (isPlaylistUrl(url)) return [];
  const r = await ytJson<FlatList>(ctx, [
    "--flat-playlist",
    "--",
    `${url}/playlists`,
  ]);
  return (r.entries ?? []).flatMap((e) => {
    const id = e.id ?? (e.url ? new URL(e.url).searchParams.get("list") : null);
    return id && PLAYLIST_ID.test(id)
      ? [{ id, title: (e.title ?? id).slice(0, 300) }]
      : [];
  });
}

export function channelFolder(
  ctx: AppContext,
  ch: Pick<ChannelRow, "name">,
): { root: string; dir: string } {
  const root = ctx.settings.get("extras").youtubePath;
  return { root, dir: path.join(root, sanitizeSegment(ch.name) || "Channel") };
}

const xml = (s: string) =>
  s
    .replace(
      /[<>&"']/g,
      (c) =>
        ({
          "<": "&lt;",
          ">": "&gt;",
          "&": "&amp;",
          '"': "&quot;",
          "'": "&apos;",
        })[c]!,
    )
    // Control characters aren't allowed in XML.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

function writeInside(root: string, file: string, data: string | Buffer) {
  if (!insideRoot(root, file))
    throw new Error("Refusing to write outside the YouTube folder");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

/** Only YouTube's own image hosts are fetched for channel art. */
const IMAGE_HOST = /(^|\.)(ytimg\.com|ggpht\.com|googleusercontent\.com)$/;

async function writeChannelArt(
  root: string,
  dir: string,
  thumbs: FlatList["thumbnails"],
) {
  const best = [...(thumbs ?? [])]
    .filter((t) => t.url)
    .sort(
      (a, b) =>
        Number(b.id === "avatar_uncropped") -
          Number(a.id === "avatar_uncropped") ||
        (b.width ?? 0) - (a.width ?? 0),
    )[0];
  if (!best?.url) return;
  try {
    const u = new URL(best.url);
    if (u.protocol !== "https:" || !IMAGE_HOST.test(u.hostname)) return;
    const res = await fetch(u, {
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
    if (
      !res.ok ||
      !String(res.headers.get("content-type")).startsWith("image/")
    )
      return;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 5 * 1024 * 1024)
      writeInside(root, path.join(dir, "poster.jpg"), buf);
  } catch {
    // Artwork is a nicety; Plex/Jellyfin fall back to a video frame.
  }
}

/** tvshow.nfo, so Jellyfin (and Plex with local metadata) show the channel as a series. */
function writeShowNfo(
  root: string,
  dir: string,
  ch: Pick<ChannelRow, "name" | "description" | "channelId" | "url">,
) {
  const nfo = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    "<tvshow>",
    `  <title>${xml(ch.name)}</title>`,
    `  <plot>${xml(ch.description ?? "")}</plot>`,
    "  <studio>YouTube</studio>",
    "  <genre>YouTube</genre>",
    ch.channelId
      ? `  <uniqueid type="youtube" default="true">${xml(ch.channelId)}</uniqueid>`
      : "",
    "</tvshow>",
    "",
  ].filter((l) => l !== "");
  writeInside(root, path.join(dir, "tvshow.nfo"), `${nfo.join("\n")}\n`);
}

/** Adds the videos it hasn't seen yet. Returns how many were new. */
function recordVideos(
  ctx: AppContext,
  channelId: number,
  entries: FlatList["entries"],
  status: "wanted" | "skipped",
  playlistId: string | null = null,
): number {
  let added = 0;
  for (const e of entries ?? []) {
    if (!e.id || !VIDEO_ID.test(e.id)) continue;
    const r = ctx.db
      .insert(youtubeVideos)
      .values({
        channelId,
        videoId: e.id,
        title: (e.title ?? e.id).slice(0, 500),
        playlistId,
        publishedAt: ymd(e.upload_date),
        status,
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
    added += r.changes;
  }
  return added;
}

/**
 * Subscribes to a channel or playlist. "new" downloads only videos published from now on, "all"
 * everything already there too, "playlists" every video in the chosen playlists. With `pick`,
 * those videos are only listed (new uploads too), and nothing downloads until someone picks it.
 */
export async function addChannel(
  ctx: AppContext,
  url: string,
  mode: YoutubeMode,
  playlists: Playlist[],
  userId: number | null,
  pick = false,
): Promise<ChannelRow> {
  const info = await flatVideos(
    ctx,
    url,
    mode === "new" ? CHECK_DEPTH : undefined,
  );
  const name = (info.channel ?? info.uploader ?? info.title ?? "YouTube")
    .replace(/ - Videos$/, "")
    .slice(0, 200);
  const row = ctx.db
    .insert(youtubeChannels)
    .values({
      url,
      channelId: info.channel_id ?? info.id ?? null,
      name,
      description: info.description?.slice(0, 5000) ?? null,
      mode,
      playlists: mode === "playlists" ? JSON.stringify(playlists) : null,
      pick,
      lastCheckedAt: Date.now(),
      createdBy: userId,
      createdAt: Date.now(),
    })
    .returning()
    .get();
  const { root, dir } = channelFolder(ctx, row);
  try {
    writeShowNfo(root, dir, row);
    await writeChannelArt(root, dir, info.thumbnails);
  } catch (err) {
    ctx.db
      .update(youtubeChannels)
      .set({ lastError: (err as Error).message })
      .where(eq(youtubeChannels.id, row.id))
      .run();
  }
  if (mode === "playlists") await checkChannel(ctx, row);
  else
    recordVideos(
      ctx,
      row.id,
      info.entries,
      mode === "all" && !pick ? "wanted" : "skipped",
    );
  return ctx.db
    .select()
    .from(youtubeChannels)
    .where(eq(youtubeChannels.id, row.id))
    .get()!;
}

/** Looks for new videos on one channel. */
export async function checkChannel(
  ctx: AppContext,
  ch: ChannelRow,
): Promise<number> {
  let added = 0;
  try {
    if (ch.mode === "playlists") {
      for (const p of JSON.parse(ch.playlists ?? "[]") as Playlist[]) {
        if (!PLAYLIST_ID.test(p.id)) continue;
        const r = await flatVideos(
          ctx,
          `https://www.youtube.com/playlist?list=${p.id}`,
        );
        added += recordVideos(ctx, ch.id, r.entries, ch.pick ? "skipped" : "wanted", p.id);
      }
    } else {
      const r = await flatVideos(ctx, ch.url, CHECK_DEPTH);
      added += recordVideos(ctx, ch.id, r.entries, ch.pick ? "skipped" : "wanted");
    }
    ctx.db
      .update(youtubeChannels)
      .set({ lastCheckedAt: Date.now(), lastError: null })
      .where(eq(youtubeChannels.id, ch.id))
      .run();
  } catch (err) {
    ctx.db
      .update(youtubeChannels)
      .set({ lastCheckedAt: Date.now(), lastError: (err as Error).message })
      .where(eq(youtubeChannels.id, ch.id))
      .run();
    throw err;
  }
  return added;
}

/** Checks every enabled channel that is due (Settings → Media management → YouTube). */
export async function checkDueChannels(ctx: AppContext): Promise<void> {
  const every = ctx.settings.get("extras").youtubeCheckHours * 3600_000;
  for (const ch of ctx.db
    .select()
    .from(youtubeChannels)
    .where(eq(youtubeChannels.enabled, true))
    .all()) {
    if (ch.lastCheckedAt && Date.now() - ch.lastCheckedAt < every - 60_000)
      continue;
    await checkChannel(ctx, ch).catch(() => undefined);
  }
}

interface VideoInfo {
  id: string;
  title?: string;
  description?: string;
  upload_date?: string;
  channel?: string;
  duration?: number;
}

const VIDEO_EXT = [".mkv", ".mp4", ".webm"];

/**
 * Downloads one video into Channel/Season YYYY/Channel - YYYY-MM-DD - Title [id].mkv, with a
 * thumbnail and an episode .nfo next to it. Plex reads the date in the name; Jellyfin reads the .nfo.
 */
export async function downloadVideo(
  ctx: AppContext,
  v: VideoRow,
): Promise<void> {
  if (!VIDEO_ID.test(v.videoId))
    throw new Error("Not a valid YouTube video id");
  const ch = ctx.db
    .select()
    .from(youtubeChannels)
    .where(eq(youtubeChannels.id, v.channelId))
    .get();
  if (!ch) throw new Error("Channel not found");
  const url = `https://www.youtube.com/watch?v=${v.videoId}`;
  const info = await ytJson<VideoInfo>(ctx, [
    "--skip-download",
    "--no-playlist",
    "--",
    url,
  ]);
  const date =
    ymd(info.upload_date) ??
    v.publishedAt ??
    new Date().toISOString().slice(0, 10);
  const title = (info.title ?? v.title).slice(0, 300);
  const { root, dir } = channelFolder(ctx, ch);
  const seasonDir = path.join(dir, `Season ${date.slice(0, 4)}`);
  const stem =
    sanitizeSegment(`${sanitizeSegment(ch.name)} - ${date} - ${title}`).slice(
      0,
      180,
    ) + ` [${v.videoId}]`;
  if (!insideRoot(root, path.join(seasonDir, stem)))
    throw new Error("Refusing to write outside the YouTube folder");
  fs.mkdirSync(seasonDir, { recursive: true });
  const h = ctx.settings.get("extras").youtubeMaxHeight;
  await ytDlp(
    ctx,
    [
      "--no-playlist",
      "-f",
      `bv*[height<=${h}]+ba/b[height<=${h}]`,
      "--merge-output-format",
      "mkv",
      "--write-thumbnail",
      "--convert-thumbnails",
      "jpg",
      "-o",
      path.join(seasonDir, `${stem}.%(ext)s`),
      "--",
      url,
    ],
    60 * 60 * 1000,
  );
  const file = fs
    .readdirSync(seasonDir)
    .find(
      (f) =>
        f.startsWith(stem) && VIDEO_EXT.includes(path.extname(f).toLowerCase()),
    );
  if (!file) throw new Error("yt-dlp finished but no video file appeared");
  const nfo = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    "<episodedetails>",
    `  <title>${xml(title)}</title>`,
    `  <showtitle>${xml(ch.name)}</showtitle>`,
    `  <season>${date.slice(0, 4)}</season>`,
    `  <episode>${Number(date.slice(5, 7) + date.slice(8, 10))}</episode>`,
    `  <aired>${date}</aired>`,
    `  <plot>${xml((info.description ?? "").slice(0, 10_000))}</plot>`,
    info.duration
      ? `  <runtime>${Math.round(info.duration / 60)}</runtime>`
      : "",
    `  <uniqueid type="youtube" default="true">${v.videoId}</uniqueid>`,
    "</episodedetails>",
  ].filter((l) => l !== "");
  writeInside(root, path.join(seasonDir, `${stem}.nfo`), `${nfo.join("\n")}\n`);
  ctx.db
    .update(youtubeVideos)
    .set({
      status: "done",
      path: path.join(seasonDir, file),
      title,
      publishedAt: date,
      error: null,
    })
    .where(eq(youtubeVideos.id, v.id))
    .run();
}

let queue: Promise<number> = Promise.resolve(0);

/** Downloads waiting videos, oldest first, a few per run. Overlapping calls wait their turn. */
export function downloadWanted(ctx: AppContext, max = 10): Promise<number> {
  queue = queue.catch(() => 0).then(() => downloadBatch(ctx, max));
  return queue;
}

async function downloadBatch(ctx: AppContext, max: number): Promise<number> {
  const enabled = ctx.db
    .select({ id: youtubeChannels.id })
    .from(youtubeChannels)
    .where(eq(youtubeChannels.enabled, true))
    .all()
    .map((c) => c.id);
  if (!enabled.length) return 0;
  const queue = ctx.db
    .select()
    .from(youtubeVideos)
    .where(
      and(
        eq(youtubeVideos.status, "wanted"),
        inArray(youtubeVideos.channelId, enabled),
      ),
    )
    .orderBy(asc(youtubeVideos.publishedAt), asc(youtubeVideos.id))
    .limit(max)
    .all();
  let done = 0;
  for (const v of queue) {
    ctx.db
      .update(youtubeVideos)
      .set({ status: "downloading" })
      .where(eq(youtubeVideos.id, v.id))
      .run();
    try {
      await downloadVideo(ctx, v);
      done++;
    } catch (err) {
      ctx.db
        .update(youtubeVideos)
        .set({ status: "failed", error: (err as Error).message.slice(0, 500) })
        .where(eq(youtubeVideos.id, v.id))
        .run();
    }
  }
  if (done) void refreshMediaServers(ctx);
  return done;
}

/** After a restart, anything left "downloading" is put back in the queue. */
export function requeueInterrupted(ctx: AppContext) {
  ctx.db
    .update(youtubeVideos)
    .set({ status: "wanted" })
    .where(eq(youtubeVideos.status, "downloading"))
    .run();
}
