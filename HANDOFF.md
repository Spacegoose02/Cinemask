# Handoff

Where Cinemask stands and how to pick the work up. Read [CLAUDE.md](CLAUDE.md) first for the layout and the security rules, and keep this file current when you finish a piece of work.

## State

- **Released:** 0.9.0, the first public beta (its tag was `v.0.9.0`, so the release workflow failed and no image was published). 0.10.0 carries the to-do board below. Every phase in [docs/ROADMAP.md](docs/ROADMAP.md) is built.
- **Tests:** `npm test` runs the API, security and integration tests. Integrations (Plex, Jellyfin, TMDB, indexers, download clients, Audiobookshelf, Shelfmark) are only tested against fakes in `test/fakes.ts`, so expect fixes once they meet real servers.
- **CI:** `.github/workflows/ci.yml` (lint, typecheck, tests, build, audit, image to `ghcr.io/<owner>/cinemask:edge`), `codeql.yml`, and `release.yml` on tags `vX.Y.Z` (tests, tag must match `package.json`, multi-arch image, GitHub release from the changelog). A release created on GitHub's Releases page works too.

## 0.10: the to-do board

The second board (35 cards) shipped in 0.10.0. 14 cards were already done in 0.9.

| PR | Cards | Status |
|---|---|---|
| 1. Fixes | YouTube trailer error, turn off CAM/TS copies, download totals on the Downloads tab, collection button for Plex and Jellyfin, Handoff.md, bug and security check | PR #10 |
| 2. Folders and sizes | Custom root folders (Kids Movies, 4K…), download tag per media path, size limits for movies and per show, download from a link with a name and destination, auto-monitor what the library sync finds | PR #13 (with PR 3) |
| 3. Library | Watch trailers already on the server, trailer management (auto, sources, quality), manually map media, watched / play count, Plex labels with collections | PR #13 |
| 4. YouTube and ReadMeABook | Subscribe to channels (new, all, playlists), metadata for Plex and Jellyfin, audiobooks through ReadMeABook | PR #15 (with PR 5) |
| 5. Themes | Five themes in each style (dark, light, retro, futuristic, 16-bit, cinemas) plus Blockbuster | PR #15 |

Already done in 0.9 (no work needed): delete episodes, seasons and movies; download or manually search one episode; manual search on a movie; collection maker synced to Plex and Jellyfin; download and import paths; Shelfmark search and download; rename and manage files; ask to search for upgrades after a profile change; Prowlarr search; change posters on Plex and Jellyfin; upgrades.

## Known gaps

- Specials (season 0) are not added to monitored episodes, so the per-episode tools can't act on them.
- Removing a download with "Blocklist and retry" marks it `removed` in history although a retry search runs.

## How the newer pieces fit

- **Root folders** (`arr/roots.ts`): the main Movies/TV folders are id `default`; extra ones live in `media.extraFolders`. `monitored.root_id` picks one; `rootFor()` in `files/service.ts` is the root every path check uses. `moveToRoot()` moves a title's folder.
- **Size limits**: `decide()` marks `oversize` instead of rejecting; `byPreference()` sorts within-limit first. Limits come from `downloading.maxMovieSizeGb/maxEpisodeSizeGb` or `monitored.max_size_mb`.
- **Link downloads** (`arr/direct.ts`): `downloads.destination` holds `{key, name}`; `deliverLink()` places the finished file or folder.
- **Local trailers** (`trailers/routes.ts`): `GET /api/trailers/:kind/:tmdbId` lists trailer files in the title's folder and `/:index` streams one with range support. `parseVideoUrl()` accepts YouTube and Vimeo links only.
- **Match fixes**: `match_overrides` (server + item key → TMDB id) is applied by `store()` in `library/service.ts` on every sync. Monitored titles and book requests are fixed in place (`/api/monitored/:id/match`, `/api/books/:id/match`).
- **Watched**: `view_count`/`last_viewed_at` on library items and episodes. A show's count is its least-played episode, so it counts as watched once every episode is. Jellyfin reads plays as the first admin user.
- **Labels**: `library_items.labels` holds Plex labels / Jellyfin tags. `collections.from_label` fills a collection from them; `collections.plex_label` is put on (and taken off) Plex items on each push.
- **YouTube** (`youtube/`): `youtube_channels` and `youtube_videos`. `parseChannelUrl()` only lets youtube.com channel and playlist links through; video and playlist ids are checked before reaching yt-dlp, always after `--`. Checks run hourly for channels that are due; `downloadWanted()` drains the queue every 5 minutes (calls are serialised). Everything is written inside `extras.youtubePath` via `insideRoot()`. A channel with `pick` records every video (and new uploads) as `skipped`; `POST /api/youtube/videos/download {ids}` queues the picked ones.
- **ReadMeABook** (`integrations/readmeabook.ts`): uses its API-token endpoints (`/api/audiobooks/search`, `POST /api/requests`, `GET /api/requests/:id`). Books handed over have `external_id` `readmeabook:<id>`; `pollReadMeABook()` follows them every 2 minutes. An HTTP 409 (already requested or in the library) is accepted and left for the Audiobookshelf sync to mark ready.
- **Themes**: `THEME_LIST` in `web/lib/theme.ts` (id, style, swatch colours) is the list; each theme's colours are a `[data-theme]` block in `styles.css`, and shared touches per style hang off `[data-style]`. Add new ones to `THEME_NAMES` in `auth/apikey-routes.ts` too; `test/themes.test.ts` checks all three agree.
- **Auto-monitor** (`monitorLibrary()` in `arr/monitor.ts`) runs after each library sync, 50 titles per run; `monitor_exclusions` remembers titles removed by hand.

## Working here

- Run `npm install`, then `npm run dev` (API on 7979, UI on 5173), `npm test`, `npm run lint`, `npm run typecheck`.
- Every schema change gets a new migration in `src/server/db/migrations.ts`; never edit a released one.
- Every `/api` route declares `config.access`; `test/access.test.ts` calls every route at every level.
- Changes go through pull requests to `main`; note user-facing changes under `[Unreleased]` in `CHANGELOG.md`.
