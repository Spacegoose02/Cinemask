<p align="center"><img src="docs/logo.png" alt="Cinemask" width="260" /></p>

# Cinemask

A self-hosted media manager for families running Plex or Jellyfin. It does what Sonarr, Radarr and Overseerr do, plus books and audiobooks, in one app with real user accounts, single sign-on and backups.

> **Status:** beta (0.10). Every phase of the [roadmap](docs/ROADMAP.md) is built and covered by automated tests. The integrations with Plex, Jellyfin, TMDB, indexers, download clients, Audiobookshelf and Shelfmark are tested against simulated services; please [report anything](https://github.com/Spacegoose02/cinemask/issues) that behaves differently with the real thing.

## Features

**For the family**
- Search, browse and **request** movies and shows, see what's already on Plex or Jellyfin, and follow your requests.
- **Discover** by genre, network, streaming service, year, rating and language, with trending and popular rows.
- A personal **home page** with rows you choose, a **calendar** of upcoming releases, **collections** and **lists**.
- **Books**: request audiobooks and ebooks, browse your Audiobookshelf library, and find podcasts.
- 31 **themes** (five each of Dark, Light, Retro, Futuristic, 16-bit and Cinemas, plus Blockbuster) and a phone-friendly layout you can install to your home screen.

**For whoever runs it**
- **Downloads** like Sonarr and Radarr: indexers (or Prowlarr), quality profiles, automatic and manual search, RSS, nine download clients, renaming, hardlinked imports, failed-download retries and a blocklist.
- **Library management**: rescan, rename, delete files or seasons, per-episode monitoring, posters and trailers pushed to Plex and Jellyfin.
- **Collections** synced to Plex and Jellyfin, from TMDB collections, lists or by hand.
- **Lists** from mdblist, TMDB, saved Discover searches and CSV exports (Yamtrack, IMDb, Letterboxd), with optional auto-download.
- **Books**: downloads through Shelfmark or your indexers, imported into Audiobookshelf's folder layout.
- **Health** checks for every connection, disk space, hardlinks, failed downloads and backups.
- An **API** with per-user keys, an OpenAPI description, and **Home Assistant** sensors and webhooks.

**Security first**
- Three roles (User, Manager, Admin) checked on every request, deny by default.
- Passwords hashed with Argon2id, account lockout, rate-limited sign-in, CSRF protection, strict Content Security Policy.
- Single sign-on with any OpenID Connect provider (Authelia, Authentik, Pocket ID, Keycloak, …) and Sign in with Plex.
- Integration secrets encrypted at rest and never sent to the browser. Every file operation is confined to your media folders.
- Automatic, optionally encrypted backups with off-server copies, and a backup before every upgrade.

See [SECURITY.md](SECURITY.md) for the full model.

## Install

```yaml
services:
  cinemask:
    image: ghcr.io/spacegoose02/cinemask:latest
    restart: unless-stopped
    ports: ["7979:7979"]
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=America/New_York
    volumes:
      - ./config:/config
      - /srv/data/downloads:/downloads
      - /srv/data/media:/media
```

Open `http://<server>:7979` and create the owner account. On Unraid, add the template `https://raw.githubusercontent.com/Spacegoose02/cinemask/main/unraid/cinemask.xml`.

**Guides:** [Install and first run](docs/install.md) · [Reverse proxy](docs/reverse-proxy.md) · [Single sign-on](docs/sso.md) · [Home Assistant](docs/home-assistant.md) · [API](docs/api.md) · [Unraid](docs/unraid.md) · [Changelog](CHANGELOG.md)

## Development

```bash
npm install
npm run dev        # API on :7979, UI on :5173 with hot reload
npm test           # API, security and integration tests
npm run lint
npm run typecheck
```

See [CLAUDE.md](CLAUDE.md) for architecture and conventions.

## Releasing

Update [CHANGELOG.md](CHANGELOG.md) and the version in `package.json`, then push a tag like `v0.10.0` (no dot after the `v`). The release workflow runs the tests, publishes `ghcr.io/spacegoose02/cinemask` as `0.10.0`, `0.10` and `latest` for amd64 and arm64, and creates the GitHub release from the changelog.

