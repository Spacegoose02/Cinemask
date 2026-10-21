# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.17.0] - 2026-10-21

### Added
- "Airing next" and "Recently aired" rows on Home and at the top of Library: each followed show's next episode this week (tonight first) and its latest one, with the day it airs and whether it's downloaded. Home layouts you've customized can add them under Customize.

### Changed
- Monitored is a poster grid, like Sonarr. Under each poster: a bar with episodes on disk out of those aired (red when a monitored title is missing something, orange when an unmonitored one is, green or blue when complete), "Monitored · quality profile", and when the next episode airs. It can be sorted by next airing.

## [0.16.0] - 2026-10-21

### Added
- A Monitored page (managers) lists every movie and show Cinemask follows: monitored or unmonitored, and what's missing ("Missing", "3 of 40 episodes missing", "Not released yet"). It has filters, Monitor/Unmonitor, and a Search button for titles with something missing.
- Downloads → Search indexers: sort the results by release date (newest or oldest first), seeders or size. The choice is remembered.
- News and talk shows filed by air date (20/20, 48 Hours, nightly shows) are found and imported: a release or file named like `20.20.2025.10.17` counts as the episode that aired that day. When a show's search finds nothing by season and episode, it searches by air date for the newest wanted episodes.

### Changed
- Title pages have one "Watch trailer" button for everyone. It plays the trailer file on the server when there is one, and the YouTube trailer otherwise. The separate "Trailer on YouTube" and numbered trailer buttons are gone.
- Importing from Radarr or Sonarr again brings titles already in Cinemask (from library sync, say) in line with them: they take Radarr's or Sonarr's monitored state, and Sonarr's monitored seasons. Their files and profiles are left alone.
- Downloads → Search indexers lists releases of exactly what you typed first, so "48 hours" shows 48 Hours ahead of "Travel Man: 48 Hours In…".

## [0.15.1] - 2026-10-21

### Fixed
- Plex collections stay in their own library. A Kids Movies collection no longer tags the same films in Movies, which made Plex grow a matching collection there. Collections now have a "Plex library" choice (new ones default to the library you're viewing). Leaving it empty keeps the old behaviour: every library that has the titles.
- A finished download whose folder the client reports at a path Cinemask can't see (no remote path mapping) is now found by name in the downloads folder and its category folders, the watch folder, or the library folders. When it still can't be found, the message names the client folder to map.
- The watch folder no longer adds the same failure to History again after a restart. A copy of something already in the library says so and points to Downloads → Import.
- Plex and Jellyfin rescan after watch-folder imports, as they already did after other imports.

## [0.15.0] - 2026-10-21

### Added
- Downloads → History: "Clear history" and "Clear failed and removed". Only the list is cleared; the queue and files on disk aren't touched.
- Downloads → Import: a Delete button removes a file from the downloads or watch folder, with its release folder's leftovers once its last video is gone.
- Library → Find duplicates: movies and episodes with more than one video in their folder (trailers and extras don't count), with a Delete button for each extra copy, plus titles Plex or Jellyfin list more than once.
- Calendar: a "Premieres only" or "Premieres and finales" view, a Movies or Shows filter, and badges for series premieres, season premieres, season finales and series finales. Finales come from TMDB, so they appear once a show's episodes are refreshed (every 12 hours).

### Fixed
- Finding a movie's file in its folder no longer picks a trailer or featurette that happens to be bigger.

## [0.14.0] - 2026-10-20

### Added
- Downloads → Import: every video in the downloads and watch folders, with what its name suggests. Pick a file, say whether it's a movie or which episode it is, pick the title on TMDB, and it's renamed into your library (moved, copied or hardlinked). A manual import replaces the file the title or episode already has.

### Fixed
- Downloads stuck at "completed" forever. When the client finished a download but never said where the files were, or dropped it before Cinemask imported it, the download now fails after 30 minutes with a note to import it from Downloads → Import.
- "No video files found" now points to remote path mappings, the usual cause.

## [0.13.0] - 2026-10-20

### Added
- A watch folder (Settings → Media management). Movies and shows dropped there are matched on TMDB, monitored, and moved into your Movies or TV folder with the naming format, checked every 5 minutes. A drop is left alone until its files have stopped changing for 2 minutes, so nothing half-copied is moved. Anything that can't be matched stays where it is and shows as a failed import on Downloads.

## [0.12.1] - 2026-10-20

### Added
- Settings → Media management: "Upgrade files automatically". Turn it off and nothing already downloaded is replaced by a better release, whatever the quality profiles allow. Missing movies and episodes are still searched for.

## [0.12.0] - 2026-10-20

### Added
- Settings → Users: "Downloads without approval" lets an admin trust a user with movies, shows or both. That user's requests of that kind are approved and searched straight away.

### Fixed
- Users had no Request button on a movie or show that's monitored but not on the server yet. They can now request it, and approving the request keeps the title's quality profile and adds the requested seasons to the ones already monitored.
- Collections copied from Plex or Jellyfin showed titles without posters. Their items now use each title's TMDB poster.

## [0.11.2] - 2026-10-20

### Added
- Settings → Media management: "When only bigger releases are found" decides what happens when every release is over the size limit. Download it anyway with a warning (as before), ask first, or don't download it. With "ask first", the release waits on Downloads with "Download anyway" and "Don't download" buttons, and you're notified.
- Downloads shows the percentage done and the time left beside each progress bar. When the client gives no estimate, it's worked out from the size and speed.
- Manual search asks before grabbing a release that's over the size limit.

### Fixed
- Torrents and NZBs that never reached the download client. Cinemask passed the indexer's link to qBittorrent, Transmission or SABnzbd to fetch, which fails silently when the client can't reach the indexer or Prowlarr (for example behind a VPN). Cinemask now fetches the .torrent or .nzb file itself and uploads it, as Sonarr and Radarr do. Magnet links are still passed on, and a qBittorrent refusal is now shown as an error.

## [0.11.1] - 2026-10-20

### Changed
- The home page's Collections row shows only your Movies library's collections, so a collection in both Movies and Kids Movies appears once, and "See all" opens Collections on Movies.
- Plex collections imported before 0.11.0 are sorted into their libraries automatically; there's no need to import them again.
- When Cinemask can't reach an indexer, download client, Shelfmark, Plex, Jellyfin or Audiobookshelf, the message now says why: the connection was refused, the host name doesn't resolve from the Cinemask container, the address isn't reachable, the HTTPS certificate isn't trusted, or it timed out.

## [0.11.0] - 2026-10-20

### Added
- Import from Radarr, Sonarr and Overseerr (Settings → Import). Radarr movies and Sonarr shows are added with the quality profile of the same name and the seasons Sonarr monitors, and their files are found where they already are; nothing is downloaded or moved. Overseerr (or Jellyseerr) requests come over with their status and who asked, matched to Cinemask users by email or username.
- Downloads: "Search indexers" searches Prowlarr and your other indexers for anything, and sends a result to the download client with the folder it should go to when it finishes (the downloads folder, any movie or TV folder, audiobooks or books).
- Collections: a Library picker, starting at Movies, so a collection that's in both Movies and Kids Movies on Plex no longer shows twice. Import from Plex again to sort collections imported before this version.
- YouTube: an optional download folder (Settings → Media management), so videos download there and only move into the YouTube folder when finished. Videos already in the YouTube folder, named the yt-dlp way with `[video id]`, count as downloaded when you subscribe, and "Import from folder" on a channel finds them again.

### Fixed
- SABnzbd downloads stuck in the queue after they finished. Cinemask only looked for jobs under its own category, so a job SABnzbd filed elsewhere (an unknown category becomes the default one) or that fell past the first 100 history entries was never seen finishing. Jobs are now also looked up by their id, and a job being verified or unpacked shows as downloaded instead of 0%.
- SABnzbd: the job name no longer carries `{{…}}`, which SABnzbd reads as an archive password.
- "Remove completed downloads" no longer deletes a link download left in the downloads folder, or one that couldn't be delivered: the download client's copy was the only one.
- YouTube: a `%` in a video title no longer breaks its download.

### Security
- Link downloads: addresses like `http://[::ffff:127.0.0.1]` got past the check for local and private addresses, because the URL parser writes the IPv4 part in hex. IPv4 inside IPv6 is now checked in every form.
- Search results no longer send an indexer's guid to the browser, since some indexers put their API key or passkey in it. Results carry an opaque id instead.

## [0.10.4] - 2026-10-20

### Added
- Episode size by length (Settings → Media management → Searching): set a largest size for each episode length, such as 800 MB up to 30 minutes, 1.5 GB up to an hour, 2 GB up to 1½ hours and 2.5 GB up to 2 hours. A show uses the first row that fits its usual episode length, and the flat limit still applies when no rows are set or a title has its own limit.
- YouTube: subscribe with "Let me pick from the channel's videos". Every video is listed and nothing downloads on its own; tick videos (or select all), search titles, page through older videos, and download the ones you picked. New uploads join the list for you to pick from.
- Discover: more channels and networks, including Lifetime, Hallmark, Great American Family, USA Network, TNT, TBS, A&E, Syfy, Bravo, Freeform, Paramount Network, Comedy Central, Adult Swim, TLC, HGTV, Food Network, Tubi, The Roku Channel, Pluto TV, Freevee, MGM+ and BET+. On the Movies tab, the channel filter finds movies those channels made, such as Lifetime and Hallmark movies.
- Discover: "Originals only" next to Streaming on shows just the shows or movies a picked service made itself, such as Netflix or Tubi originals.
- Discover lists every streaming service TMDB knows for your region (Tubi was cut off before), with a search box on long filter lists.

## [0.10.2] - 2026-10-20

0.10.1 was tagged before its version bump, so no image was built for it. 0.10.2 carries everything meant for 0.10.1, along with more fixes.

### Added
- Managers can add a title to monitoring without searching ("Monitor only"), and can monitor a movie that's already on the server so it gets upgraded ("Monitor for upgrades").
- "Manage files" on any title that's on Plex or Jellyfin but not managed by Cinemask yet: it finds the title's folder, so its files can be deleted, renamed and upgraded. Nothing is downloaded.
- The Files card shows where a title is on disk, including titles Cinemask doesn't manage yet, and its button reads "Manage this movie" or "Manage this show".
- Automatic trailers are on by default, and cover every managed title that has files: after an import, when files are found, and hourly for any title still without one.

### Fixed
- Movies and shows on the server couldn't be deleted: the Files panel only appeared for titles Cinemask monitored, auto-monitor added only 50 titles per sync, and a folder was only found when named exactly as Cinemask would name it. Folders like `Paddington.2014.1080p` or `Paddington {tmdb-116149}` are now found in any root folder, and auto-monitor works through the whole library.
- Trailers already beside a movie played from YouTube instead: only a file named after the video file counted. Any `…-trailer` file next to the movie, or any video in a `Trailers` folder, now plays, also for titles Cinemask doesn't manage.
- qBittorrent behind a reverse proxy (such as `https://torrent.example.com`): "login was rejected" with the right password, because Cinemask sent a Referer that qBittorrent's cross-site check refused. It no longer sends one, and a sign-in blocked by a proxy in front of qBittorrent now says so.
- Releases made on GitHub's Releases page build even if `package.json` wasn't bumped first; the image takes its version from the tag.
- qBittorrent 5.2 and later: "login was rejected" although the password was right (it now answers a good sign-in with an empty 204). A blocked address after too many failed sign-ins now says so.
- Library posters missing for most titles on large libraries: a sync filled TMDB details for only 200 titles, and titles that kept failing were retried first and held up the rest. Every title is now filled after each sync, and anything left over is retried hourly.

## [0.10.0] - 2026-10-20

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

[Unreleased]: https://github.com/Spacegoose02/cinemask/compare/v0.10.2...HEAD
[0.10.2]: https://github.com/Spacegoose02/cinemask/compare/v0.10.0...v0.10.2
[0.10.0]: https://github.com/Spacegoose02/cinemask/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/Spacegoose02/cinemask/releases/tag/v0.9.0
