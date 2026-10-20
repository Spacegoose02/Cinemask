import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit/log.js";
import { YOUTUBE_MODES, youtubeChannels, youtubeVideos } from "../db/schema.js";
import { badRequest, conflict, HttpError, notFound } from "../lib/errors.js";
import { parse } from "../lib/validate.js";
import {
  addChannel,
  channelPlaylists,
  checkChannel,
  downloadWanted,
  parseChannelUrl,
  type ChannelRow,
} from "./service.js";

const idParam = z.object({ id: z.coerce.number().int().positive() });
const urlBody = z.object({ url: z.string().trim().min(1).max(500) });
const playlists = z
  .array(
    z.object({
      id: z.string().regex(/^[\w-]{10,64}$/),
      title: z.string().trim().max(300),
    }),
  )
  .max(200);

/** YouTube channel and playlist subscriptions, downloaded with yt-dlp into the YouTube folder. */
export async function youtubeRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const getChannel = (id: number) => {
    const c = ctx.db
      .select()
      .from(youtubeChannels)
      .where(eq(youtubeChannels.id, id))
      .get();
    if (!c) throw notFound("Channel not found");
    return c;
  };
  const channelUrl = (raw: string) => {
    const url = parseChannelUrl(raw);
    if (!url)
      throw badRequest(
        "Paste a YouTube channel (youtube.com/@name) or playlist link",
      );
    return url;
  };
  const failed = (err: unknown) =>
    new HttpError(502, `yt-dlp: ${(err as Error).message}`, "upstream");
  const view = (c: ChannelRow) => {
    const counts = Object.fromEntries(
      ctx.db
        .select({ status: youtubeVideos.status, n: sql<number>`count(*)` })
        .from(youtubeVideos)
        .where(eq(youtubeVideos.channelId, c.id))
        .groupBy(youtubeVideos.status)
        .all()
        .map((r) => [r.status, r.n]),
    );
    return {
      ...c,
      playlists: c.playlists ? JSON.parse(c.playlists) : [],
      counts,
    };
  };

  app.get(
    "/api/youtube/channels",
    { config: { access: "manager" } },
    async () =>
      ctx.db
        .select()
        .from(youtubeChannels)
        .orderBy(youtubeChannels.name)
        .all()
        .map(view),
  );

  app.post(
    "/api/youtube/playlists",
    { config: { access: "manager" } },
    async (req) => {
      const url = channelUrl(parse(urlBody, req.body).url);
      try {
        return { playlists: await channelPlaylists(ctx, url) };
      } catch (err) {
        throw failed(err);
      }
    },
  );

  app.post(
    "/api/youtube/channels",
    { config: { access: "manager" } },
    async (req) => {
      const body = parse(
        urlBody.extend({
          mode: z.enum(YOUTUBE_MODES).default("new"),
          playlists: playlists.default([]),
        }),
        req.body,
      );
      const url = channelUrl(body.url);
      if (body.mode === "playlists" && !body.playlists.length)
        throw badRequest("Pick at least one playlist");
      if (
        ctx.db
          .select()
          .from(youtubeChannels)
          .where(eq(youtubeChannels.url, url))
          .get()
      )
        throw conflict("Already subscribed to this channel");
      let row: ChannelRow;
      try {
        row = await addChannel(
          ctx,
          url,
          body.mode,
          body.playlists,
          req.user!.id,
        );
      } catch (err) {
        throw failed(err);
      }
      audit(ctx.db, req, "youtube.subscribed", {
        target: row.name,
        details: { url, mode: body.mode },
      });
      const result = view(row);
      void downloadWanted(ctx).catch(() => undefined);
      return result;
    },
  );

  app.patch(
    "/api/youtube/channels/:id",
    { config: { access: "manager" } },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const body = parse(
        z
          .object({
            mode: z.enum(YOUTUBE_MODES),
            playlists,
            enabled: z.boolean(),
          })
          .partial(),
        req.body,
      );
      const c = getChannel(id);
      const mode = body.mode ?? c.mode;
      const lists =
        body.playlists ?? (c.playlists ? JSON.parse(c.playlists) : []);
      if (mode === "playlists" && !lists.length)
        throw badRequest("Pick at least one playlist");
      const changes: Partial<ChannelRow> = {};
      if (body.enabled !== undefined) changes.enabled = body.enabled;
      if (body.mode || body.playlists)
        Object.assign(changes, {
          mode,
          playlists: mode === "playlists" ? JSON.stringify(lists) : null,
        });
      if (Object.keys(changes).length)
        ctx.db
          .update(youtubeChannels)
          .set(changes)
          .where(eq(youtubeChannels.id, id))
          .run();
      // Switching to "all" queues what was skipped when the channel was added.
      if (body.mode === "all" && c.mode !== "all")
        ctx.db
          .update(youtubeVideos)
          .set({ status: "wanted" })
          .where(
            and(
              eq(youtubeVideos.channelId, id),
              eq(youtubeVideos.status, "skipped"),
            ),
          )
          .run();
      audit(ctx.db, req, "youtube.updated", { target: c.name, details: body });
      if (body.mode || body.playlists)
        await checkChannel(ctx, getChannel(id)).catch(() => undefined);
      return view(getChannel(id));
    },
  );

  /** Unsubscribes. Downloaded videos stay in the YouTube folder. */
  app.delete(
    "/api/youtube/channels/:id",
    { config: { access: "manager" } },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const c = getChannel(id);
      ctx.db.delete(youtubeChannels).where(eq(youtubeChannels.id, id)).run();
      audit(ctx.db, req, "youtube.unsubscribed", { target: c.name });
      return { ok: true };
    },
  );

  app.post(
    "/api/youtube/channels/:id/check",
    { config: { access: "manager" } },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const c = getChannel(id);
      let added: number;
      try {
        added = await checkChannel(ctx, c);
      } catch (err) {
        throw failed(err);
      }
      audit(ctx.db, req, "youtube.checked", {
        target: c.name,
        details: { added },
      });
      void downloadWanted(ctx).catch(() => undefined);
      return { added };
    },
  );

  app.get(
    "/api/youtube/channels/:id/videos",
    { config: { access: "manager" } },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const q = parse(
        z.object({
          status: z
            .enum(["all", "wanted", "skipped", "downloading", "done", "failed"])
            .default("all"),
          page: z.coerce.number().int().min(1).default(1),
        }),
        req.query,
      );
      getChannel(id);
      const where = and(
        eq(youtubeVideos.channelId, id),
        q.status === "all" ? undefined : eq(youtubeVideos.status, q.status),
      );
      const total = ctx.db
        .select({ n: sql<number>`count(*)` })
        .from(youtubeVideos)
        .where(where)
        .get()!.n;
      const videos = ctx.db
        .select()
        .from(youtubeVideos)
        .where(where)
        .orderBy(desc(youtubeVideos.publishedAt), desc(youtubeVideos.id))
        .limit(100)
        .offset((q.page - 1) * 100)
        .all();
      return { total, videos };
    },
  );

  /** Queues one video: one skipped when the channel was added, or one that failed. */
  app.post(
    "/api/youtube/videos/:id/download",
    { config: { access: "manager" } },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const v = ctx.db
        .select()
        .from(youtubeVideos)
        .where(eq(youtubeVideos.id, id))
        .get();
      if (!v) throw notFound("Video not found");
      if (v.status === "downloading" || v.status === "done")
        throw conflict(`This video is already ${v.status}`);
      ctx.db
        .update(youtubeVideos)
        .set({ status: "wanted", error: null })
        .where(eq(youtubeVideos.id, id))
        .run();
      audit(ctx.db, req, "youtube.video_queued", { target: v.title });
      void downloadWanted(ctx).catch(() => undefined);
      return { ok: true };
    },
  );
}
