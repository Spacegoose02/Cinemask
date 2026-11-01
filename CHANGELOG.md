# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.31.0] - 2026-11-01

### Changed
- The webhook moved from Settings → API and webhooks (now **API**) to the new **Settings → Notifications**. The "send events" switch there now covers every shared channel.

### Added
- **Request limits.** Settings → Requests sets how many movies and show seasons each user can request every so many days (declined requests don't count, managers have no limit), and Settings → Users can give anyone their own limit. The request dialog shows "3 of 5 left this week", and going over says how many are left.
- **See how a request is doing.** Approved requests on Requests say where they've got to: not out yet (with the expected date), looking for a copy, downloading with a progress bar and time left, adding to the library, or how many episodes are ready.
- **4K requests.** People an admin allows (Settings → Users → Can request 4K) can tick "Request in 4K". An approved 4K request uses the 4K profile and folder from Settings → Requests; a title already on the server moves to the 4K profile so it's upgraded.
- **"Already streaming".** Title pages say when a title is on a streaming service, and the request dialog mentions it. Settings → Requests can pick the household's services and stop users requesting titles already on them.
- **Delay profile.** Settings → Media management can prefer Usenet or torrents and wait a while after a release appears before grabbing it automatically, so a better one has time to turn up (releases already at the cutoff can skip the wait). Manual search still grabs at once.
- **Notifications on your phone and computer.** Account → Notifications turns on notifications for each device (on iPhone, once Cinemask is on the Home Screen), with a test button and a list of devices. Everyone picks what they hear about: their requests approved, declined or ready (people who said "me too" hear too), movie nights, and for managers and admins new requests, failed downloads and health problems.
- **Email notifications.** With an SMTP server in Settings → Notifications, people can also get their notifications by email, at an address they set themselves.
- **Discord, Telegram, ntfy, Gotify and Pushover**, alongside the webhook, in the new Settings → Notifications tab, each with its own test button. Messages link back to the title in Cinemask when Settings → General has the public URL.
- **Custom formats and release scores.** Settings → Quality has custom formats: rules on the release name, release group, indexer, language, protocol or size that pick out things like HDR, Dolby Vision, Atmos, lossless audio, a streaming service or a low-quality group. Each profile scores each format; releases are ranked by quality first and then by score, a profile can refuse anything under a minimum score, and can keep upgrading a file at the cutoff quality until its score reaches a target (files imported before this aren't touched). Fourteen ready-made formats can be added in one go, with suggested scores. Manual search shows each release's formats and score.
- **Report a problem.** Anyone can report a problem with a title, season or episode from its page: wrong language, missing subtitles, poor picture, won't play, wrong episode, or something else. Reporting something already reported joins that report. Managers get a new **Problems** page with a count in the menu; people see their own reports there and hear when they're fixed, and can say "Still not right".
- **One-click fixes.** On Problems, "Find a different copy" blocklists the copy that's there and downloads another (which replaces the file even if it looks no better), and the report is marked fixed when it's imported. "Fetch subtitles" gets subtitles for it. Settings → Requests can fix reports automatically as soon as they're made.
- **What's really in the files.** After each import Cinemask reads the file with ffprobe: resolution, codec, HDR or Dolby Vision, length, audio tracks and their languages, and subtitles inside it or next to it. Title pages show this to managers and flag files sold as a higher resolution than they are, or with no audio in the profile's language. Files imported earlier are read a few titles an hour.
- **Subtitles.** Settings → Media management → Subtitles fetches subtitles from OpenSubtitles.com in your languages after each download (or with Fetch subtitles on a title's page), matching your exact copy first, and saves them next to the video for Plex, Jellyfin and BingeBandit.
- **Watchlist sync.** Account → Watchlist turns what you add to your Plex watchlist (once you've signed in with or linked Plex) or mark as a favourite in Jellyfin (an admin links your Jellyfin account in Settings → Users) into requests, every 30 minutes or with Check now. They follow the usual rules: approval, request limits and kids profiles. Each title is asked for once; one stopped by a request limit is tried again later.
- **Kids profiles.** Settings → Users can give a user an age limit (up to 7, 9, 12, 14 or 16). They then only see and can request titles rated for that age or younger in search, Discover, lists, collections, the library and recently added; titles with no rating are hidden too. Ratings come from TMDB for your metadata region, then the US. Titles already in Cinemask get their ratings in the background.
- **Anime numbering.** Shows can be set to standard, daily (by air date) or anime numbering, under "Size and more" on a title page; Japanese animation is set to anime automatically. Anime releases like "[Group] Show - 112 [1080p]" are matched to the right season and episode, searched for by their number, and imported.
- **Seeding goals and stalled downloads.** With "Remove finished downloads" on, torrents can keep seeding until a ratio or a time (Settings → Media management) before they're removed. Downloads that make no progress for a set time are given up on, blocklisted, and another release is tried.
- **Storage.** A new Storage page for managers shows how full each disk is, the biggest titles, and titles that could go (watched long ago, or never watched since they arrived; never ones marked Keep, still requested or with an open problem). Removing them stops them being downloaded again. Deleted and replaced files go to a recycle bin (a hidden `.cinemask-recycle` folder in the media folder) for 30 days, and can be restored. Admins can turn on nightly delete rules, which only run while the recycle bin is on.
- **Move over in one pass.** Settings → Import has a dry run that shows, without changing anything, what Radarr, Sonarr and Overseerr would bring: titles to add, update and skip, how their quality profiles map, which download clients and indexers to set up by hand, and which Overseerr users would become Cinemask users. "Move everything" then brings Overseerr's people over (they sign in with Plex and keep their request limits), followed by Radarr's movies, Sonarr's shows and Overseerr's requests.
- **Works with apps made for Radarr and Sonarr.** Overseerr, Jellyseerr, LunaSea, nzb360 and Home Assistant can use Cinemask as their Radarr and Sonarr, with the URL base `/api/compat/radarr` or `/api/compat/sonarr` and a manager's API key (see docs/api.md).
- **Interface languages.** Account → Language picks English, Español, Français, Deutsch or Nederlands (or follows the browser), saved to the account. The menu, the settings tabs and the Account page are translated so far; everything else still shows in English until it's translated, one screen at a time (`src/web/locales`).
- **Request notes and "me too".** Users can add a short note to a request. Asking for something someone else already requested adds you to their request instead of making a second one: it shows on your Requests with "Stop following", and the request shows how many others want it.

### Fixed
- **Back goes back to where you were.** Back restores the scroll position of the page you left (once its data has loaded), and new pages open at the top. Discover keeps its filters in the address, and the status filters on Requests and book requests stay as you left them.

## [0.30.0] - 2026-10-31

### Added
- **Install Cinemask as an app.** Browsers offer "Install app" (on iPhone, Add to Home Screen help shows how). The app never stores anything from `/api` offline, so nothing private is cached. It shows an offline banner, a "can't reach the server" screen, and a "new version ready" prompt to reload.
- **Live updates.** Pages refresh by themselves when something changes (a request approved, a download finished, a library sync done) instead of waiting for a reload. Each signed-in tab only hears about changes its role can see, and only that something changed, never the data itself.
- **Phone tab bar** at the bottom: Home, Library, Discover, Requests and More.

### Fixed
- **Sign out on phones.** The phone menu now has your name and a Sign out button; before, only the desktop sidebar had one.
- **Ended sessions.** When a session expires or is signed out from another device, the app goes to the sign-in page ("You were signed out") instead of showing empty pages, and Sign out works even then. Data from the last account is cleared from the tab.
- **Links survive signing in.** Opening a link while signed out (a title, Requests…) goes back to it after signing in, not to Home.
- **Pages say when they can't load.** Library, Requests, Account, Games, the API reference and the Settings tabs show the error with Try again instead of a blank page. "Not found" and similar answers are no longer retried three times, so the title page shows its error at once instead of after about seven seconds.
- **Show requests.** Users can request seasons a show is still missing after an earlier request ("Request more seasons"); seasons already asked for show as such. New seasons are added to your own waiting request, or make a new request when the earlier one was approved, instead of being dropped. A show request is only marked ready (and "ready to watch" sent) once every aired episode of the requested seasons is on a server, not as soon as any episode is.
- **Declined requests** show on the title page with the reason, and can be requested again.
- **Cancel cancels.** Cancel on the decline reason box no longer declines the request (movies, shows and books), and Cancel on the passphrase box no longer restores a backup. The same backup file can be picked again after a cancel.
- **Games.** A double tap no longer answers the next question or replaces your score with "already scored", and an expired round or failed scoring offers Start a new round.
- **Dates follow your time zone.** Episodes airing tomorrow no longer show as missing in the evening in the Americas, Home's upcoming row keeps today's releases, and the server stops counting episodes as aired (and searching for them) up to a day early. Server dates use `TZ`.
- Plan a movie night suggests 8 pm today until 7:30 pm, and Change won't save an empty time.
- A failed "Sign out" of another device on the Account page now says why.
- Two Settings pages (Media servers, Media management) no longer scroll sideways on phones.
- The version shown without `APP_VERSION` (npm start, development) comes from package.json instead of 0.10.2.

## [0.29.0] - 2026-10-31

### Added
- **Family ratings.** Everyone can give a title one to five stars and a review on its page, which shows the household's average next to everyone's reviews. Managers can remove someone's review (audited). New homepage rows: **Family favorites** and **Because you liked…** (TMDB recommendations for the last title you loved).
- **Movie nights.** Plan one from any title's page ("Plan a movie night"), and everyone can answer I'm in, Maybe or Can't make it on the new Movie nights page or the homepage row. Only the host or a manager can change or cancel it. Webhooks get `movie_night.created` and a `movie_night.reminder` within the hour before it starts.
- **Games.** Trivia (years, plots with the title blanked out, ratings, genres, runtimes) and Guess the scene (a still from a title), five questions made from what's on your servers. Answers stay on the server until a round is scored. A weekly leaderboard and daily streaks.
- **Cinemask Wrapped.** A recap of a year or a month: your raccoon persona from the genres you request and rate, your requests, ratings, movie nights and game points, and the household's hours watched, movies, episodes, most-binged show, top genres and busiest month (from the servers' play history).
- **Badges** for requests, ratings, reviews, movie nights, perfect rounds and game streaks, shown on Wrapped with progress towards the next ones.

## [0.28.0] - 2026-10-30

### Added
- Settings → Media management → **Add BingeBandit libraries** adds each BingeBandit movie and show library (Kids Movies, Kids TV, 4K, …) as a folder, found where Cinemask sees it, so Download and Monitor ask which library a title goes in instead of always using Movies. Libraries Cinemask can't see are listed with BingeBandit's path. Needs a BingeBandit admin's key.

### Fixed
- A title moved to another library outside Cinemask (BingeBandit's Move, say Movies → Kids Movies) is followed: library sync and the next import find its folder in the new root folder, so its folder, root and files point there and upgrades land beside it instead of recreating it in the old folder.

## [0.27.1] - 2026-10-28

### Fixed
- The build: TypeScript is back on 5.9, since 7.0 can't be installed alongside the linter (typescript-eslint supports up to 6.0). Nothing changes in the app itself.

## [0.27.0] - 2026-10-28

### Added
- BingeBandit collections. Collections → Import from BingeBandit copies its collections (with their covers) into Cinemask; hand-picked ones stay in sync both ways, while smart and list collections come over as copies BingeBandit keeps managing. A collection set to "Sync to BingeBandit" is made in each BingeBandit library that has its titles (or just its own library), titles join and leave it as they do here, renames and descriptions follow, and its cover replaces BingeBandit's.
- Library sync reads BingeBandit's quality from its file list in a few requests, when BingeBandit has it (`GET /api/admin/files`, BingeBandit PR #120), instead of opening every movie and episode.

### Changed
- The collection library picker lists BingeBandit libraries too.

## [0.26.0] - 2026-10-26

### Added
- BingeBandit as a media server (Settings → Media servers), alongside or instead of Plex and Jellyfin. Library sync reads its movies and shows with episodes, quality, plays, labels and which library each is in; imports ask it to scan; poster changes are pushed to it; and Settings → Health checks the connection. Use an admin's API key (BingeBandit Settings → API keys) so scans and posters work.

## [0.25.0] - 2026-10-26

### Added
- Cast on every movie and show page, in library titles and new ones alike: up to 20 people in billing order with their photo and character, and for shows how many episodes each one is in.

## [0.24.0] - 2026-10-22

### Fixed
- Dateline, 20/20 and other news shows: releases named without the network ("Dateline" for "Dateline NBC") or with it ("ABC 20/20") now match, and when nothing numbered fits, the search also looks by air date even if some episodes do have SxxEyy names. Titles with a slash are searched as words ("20 20"), which indexers understand.
- Foreign-language releases: quality profiles that allowed "any language" now want English (change it back per profile in Settings → Profiles), and more language tags are recognised (Hungarian, Czech, Turkish, Hebrew, Ukrainian, Greek, Nordic and others). A language word in a title ("The French Dispatch") no longer counts as the release's language.
- New files showed on a show or movie page only after Rescan folder. The page now follows its downloads and refreshes the files as soon as one is imported.

### Added
- Each episode (and a movie) shows its download as it happens: queued, downloading with a progress bar and time left, importing, waiting for a size confirmation, or failed with the reason.
- Manual search marks releases already sent for that title on their own row (downloading, downloaded, failed), and a grab made from the list is confirmed on its row instead of at the top.

### Changed
- A Search result lists indexer problems (such as rate limits) on their own lines under the result, instead of one long sentence.

## [0.23.0] - 2026-10-22

### Added
- "Allow larger files" on a movie or show (Size limit, or Folder and size): doubles the default size limit for that title only, so a 4 GB movie limit becomes 8 GB without opening the door to 30 GB remuxes. The Size limit button shows "(2×)" while it's on.

## [0.22.0] - 2026-10-22

### Added
- "Search missing" on a show's Files section searches every monitored episode that has aired and has no file, without looking for upgrades of the ones already there.
- Monitored page: "Search all missing episodes" and "Search all missing movies" search every monitored show or movie with something missing. They run in the background one title at a time, with a short pause between titles so the indexers aren't flooded, and anything found shows up on Downloads.

### Changed
- "Search now" on a show leaves out episodes that are unmonitored. The Search buttons on a season or an episode still search it either way.

## [0.21.1] - 2026-10-22

### Added
- Manual search shows each release's age and upload date, and its column headers sort the list: click Release, Quality, Size, Age or Peers once to sort, again to reverse, and a third time to go back to best first.

## [0.21.0] - 2026-10-22

### Fixed
- A Search button that grabbed nothing just said "Nothing found", even when Manual search listed good releases. It now says why: no releases at all, every release rejected (with the most common reason), the episode already downloading (naming the download, which Downloads can remove), the download client refusing the release (with its error), or nothing to search for. Indexer errors such as HTTP 429 are listed too.
- Searching one episode by hand skipped episodes TMDB hadn't dated yet. They are searched now.

### Changed
- On a show page, a season's or episode's Search result appears under that row instead of at the top of Files.
- With more than one library folder for movies or shows, Download and "Monitor only" ask which library to use (unless the title is already on disk in one), the show Download dialog needs a library picked, and approving a request has a library picker.

## [0.20.0] - 2026-10-22

### Fixed
- Recently added missed shows: a show counted as added when it first appeared in Plex/Jellyfin, so new episodes never moved it up. It now counts its newest episode.
- Recently added waited for the next library sync (every 6 hours by default). What Cinemask imports shows up at once, and the library is synced again a couple of minutes after each import, move or delete, once Plex/Jellyfin have rescanned.

### Added
- Calendar: clicking an episode or movie shows Search and Manual search buttons (managers). Search grabs the best release for that episode; Manual search lists every release to pick from. A day with several episodes of one show has the buttons on each episode.
- "Move to folder" on a movie or show page (managers): moves its folder to another root folder, such as Movies → Kids Movies or TV → Kids TV, and asks Plex/Jellyfin to rescan. It works for titles Cinemask doesn't manage too (ones that are only in Plex), finding their folder by name.
- Recently added on Home is split into movies and shows by default, and Customize can add a row per Plex library (Recently added in Kids Movies, Kids TV and so on).
- Calendar: a "Missing only" view shows just what has aired or been released, is monitored, and has no file (the red entries).

## [0.19.1] - 2026-10-21

### Fixed
- "Invalid CSRF token" when saving a setting in a tab left open after signing in again elsewhere (another tab, or after the session was replaced). The page now fetches the current token and retries once; if you were signed out, it says so.

## [0.19.0] - 2026-10-21

### Added
- Downloads that arrive packed (a RAR, 7z or zip with no video beside it, as when SABnzbd leaves a .7z unextracted) are unpacked before the import, into an `_unpacked` folder that's removed once the video is in the library. Password-protected archives fail with a clear message. It's on by default; turn it off in Settings → Media management → "Unpack archives". The Docker image now includes `unar`.
- Downloads → History: "Retry import" on a failed download that's still in the download client, so a fixed problem (a path mapping, an archive) doesn't need a new download.

## [0.18.0] - 2026-10-21

### Added
- Library has a library filter: pick one of your Plex libraries (Movies, Kids Movies, Kids Shows, 4K Movies and so on) to see only what's in it. It follows the Type filter, and only appears when there's more than one library. Jellyfin titles carry no library name, so they show under "All libraries" only.

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
