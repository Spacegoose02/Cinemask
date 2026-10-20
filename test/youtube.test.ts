import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  downloadWanted,
  parseChannelUrl,
} from "../src/server/youtube/service.js";
import { Client, createUser, makeApp, setupOwner } from "./helpers.js";

// A stand-in for yt-dlp: lists a channel, its playlists and a playlist, describes a video, and
// "downloads" by writing the file named by -o. A file named new-video next to it adds a fresh upload.
const FAKE = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2); const target = args[args.length - 1];
fs.appendFileSync(path.join(__dirname, 'calls.log'), JSON.stringify(args) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o));
if (args.includes('--flat-playlist')) {
  if (target.endsWith('/playlists')) out({ entries: [{ id: 'PLsongs00001', title: 'Songs' }, { id: 'bad id!', title: 'Nope' }] });
  else if (target.includes('playlist?list=')) out({ id: 'PLsongs00001', title: 'Songs', entries: [{ id: 'song0000001', title: 'Theme Song' }] });
  else {
    const entries = [{ id: 'video000002', title: 'Second' }, { id: 'video000001', title: 'First' }, { id: '--exec=rm', title: 'Evil' }];
    if (fs.existsSync(path.join(__dirname, 'new-video'))) entries.unshift({ id: 'video000003', title: 'Third' });
    out({ id: 'UCaaaaaaaaaaaaaaaaaaaaaa', channel: 'Bluey: Official', channel_id: 'UCaaaaaaaaaaaaaaaaaaaaaa', description: 'Dogs & games', entries });
  }
} else if (args.includes('--skip-download')) {
  const id = new URL(target).searchParams.get('v');
  out({ id, title: 'Episode <' + id + '>', description: 'About ' + id, upload_date: '20240315', duration: 420 });
} else {
  const o = args[args.indexOf('-o') + 1];
  fs.writeFileSync(o.replace('%(ext)s', 'mkv'), 'video');
  fs.writeFileSync(o.replace('%(ext)s', 'jpg'), 'thumb');
}
`;

let t: Awaited<ReturnType<typeof makeApp>>;
let owner: Client;
let yt: string;
let bin: string;
beforeEach(async () => {
  t = await makeApp();
  owner = await setupOwner(t.app);
  yt = path.join(t.dir, "youtube");
  const binDir = path.join(t.dir, "bin");
  fs.mkdirSync(binDir);
  bin = path.join(binDir, "yt-dlp");
  fs.writeFileSync(bin, FAKE, { mode: 0o755 });
  // Plain .js so node treats the stand-in as CommonJS.
  fs.writeFileSync(path.join(binDir, "package.json"), '{"type":"commonjs"}');
  await owner.req("PUT", "/api/settings/extras", {
    ytDlpPath: bin,
    youtubePath: yt,
  });
});
afterEach(async () => t.close());

const calls = () =>
  fs
    .readFileSync(path.join(path.dirname(bin), "calls.log"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as string[]);

describe("YouTube links", () => {
  it("accepts only YouTube channels and playlists", () => {
    expect(
      parseChannelUrl("https://www.youtube.com/@BlueyOfficialChannel/videos"),
    ).toBe("https://www.youtube.com/@BlueyOfficialChannel");
    expect(
      parseChannelUrl("https://m.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa"),
    ).toBe("https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa");
    expect(
      parseChannelUrl("https://youtube.com/playlist?list=PLsongs00001"),
    ).toBe("https://www.youtube.com/playlist?list=PLsongs00001");
    expect(
      parseChannelUrl("https://www.youtube.com/watch?v=video000001"),
    ).toBeNull();
    expect(parseChannelUrl("https://evil.example/@someone")).toBeNull();
    expect(parseChannelUrl("https://www.youtube.com/@x; rm -rf /")).toBeNull();
    expect(parseChannelUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("YouTube subscriptions", () => {
  it("follows new uploads only, and writes Plex/Jellyfin-friendly files and metadata", async () => {
    const res = await owner.req("POST", "/api/youtube/channels", {
      url: "https://www.youtube.com/@bluey",
      mode: "new",
    });
    expect(res.json()).toMatchObject({
      name: "Bluey: Official",
      mode: "new",
      counts: { skipped: 2 },
    });
    const id = res.json().id;
    expect(
      fs.readFileSync(path.join(yt, "Bluey - Official", "tvshow.nfo"), "utf8"),
    ).toContain("<plot>Dogs &amp; games</plot>");

    // A new upload appears: the next check queues it and the queue downloads it.
    fs.writeFileSync(path.join(path.dirname(bin), "new-video"), "");
    expect(
      (await owner.req("POST", `/api/youtube/channels/${id}/check`)).json(),
    ).toEqual({ added: 1 });
    await downloadWanted(t.app.ctx);
    const videos = (
      await owner.req("GET", `/api/youtube/channels/${id}/videos?status=done`)
    ).json().videos;
    expect(videos).toHaveLength(1);
    const season = path.join(yt, "Bluey - Official", "Season 2024");
    expect(fs.readdirSync(season).sort()).toEqual([
      "Bluey - Official - 2024-03-15 - Episode video000003 [video000003].jpg",
      "Bluey - Official - 2024-03-15 - Episode video000003 [video000003].mkv",
      "Bluey - Official - 2024-03-15 - Episode video000003 [video000003].nfo",
    ]);
    const nfo = fs.readFileSync(
      path.join(
        season,
        "Bluey - Official - 2024-03-15 - Episode video000003 [video000003].nfo",
      ),
      "utf8",
    );
    expect(nfo).toContain("<title>Episode &lt;video000003&gt;</title>");
    expect(nfo).toContain("<aired>2024-03-15</aired>");
    // Arguments go after "--", never through a shell, and odd ids from the listing are dropped.
    expect(calls().every((a) => a[a.length - 2] === "--")).toBe(true);
    expect(JSON.stringify(calls())).not.toContain("--exec");
  });

  it("downloads a whole channel, or picked playlists", async () => {
    const all = (
      await owner.req("POST", "/api/youtube/channels", {
        url: "https://www.youtube.com/@bluey",
        mode: "all",
      })
    ).json();
    expect(all.counts).toEqual({ wanted: 2 });
    const lists = (
      await owner.req("POST", "/api/youtube/playlists", {
        url: "https://www.youtube.com/@other",
      })
    ).json();
    expect(lists).toEqual({
      playlists: [{ id: "PLsongs00001", title: "Songs" }],
    });
    const pl = (
      await owner.req("POST", "/api/youtube/channels", {
        url: "https://www.youtube.com/@other",
        mode: "playlists",
        playlists: lists.playlists,
      })
    ).json();
    expect(pl.counts).toEqual({ wanted: 1 });
    expect(
      (
        await owner.req("POST", "/api/youtube/channels", {
          url: "https://www.youtube.com/@third",
          mode: "playlists",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await owner.req("POST", "/api/youtube/channels", {
          url: "https://www.youtube.com/@bluey",
        })
      ).statusCode,
    ).toBe(409);

    expect(await downloadWanted(t.app.ctx)).toBe(0); // the three were already fetched in the background
    expect(
      (
        await owner.req(
          "GET",
          `/api/youtube/channels/${all.id}/videos?status=done`,
        )
      ).json().total,
    ).toBe(2);

    // Paused channels don't download.
    await owner.req("PATCH", `/api/youtube/channels/${all.id}`, {
      enabled: false,
    });
    fs.writeFileSync(path.join(path.dirname(bin), "new-video"), "");
    await owner.req("POST", `/api/youtube/channels/${all.id}/check`);
    expect(await downloadWanted(t.app.ctx)).toBe(0);
    await owner.req("PATCH", `/api/youtube/channels/${all.id}`, {
      enabled: true,
    });
    expect(await downloadWanted(t.app.ctx)).toBe(1);

    await owner.req("DELETE", `/api/youtube/channels/${all.id}`);
    expect(
      (await owner.req("GET", "/api/youtube/channels")).json(),
    ).toHaveLength(1);
    expect(fs.existsSync(path.join(yt, "Bluey - Official"))).toBe(true); // files stay
  });

  it("switching to all queues what was skipped, and a skipped video can be fetched on its own", async () => {
    const ch = (
      await owner.req("POST", "/api/youtube/channels", {
        url: "https://www.youtube.com/@bluey",
      })
    ).json();
    await downloadWanted(t.app.ctx);
    const skipped = (
      await owner.req(
        "GET",
        `/api/youtube/channels/${ch.id}/videos?status=skipped`,
      )
    ).json().videos;
    await owner.req("POST", `/api/youtube/videos/${skipped[0].id}/download`);
    await downloadWanted(t.app.ctx);
    expect(
      (
        await owner.req(
          "GET",
          `/api/youtube/channels/${ch.id}/videos?status=done`,
        )
      ).json().total,
    ).toBe(1);
    expect(
      (
        await owner.req("PATCH", `/api/youtube/channels/${ch.id}`, {
          mode: "all",
        })
      ).json().counts,
    ).toEqual({ done: 1, wanted: 1 });
  });

  it("pick mode lists everything, downloads only what is ticked, and leaves new uploads to pick", async () => {
    const res = await owner.req("POST", "/api/youtube/channels", {
      url: "https://www.youtube.com/@bluey",
      mode: "all",
      pick: true,
    });
    expect(res.json()).toMatchObject({ pick: true, counts: { skipped: 2 } });
    const id = res.json().id;
    const list = (
      await owner.req("GET", `/api/youtube/channels/${id}/videos?q=sec`)
    ).json();
    expect(list.videos.map((v: { title: string }) => v.title)).toEqual(["Second"]);

    fs.writeFileSync(path.join(path.dirname(bin), "new-video"), "");
    await owner.req("POST", `/api/youtube/channels/${id}/check`);
    const all = (
      await owner.req("GET", `/api/youtube/channels/${id}/videos`)
    ).json().videos as { id: number; title: string; status: string }[];
    expect(all.every((v) => v.status === "skipped")).toBe(true);

    const second = all.find((v) => v.title === "Second")!;
    const third = all.find((v) => v.title === "Third")!;
    const kid = new Client(t.app);
    const u = await createUser(owner, "kid", "user");
    await kid.login("kid", u.password);
    expect(
      (await kid.req("POST", "/api/youtube/videos/download", { ids: [second.id] })).statusCode,
    ).toBe(403);
    expect(
      (await owner.req("POST", "/api/youtube/videos/download", { ids: [] })).statusCode,
    ).toBe(400);
    expect(
      (
        await owner.req("POST", "/api/youtube/videos/download", {
          ids: [second.id, third.id],
        })
      ).json(),
    ).toEqual({ queued: 2 });
    await downloadWanted(t.app.ctx);
    const done = (
      await owner.req("GET", `/api/youtube/channels/${id}/videos?status=done`)
    ).json();
    expect(done.total).toBe(2);
    // Already downloaded videos aren't queued again.
    expect(
      (
        await owner.req("POST", "/api/youtube/videos/download", {
          ids: [second.id],
        })
      ).json(),
    ).toEqual({ queued: 0 });
  });

  it("is for managers, and reports a misconfigured yt-dlp", async () => {
    const u = await createUser(owner, "kid", "user");
    const kid = new Client(t.app);
    await kid.login("kid", u.password);
    expect((await kid.req("GET", "/api/youtube/channels")).statusCode).toBe(
      403,
    );
    expect(
      (
        await kid.req("POST", "/api/youtube/channels", {
          url: "https://www.youtube.com/@bluey",
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await owner.req("POST", "/api/youtube/channels", {
          url: "https://example.com/@bluey",
        })
      ).statusCode,
    ).toBe(400);
    await owner.req("PUT", "/api/settings/extras", { ytDlpPath: "/bin/sh" });
    const res = await owner.req("POST", "/api/youtube/channels", {
      url: "https://www.youtube.com/@bluey",
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/named yt-dlp/);
  });
});
