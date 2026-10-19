<p align="center"><img src="docs/logo.png" alt="Cinemask" width="260" /></p>

# Cinemask

A self-hosted media manager for families running Plex or Jellyfin, in the spirit of Sonarr, Radarr and Overseerr, in one app with real user accounts.

> **Status:** early development. Phase 0 and 1 (foundations, accounts, security and backups) are built. See [docs/ROADMAP.md](docs/ROADMAP.md) for what's next.

## What works today

- **First-run setup** creates the owner account. There is no default password.
- **User levels:** Admin (the owner is the first admin), Manager and User, enforced on every API call.
- **Sign-in:** username and password (Argon2id), single sign-on with any OpenID Connect provider (tinyauth, Authelia, Authentik, Keycloak, Pocket ID), and Sign in with Plex.
- **One Settings page** with tabs. API keys and passwords for integrations are encrypted at rest and only admins can change them. They are never sent back to the browser.
- **Backups:** nightly by default, on demand, before every upgrade and before every restore. They can be encrypted with a passphrase and copied to another folder or S3-compatible storage. Restore from the list or from an uploaded file.
- **Activity log** of sign-ins, user changes, settings changes and backups.

## Install

### Unraid

Add the template from `unraid/cinemask.xml` (Docker tab, Add Container, Template URL), or use the settings below:

| Setting | Value |
|---|---|
| Repository | `ghcr.io/spacegoose02/cinemask:latest` |
| Port | `7979` |
| `/config` | `/mnt/user/appdata/cinemask` |
| `PUID` / `PGID` | `99` / `100` |

### Docker Compose

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
```

Open `http://<server>:7979` and create the owner account.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `7979` | Web port |
| `PUID` / `PGID` | `99` / `100` | User the app runs as |
| `TZ` | UTC | Time zone for schedules |
| `TRUST_PROXY` | `false` | Set `true` only behind a reverse proxy, so sign-in rate limits see real client IPs |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## Single sign-on

1. In **Settings → General**, set the public URL (for example `https://media.example.com`).
2. In your provider, create a client with redirect URL `https://media.example.com/api/auth/oidc/callback`.
3. In **Settings → Sign-in**, enter the issuer URL, client ID and secret.
4. Optionally map provider groups to Admin and Manager, and limit sign-in to an allowed group.

New SSO accounts can start as User or Manager, never Admin. Admin comes only from the owner or an admin group mapping. The owner can always sign in with a password, so a broken SSO setup can't lock you out.

## Backups

Backups live in `/config/backups`. Each archive holds the database and the instance key (`secret.key`) that decrypts stored API keys, so treat backup files like passwords. Set a passphrase in **Settings → Backups** before copying backups off the server.

## Development

```bash
npm install
npm run dev        # API on :7979, UI on :5173 with hot reload
npm test           # API and security tests
npm run lint
npm run typecheck
```

See [CLAUDE.md](CLAUDE.md) for architecture and conventions, and [SECURITY.md](SECURITY.md) for the security model.
