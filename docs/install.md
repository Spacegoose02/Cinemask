# Installing Cinemask

Cinemask ships as one Docker image: `ghcr.io/spacegoose02/cinemask`. It listens on port 7979 and keeps everything it owns in `/config`.

## Image tags

| Tag | What it is |
|---|---|
| `latest` | The newest release. Use this. |
| `0.9.0`, `0.9` | A specific release, for pinning. |
| `edge` | Built from every commit to `main`. May break. |

Images are built for `linux/amd64` and `linux/arm64`.

## Folder layout (read this first)

Cinemask imports finished downloads into your library. When the download folder and the library are on the **same disk or share**, it uses hardlinks, so a torrent keeps seeding without using any extra space. When they're on different disks it has to copy, which doubles the space used.

So mount one parent folder and keep both inside it:

```
/mnt/user/data
├── downloads        → mounted at /downloads
│   ├── movies
│   └── tv
└── media            → mounted at /media
    ├── movies
    ├── tv
    ├── audiobooks
    └── books
```

Give your download client the same view (for example qBittorrent with `/mnt/user/data/downloads` at `/downloads`). If its paths differ from Cinemask's, add a remote path mapping in **Settings → Media management**. **Settings → Health** warns if hardlinks won't work.

## Unraid

1. Docker tab → **Add Container** → paste this template URL and press **Apply**:
   `https://raw.githubusercontent.com/Spacegoose02/cinemask/main/unraid/cinemask.xml`
2. Check the **Downloads** and **Media** paths match your shares (defaults are `/mnt/user/data/downloads` and `/mnt/user/data/media`).
3. Start it and open `http://<unraid-ip>:7979`.

Unraid's defaults (`PUID=99`, `PGID=100`, `UMASK=002`) match the other media containers, so Plex, Jellyfin and Audiobookshelf can read what Cinemask imports.

## Docker Compose

```yaml
services:
  cinemask:
    image: ghcr.io/spacegoose02/cinemask:latest
    container_name: cinemask
    restart: unless-stopped
    ports:
      - "7979:7979"
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=America/New_York
      - TRUST_PROXY=false   # true only behind a reverse proxy
    volumes:
      - ./config:/config
      - /srv/data/downloads:/downloads
      - /srv/data/media:/media
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `7979` | Web port inside the container |
| `PUID` / `PGID` | `99` / `100` | User and group the app runs as (never root) |
| `UMASK` | `002` | File permissions for imported media. `/config` stays private regardless. |
| `TZ` | UTC | Time zone for schedules and the calendar |
| `TRUST_PROXY` | `false` | `true` only behind a reverse proxy, so rate limits see real client IPs |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## First run

Open the web page and create the **owner** account. There is no default password, and the owner can never be locked out of password sign-in. Then work through Settings, left to right:

1. **General**: the public URL people use (needed for single sign-on).
2. **Media servers**: connect Plex and/or Jellyfin, then **Sync now**. Cinemask learns what you already have.
3. **Metadata**: a free TMDB key (themoviedb.org → Settings → API). Search, posters and requests need it. mdblist is optional (ratings and lists).
4. **Media management**: the movies, TV, audiobooks and books folders as seen inside the container (`/media/movies`, …), import mode and naming.
5. **Quality**: the default profiles work for most families. Pick the default for movies and shows.
6. **Indexers**: add Newznab/Torznab indexers, or connect Prowlarr and press **Sync indexers from Prowlarr**.
7. **Download clients**: qBittorrent, Transmission, Deluge, rTorrent, Flood, uTorrent, SABnzbd or NZBGet. Use **Test**.
8. **Books** (optional): Audiobookshelf and Shelfmark.
9. **Users** and **Sign-in**: invite the family, or turn on single sign-on ([sso.md](sso.md)) or Sign in with Plex.
10. **Backups**: set a passphrase, and a second location if you can.

Finally, open **Settings → Health**. Everything should be green or explain what to fix.

## Upgrading

Pull the new image and recreate the container. Cinemask takes a backup automatically before applying database changes, so you can roll back by restoring it from **Settings → Backups** on the older image.

## Next

- [Reverse proxy examples](reverse-proxy.md)
- [Single sign-on examples](sso.md)
- [Home Assistant](home-assistant.md)
- [API](api.md)
