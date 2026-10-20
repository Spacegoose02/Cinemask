# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
