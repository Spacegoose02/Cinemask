# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- The Downloads queue shows totals (how many, total size, what's left, speed and time left), and each download shows its speed and time left.
- CAM, telesync, telecine and screener copies are skipped by default (Settings → Media management → Searching).
- "Add … to Plex/Jellyfin" on a movie adds its film series as a collection on whichever servers are connected and pushes it straight away.
- `HANDOFF.md`: where the project stands and how to pick it up.
- More root folders (Kids Movies, Kids TV, 4K…) in Settings → Media management, each with its own download-client category. Pick the folder when downloading; moving a title to another folder moves its files.
- Size limits for movies and episodes, with a per-title override. Releases within the limit win; a bigger one is only grabbed when nothing smaller exists, and the download is marked with a warning (also sent as the `download.warning` webhook event).
- Download from a link: magnet and .torrent links go to the torrent client, and any link can be given a name and a folder to land in when it finishes.
- Library sync can monitor what it finds (Settings → Media servers): new episodes only (default), everything, or nothing. Titles removed by hand stay removed.
- Trailers already in a title's folder play on its page. The trailer manager plays them, replaces them with the best online trailer, takes a pasted YouTube or Vimeo link, and automatic trailers now cover shows too.
- Fix a wrong match by hand: on a library item, a monitored title (Files → Fix match) or a book request. Library fixes are remembered through later syncs.
- Watched status and play counts from Plex and Jellyfin: a Watched badge and filter in the Library, plays on the title page, and per-episode marks.
- Collections can fill themselves from a Plex label or Jellyfin tag, and can put a label on their items in Plex for smart collections and sharing restrictions.
- YouTube channel subscriptions (YouTube in the menu, for managers): new videos only, every video, or chosen playlists. Videos are saved as `Channel/Season YYYY/Channel - YYYY-MM-DD - Title [id].mkv` with a thumbnail, an episode `.nfo` and a `tvshow.nfo`, so Plex and Jellyfin show each channel as a series. Folder, quality and how often to check are in Settings → Media management.
- ReadMeABook: approved audiobook requests can be sent to ReadMeABook (Settings → Books), which downloads and imports them; Cinemask follows each request and marks it ready.
- 26 new themes, for 31 in all: five each in Dark, Light, Retro, Futuristic, 16-bit and the new Cinemas style, plus Blockbuster. The theme picker (Account) groups them by style.

### Fixed
- Status badges were hard to read on light themes (black text on dark green).
- YouTube trailers showed "Video player configuration error": the app told browsers to send no referrer, which YouTube now refuses.
- A manual search result can only be grabbed for the title it was found for, with the episodes it was judged to cover.
- Manual search of a season with nothing missing judged every release against episode 1 only.
- The yt-dlp setting only runs a program named `yt-dlp`, so it can't be pointed at another program in the container.

## [0.9.0] - 2026-10-20

The first public beta. Every phase of the roadmap is in.

### Accounts and security
- First-run owner setup with no default password; User, Manager and Admin roles checked on every request.
- Password sign-in (Argon2id, lockout, rate limits), single sign-on with any OpenID Connect provider, and Sign in with Plex.
- Encrypted integration secrets, CSRF protection, strict Content Security Policy, and an activity log.
- Personal API keys (read-only or full, optional expiry) that act as their owner and never reach account, settings or user management.

### Backups
- Nightly and on-demand backups, a backup before every upgrade and restore, optional passphrase encryption, and copies to a folder or S3-compatible storage.

### Library, requests and downloads
- Plex and Jellyfin library sync, TMDB metadata, search and requests with approval.
- Indexers (Newznab, Torznab, Prowlarr sync), quality profiles, automatic and manual search, RSS, and nine download clients.
- Imports with hardlinks, renaming, remote path mappings, failed-download retries and a blocklist.
- File management: rescan, rename, delete, per-season and per-episode monitoring.
- A release calendar and health checks for every connection, disk space, hardlinks and backups.

### Discovery and collections
- Discover with filters, trending and popular rows, and a customizable home page.
- Lists from mdblist, TMDB, saved searches and CSV exports (Yamtrack, IMDb, Letterboxd), with optional auto-download.
- Collections synced to Plex and Jellyfin, poster changes pushed to servers, and trailer downloads with yt-dlp.

### Books, audiobooks and podcasts
- Audiobookshelf integration: library view, cover proxy, rescans after imports, podcast subscriptions.
- Book and audiobook requests with Open Library metadata, downloads through Shelfmark or indexers, imports as `Author/Title (Year)`.

### Polish and integrations
- Five themes (Dark, Light, Retro, Futuristic, 16-bit), saved per account, and a phone-friendly layout installable as an app.
- OpenAPI description and an in-app API reference.
- Home Assistant: `/api/stats` for sensors and webhook events for automations.
- Docker image for amd64 and arm64, and an Unraid template.

[Unreleased]: https://github.com/Spacegoose02/cinemask/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/Spacegoose02/cinemask/releases/tag/v0.9.0
