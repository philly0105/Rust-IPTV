# Changelog

Notable changes to Tsrust IPTV. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

No version has been tagged or published yet. 0.1.0 and 0.2.0 are the versions the app reports, and their entries match what its What's new dialog says about them (`src/features/onboarding/notes.ts`). The release workflow uses the section whose heading matches the tag as the release notes, so move the Unreleased entries under a version heading before tagging.

## [Unreleased]

Work after the 0.2.0 notes were written: the redesign, fixes that followed the October 2026 audits, and what a public release needs.

### Added

- Release builds from version tags: the Windows installer on a draft GitHub Release, and the server image for amd64 and arm64 on `ghcr.io/philly0105/tsrust-iptv`.
- `THIRD_PARTY_NOTICES.md` with the licences of the bundled npm packages and Rust crates and IPTVnator's MIT notice. It ships with each release, in the installer and in the Docker image.
- A Docker Compose setup in `deploy/` that puts Caddy in front of the server for HTTPS and a password.
- CI checks for dependency advisories and licences (cargo-deny), the minimum Rust version, the Docker image, the desktop release build, and the Playwright suite.
- A user guide, a contributing guide and a security policy.
- A quality filter for live TV: the button next to the channel search hides channels whose name marks a lower quality than the one you pick (HD, Full HD or 4K), and can hide channels with no quality in their name too. The guide, search, zapping, number entry, favorites, recently watched, custom lists and the phone remote follow it. Radio is never filtered.
- A Sports page (in the side rail, and under More on phones) with NFL, college football, NBA and MLB games from a week ago to a week ahead: live scores, results and start times from ESPN's public scoreboard, and the channels of your sources that carry each game, with Watch while it is on, Replay from the channel's catch-up archive afterwards and Record before it starts. Streams are matched from channel names, the TV guide and the networks ESPN lists, so a game can be missed or matched to another regional broadcast.

### Changed

- New visual design. Dark, light and OLED themes get new colours; panels have quieter outlines; the selected item is a neutral fill with a tuning-tick marker instead of an amber wash; primary buttons, switches and checkboxes are bright amber with dark text in the light theme; LIVE pills and destructive buttons are solid. The light and OLED themes now get their own shadows; before, they showed the dark theme's.
- The app ships its own fonts, Inter and Barlow Semi Condensed (for channel numbers, clocks and LIVE pills), so the browser and the installed web app use the same type on every system instead of whatever font the system has.
- One brand mark, an amber tuning dial, for the app, installer, tray, favicon and web icons. The web app shows a splash while it loads, the browser bar follows the app theme, and the installed web app has shortcuts to the TV guide, Search and Favorites.
- Switches, checkboxes, radio buttons and segmented choices look and behave the same on every screen. Icon buttons show themed tooltips with their shortcut keys instead of the browser's title box. On touch screens buttons and menu items are at least 44 px. Dialogs, menus, drawers and toasts animate out as well as in.
- Settings, Sources, the library pages, My List, Stats, Scheduled and the archive line their content up with the page title at every window width.
- Navigation: the side rail is grouped into Watch, Library and Sources; Library folds away, and each source remembers whether it is open. The header has one search box in the same place on every page, and "Search everything" opens the command palette. On phones a tab bar at the bottom (Home, Live TV, Guide, Search and More) replaces the side rail, and the mini player and notifications stay above it. In the browser, a strip under the header says when the server can't be reached and when it is back.
- Home: a rotating hero of what to continue and what is new, an On now rail, and Get started tiles while the page fills. A first run shows a welcome with the three kinds of source and Import a backup; the first source added from it opens on its channels (or its movies or series when it has no channels).
- Sources: each card shows the source's mark, status and counts, with Refresh and Edit at hand and the rest in a menu. With three or more sources the list can be sorted and filtered. Pasted and uploaded playlists can be re-imported from their card, and saving new connection details refreshes the source at once. On phones the add and edit dialogs and Sort and filter open as bottom sheets.
- The first-run tour is one card that points out search and the command palette; Show me around on it gives the full tour.
- Settings: sections are grouped in a side list (a list of sections on phones), and rows moved to where people look for them: poster size and the Home screen rails to Appearance, the recordings folder to Recording, and the image cache and Reset settings to Backup and storage.
- Live TV and the guide: Favorites and Recently watched sit at the top of each source's groups, a group's menu adds the whole group to a list, a list page has Add channels, and typing a channel number in the guide jumps to its row. The guide has a preview band and colours programmes by genre. Archive is now called Catch-up, and it plays in a full player on its page.
- Player: a quieter control bar with less-used commands in its menu, an error screen whose buttons fit the failure (try another source, edit the source, play as HLS, open in MPV or VLC), and the channel's monogram when it has no logo.
- Movies, series and the library: a source's Movies and Series pages open with rails and category chips, grids have a Filters panel, detail pages have a full-width hero, search has Top results, My List opens as posters with a list view, and My Videos has a Recordings section.
- Ctrl+R opens Recently watched only in the desktop app; in a browser it reloads the page again.
- In the desktop app the window's title bar follows the app's theme.
- Rust 1.90 is the minimum version (`rust-version` in Cargo.toml). The locked Tauri 2.12 crates need it.
- The installer no longer names a licence in its copyright line; the project licence is not chosen yet.

### Fixed

- The mini player's Expand opens the playing channel's own page. Before, it could open the Live TV page of another source, whose guide strip then described the wrong channel.
- After a backup import, keyboard focus moves to the result. Before, it dropped to the top of the page.
- M3U movies play and download: the core now sends their stream address and request headers, which the player and the download queue were waiting for.
- M3U sources imported before series grouping are re-imported once at startup, pasted and uploaded playlists included, so their episodes appear as series.
- A parental lock or hidden flag on a movie group now also covers the series group made from it.
- The phone remote's channel list updates when live groups are hidden or shown and when English only changes.
- Movies and episodes stall less. The media proxy reads up to 32 MiB ahead and resumes a dropped provider connection inside the same response; the stall watchdog no longer reloads a video whose data is still arriving; HLS movies buffer 60 s ahead; embedded mpv buffers up to 120 s ahead for movies and episodes and accepts fractional resume positions.

## [0.2.0] - 2026-10-19

Loops 1 to 5 and the feature and performance audits of 2026-10-19.

### Added

- Series in playlists: M3U episodes are grouped into series with seasons, like those of Xtream and Stalker sources. Episodes are recognised by Xtream `/series/` addresses and by titles such as S01E02, 1x02 or Season 1 Episode 2.
- Find programmes: global search (Ctrl+F) has a Programmes tab and the command palette a guide group; a hit opens the guide at the programme.
- Guide and zapping: zoom the guide, show favorites or a custom list in it, shift guide times per source or per channel, and zap through favorites in their order.
- Picture and protected channels: aspect ratio, crop or zoom (and deinterlacing with mpv) in the player menu, and ClearKey-protected M3U channels in the built-in player.
- Easier source updates: new playlist URLs, Xtream accounts and Stalker portals refresh automatically, a pasted or uploaded playlist can be replaced in place, and Xtream accounts can send their own User-Agent, Referer and Origin.
- More to download and catch up on: whole seasons, M3U movies and past programmes. Catch-up works by the hour on channels without a guide.
- A better phone remote: play, pause, stop, back 10 s and forward 30 s, and the channel list without opening Live TV first.
- Phones and touch screens: hide the sidebar on small screens, a smaller mini player, tap the video to show the controls, and a button that opens the channel list in fullscreen.
- Start maximized or fullscreen: Settings > General > Window at startup.

### Changed

- Clearer messages: errors lead with a translated explanation and a hint, with the raw message under Technical details; dates, numbers and key names follow the app language.
- Faster all round, most of all on large libraries: search, the guide, imports, zapping and long lists. The startup refresh waits 30 s and only imports stale sources; imports of unchanged Stalker catalogs and of M3U URLs that answer 304 keep the stored catalog; hls.js transmuxes in a worker; the code loaded at startup is smaller.
- In the browser, Settings offers only the built-in player, and the Docker image includes mpv so scheduled recordings work in server mode.
- Space, the arrow keys and Page Up / Page Down control the player only when it is on a page, fullscreen, in picture-in-picture or focused; otherwise they scroll and move through lists. Over a dialog the shortcuts stay off, apart from a few such as Esc, F11 and Lock now.

### Fixed

- Hundreds of fixes to imports, the guide, playback, recording, downloads and backups.
- Links that reloaded the same page, `iptv://` add links with a source type, and startup on a route whose source or list no longer exists.

## [0.1.0] - 2026-10-14

The first version: IPTVnator rebuilt on Tauri 2 with a Rust core.

### Added

- Sources: M3U and M3U8 playlists (URL, file or pasted text), Xtream Codes accounts and Stalker (Ministra) portals, with scheduled refresh and subscription expiry warnings.
- Live TV with an XMLTV guide, catch-up, failover to the same channel on another source, and audio and subtitle sync.
- Movies and series with resume, downloads with an offline library (My Videos), and optional details from TMDB.
- Playback in the built-in player, in mpv embedded in the window, or in mpv or VLC as external players.
- Scheduled recordings and guide reminders.
- A web remote, with QR pairing for phones on the local network.
- Backups in IPTVnator's playlist backup format, in both directions.
- 19 interface languages, and an English only setting that hides channels, movies and series whose name or category marks another language.
- Server mode: `iptv-server` serves the same interface to browsers as an installable web app, with a Dockerfile.
- Multi-view: up to four live channels at once; click a tile to give it the sound.
- Parental controls: lock channels, groups or titles behind a PIN, or hide them completely.
- My List: save movies and series from their poster and find them again on the dashboard.
- Your own channel lists, mixing channels from any source, and renaming or hiding single channels.
- Guide search and series recording: search programmes, jump to any day and time, and record every airing of a show.
- Subtitle files (.srt, .vtt, .ass) and subtitle size, colour, background and position.
- Sleep timer: stop playback after a set time or when the programme ends, with a fade.
- Browse by decade: filter movies and series by year and hide what you have already watched.
- Watch stats: viewing time per day and the top channels and titles.
- Looks: seven accent colours, an OLED black theme, compact density and interface size.
- Screenshots: S during playback saves the current frame as an image.
- Posters and logos are kept on disk, so grids load at once the next time.
