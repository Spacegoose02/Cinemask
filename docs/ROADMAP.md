# Cinemask: Roadmap

> **Status (0.9.0):** every phase (0 to 7) is built. Integrations are tested against simulated services; real-world testing comes next.

A self-hosted family media manager in the spirit of Sonarr, Radarr and Overseerr, built from the Kanban board (69 cards across six columns). Duplicate cards are merged, and each phase only depends on phases before it. Foundations and security come first, because every later feature hangs off users, roles, settings and the database.

**Board card count:** 69 cards → 56 roadmap items after merging duplicates.

---

## Phase 0: Project foundations

Everything else is built on this. No media features yet.

| Item | Board cards merged | Notes |
|---|---|---|
| Repo, CI, Docker image | Docker Container / Unraid Setup | Single container, `/config` volume for DB and settings, Unraid template (XML) from day one. CI runs tests, lint, dependency audit and image build on every PR. |
| Database and migrations | (implied by Back up database) | Versioned schema migrations so upgrades never need manual SQL. |
| Settings model, one place | Settings in one area with tabs | One Settings page with tabs (General, Users, Media Servers, Indexers, Download Clients, Metadata, Backups, Health). Stored in the DB, not scattered config files. |
| Docs for future contributors and agents | Good Documentation for next agents | `CLAUDE.md` / `CONTRIBUTING.md`, architecture notes, how to run locally. Kept current every phase. |

## Phase 1: Accounts, security and backups (the "Important To DO" column)

| Item | Board cards merged | Notes |
|---|---|---|
| Local accounts with strong security | User accounts, strong security | Argon2id password hashing, httpOnly + SameSite session cookies, CSRF protection, login rate limiting and lockout, first-run setup wizard that creates the owner (no default password). Every API route denies by default unless authenticated. |
| User levels and permissions | User Levels (Admin/Owner, Manager, User) | **Owner/Admin:** everything, including settings and API keys. **Manager:** auto and manual downloads, approve requests, manage posters and collections. **User:** request movies and shows only, requests need Manager or Admin approval. Enforced server-side on every endpoint, not just hidden in the UI. |
| OIDC single sign-on | OIDC Support with tinyauth and other providers | Generic OIDC (tinyauth, Authelia, Authentik, Keycloak, Pocket ID). Map OIDC groups to user levels. Optional "disable local login". |
| Plex sign-in | Plex Connect (sign-in half) | "Sign in with Plex" so family members use their Plex account; admin chooses which Plex users are allowed. |
| Admin-owned API keys and sources | API connections persist for all users; admin controls all sources | Secrets (TMDB, mdblist, indexers, download clients) are stored once, encrypted at rest, visible and editable only by the Owner. Users never see keys. |
| Database backup | Back up database | Scheduled consistent snapshots of DB + settings, retention policy, one-click restore, backup before every upgrade migration. |
| Remote backup | Allow remote backup support | Push backups to S3-compatible storage, SFTP or a mounted share (rclone-style targets). |
| Security baseline | Check for bugs, security issues | Audit log of admin actions, security headers, input validation on every endpoint, SSRF protection on outbound URLs, dependency scanning in CI. Repeated as a full review before each release. |

**Exit criteria:** an unauthenticated request cannot reach any data, a User cannot call a Manager endpoint, and a backup can be restored into a fresh container.

## Phase 2: Media servers and metadata

| Item | Board cards merged | Notes |
|---|---|---|
| Plex and Jellyfin connection | Connect with Plex & Jellyfin; Plex Connect (library half) | Server URL + token per server, set by Owner. |
| Library sync | Pulling info from Jellyfin & Plex (quality, what's on server); Ability to turn on file search sync | Periodic and on-demand scans of what exists and at what quality. |
| Metadata providers | API connections for TVDB, IMDB, TMDB; Api connection for mdblist (×2 cards) | TMDB as primary, TVDB for episode ordering, IMDB IDs for matching, mdblist for ratings and lists. |
| Media statuses | Statuses: On Server, Not on Server, Not Available | Drives every list, search result and calendar entry. |
| Release dates | Anticipated release date for streaming and physical | From TMDB release types. |
| Detail pages | Click into movie or TV for details and trailer | Overview, cast, seasons and episodes, status, trailer player. |
| Global search bar | Search in top bar showing library and new releases | Searches local library and TMDB together. |
| Sorting and filtering | Ability to sort by date released and others | Applies to library, discover and lists. |

## Phase 3: Requests and downloading (the core "arr" engine)

| Item | Board cards merged | Notes |
|---|---|---|
| Requests and approvals | User Levels (request flow) | Users request, Managers or Admins approve, approved requests become monitored items. Notifications to the requester. |
| Indexers | Ability to use Prowlarr; Manual search with Prowlarr (×2 cards); Connect with Usenet indexers (althub, DrunkenSlug) | Prowlarr sync first (covers most torrent and Usenet indexers), plus direct Newznab/Torznab for indexers outside Prowlarr. |
| Download clients | Downloads to qBittorrent, Deluge, Flood, rTorrent, Transmission, uTorrent | Build qBittorrent and Transmission first, then the rest behind a common interface. Usenet clients (SABnzbd, NZBGet) are needed for the Usenet indexers. uTorrent's API is limited and unmaintained, so it goes last. |
| Torrent tags / categories | Tags for torrent downloading for auto import | Tag every grab so completed downloads are matched back reliably. |
| Quality profiles | Quality Profiles (720p, 1080p, SD, UHD, any, 720p or above, 1080p or above) | Ordered allowed qualities with a cutoff. |
| Language preference | Choose by language only, affects release search | Part of the profile, filters releases. |
| Release monitoring and auto-download | Server should monitor releases and auto-download if requested; RSS sync; Media Downloader | RSS polling plus scheduled searches for monitored items. |
| Manual search | Manual search button on movie page; manually search individual episodes or movie | Interactive release picker per movie, season or episode. |
| Episode detection | Detect correct episodes when downloading | Robust release name parsing (season packs, absolute numbering, daily shows). |
| Import pipeline | Paths: download to /downloads, move to /media (user choice) | Configurable paths, hardlink when on the same disk (important on Unraid), copy otherwise. |
| Naming formats | Formats like `Season 1 - Expedition Unknown - S01E01 - Tigers fighting` | Token-based templates for folders and files. |
| Profile change upgrades | If quality profile changes, offer to search for upgrades | Prompt, search, and leave files untouched if nothing better is found. |
| Downloads tab | Downloads should show total downloading on tab | Queue view with a live count badge. |
| Direct URL downloads | Direct url download manager | Restricted to Manager and above, with SSRF protection. |
| Cloudflare-protected indexers | Cloudflare Bypass | Integrate with FlareSolverr (as Prowlarr does) rather than building a bypass in-app. |

## Phase 4: Library management

| Item | Board cards merged | Notes |
|---|---|---|
| File management | Manage files: rename show, rename episodes, delete, manual search; Delete Episodes; Delete whole seasons; Delete Movies | Rename preview, delete with confirmation, optional "unmonitor after delete". Manager and above only. |
| Health checks | Health section in settings (server status, failed movies and shows) | Connection checks for every integration, failed imports, disk space. |
| Calendar | Calendar of upcoming shows and movies with details and trailer; Compact shows with multiple episodes (e.g. "Expedition Unknown +5") | Month, week and agenda views, grouped episodes. |

## Phase 5: Discovery, collections and homepage

| Item | Board cards merged | Notes |
|---|---|---|
| Discover | Advanced Discover section (extensive filters, channels and networks) | Filter by genre, network, streaming service, year, rating, language. |
| Lists import | Import lists from Yamtrack and other free sources; mdblist lists | Scheduled list sync that can auto-request. |
| Homepage | Homepage more of a featured page with collections; Popular / trending lists on the front page | Featured rows, trending, recently added. |
| Per-user homepage | Customize homepage per user with collections, popular lists or custom lists | Each user picks and orders their rows. |
| Collections manager | Collection Maker and Manager that syncs Plex and Jellyfin collections; Use tags to work with Plex collections; Collections show poster covers from Plex or Jellyfin | Build collections in-app, push to both servers. |
| Posters | Change movie poster for Plex and Jellyfin; ThePosterDB scraper | Pick from TMDB, ThePosterDB or upload, push to servers. |
| Trailers | Trailer management: download from YouTube and others, higher-quality search, remove; Download trailer to media folder | Saves as `Movie Name-trailer.ext` so Plex and Jellyfin pick it up. |

## Phase 6: Books, audiobooks and podcasts

| Item | Board cards merged | Notes |
|---|---|---|
| Audiobookshelf integration | Podcast & Audiobook management with AudioBookShelf | The media server equivalent for this media type. |
| Audiobook downloads | Audiobook Downloads & Management | Reuses the Phase 3 indexer and download engine. |
| Books | Download & Search books using Shelfmark | |
| Lists | Audiobook and Podcast lists | |

## Phase 7: Polish, integrations and release

| Item | Board cards merged | Notes |
|---|---|---|
| Name and branding | Come up with name and design symbolizing entertainment & raccoons; Branding and screenshots | Name, raccoon logo, screenshots for README and Unraid Community Apps. Name can be picked earlier since it's needed for the repo. |
| Themes | Dark, Light, Retro, Futuristic, 16-bit themes | Theme tokens from Phase 0 make this cheap. Dark first. |
| Mobile web | Mobile web support | Responsive from the start, then a dedicated pass plus PWA install. |
| Public API | Create API so other services can connect, with documentation | Per-user API keys scoped by user level, OpenAPI docs. The internal API is already built this way, so this is mostly exposing and documenting it. |
| Home Assistant | HomeAssistant plugin | Built on the public API (sensors for queue, upcoming, requests). |
| GitHub docs | Good Documentation for GitHub | Install guide (Docker, Unraid), configuration, reverse proxy and OIDC examples. |
| Release | Prepare release for GitHub | Versioned images on GHCR, changelog, Unraid template submission. Final security review (Phase 1 checklist repeated). |

---

## Duplicates merged

| Topic | Cards on the board |
|---|---|
| Prowlarr | "Ability to use Prowlarr", "Manual search with Prowlarr" |
| mdblist | "Api connection for mdblist", "api connections to mdblist, tmdb… persist for all users" |
| Plex | "Connect with Plex & Jellyfin", "Plex Connect" |
| Deleting media | "Delete Episodes", "Delete whole seasons", "Delete Movies", "Manage files… delete episodes" |
| Manual search | "Add Button to manually search…", "Manage files… manually search individual episodes", "Manual search with Prowlarr" |
| Trailers | "Add Trailer management", "click into movie… watch trailer, or download trailer", calendar "way to watch the trailer" |
| Calendar | "Calendar to see when shows & movies…", "Ability to compact shows…" |
| Homepage | "Homepage more of a featured…", "Popular/Trending lists…", "Customize homepage per user" |
| Collections | "Collection Maker and Manager", "Collections section… poster covers", "Use Tags to work with Plex Collections" |
| Documentation | "Good Documentation for next agents", "Good Documentation for github", "Create API… with documentation" |
| Branding | "Come up with name and design…", "Branding and screenshots" |
| Audio and books | "Audiobook Downloads & Management", "Podcast & Audiobook management with AudioBookShelf", "Audiobook and Podcast lists", "Download & Search books using Shelfmark" |
| Downloading | "Media Downloader", "The Server should monitor releases… auto download", "RSS sync" |

## Proposed tech stack (if starting a new repo)

Chosen for a single Docker container that runs well on Unraid with one `/config` volume.

- **Backend:** TypeScript on Node.js with Fastify, schema-validated routes (zod) so every input is checked.
- **Frontend:** React + Vite + TanStack Query, Tailwind with theme tokens (makes the themes card cheap later).
- **Database:** SQLite (WAL mode) via Drizzle ORM with migrations. Fits the household scale, and backups are a single consistent file (`VACUUM INTO`). Postgres can be added later if needed.
- **Auth:** Argon2id, server-side sessions in httpOnly cookies, `openid-client` for OIDC, Plex PIN-based sign-in.
- **Background jobs:** in-process scheduler with jobs persisted in the DB (RSS sync, library scans, backups).
- **Packaging:** multi-stage Dockerfile, non-root user with `PUID`/`PGID`, healthcheck, Unraid template XML, images on GHCR.
- **Quality gates:** Vitest unit tests, Playwright end-to-end for login and permissions, ESLint, `npm audit` and CodeQL in GitHub Actions.
