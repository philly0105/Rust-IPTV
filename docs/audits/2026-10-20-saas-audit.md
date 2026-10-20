# SaaS readiness audit

Tsrust IPTV, branch audit/saas-polish at `e8eea35`. The work started at `6fef49b`, which merged master (`b9b00d7`) into the branch that holds the 2026-10-19 audit fixes. The two audits from that day are in this folder. The Rust fixes on saas/rustfix-a and saas/rustfix-b land in this branch together with this report.

The owner's request was: "Do a full feature audit on rust iptv. Make it look better like a fully ready to be pushed SaaS app. Go nuts on this."

## Summary

Round 1 graded nine areas and filed 142 findings: 1 critical, 23 high, 78 medium and 40 low. The reviewers agreed on the diagnosis. The engineering was ahead of most commercial players: contrast tests over 21 theme combinations, RTL, reduced motion, virtualised lists, and a server mode that checks Host, Origin and private targets. The app still looked like a careful enthusiast tool. A 3:1 grey outline sat on every container and amber marked every kind of selection. No font shipped, so browsers on Linux, Android and ChromeOS rendered DejaVu Sans or Roboto. There were three unrelated logos, page margins changed from screen to screen, the rail was a flat list of 12 links, and the phone layout was the desktop squeezed to 390 px. Four critics scored 68 screenshots at 5.0 out of 10 on average, and the ten phone screens at 4.0.

| Area | Grade | Findings | Critical and high | Fixed | Partial | Not done | Owner decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DS: design system and kit | C+ | 17 | 4 | 15 | 2 | 0 | 0 |
| SH: shell and Home | B- | 19 | 4 | 17 | 2 | 0 | 0 |
| LG: Live TV, guide, multi-view and lists | B- | 19 | 3 | 19 | 0 | 0 | 0 |
| VL: movies, series, search and library | B- | 22 | 3 | 19 | 3 | 0 | 0 |
| SS: sources, settings and onboarding | B- | 20 | 1 | 19 | 1 | 0 | 0 |
| PL: player | B- | 15 | 4 | 15 | 0 | 0 | 0 |
| SR: ship readiness | C | 13 | 2 | 7 | 5 | 0 | 1 |
| FW: wiring, front to back | C+ | 8 | 2 | 7 | 0 | 1 | 0 |
| CB: competitive benchmark | B | 9 | 1 | 6 | 2 | 1 | 0 |
| Total | | 142 | 24 | 124 | 15 | 2 | 1 |

The bugs that mattered most:

- FW-M3U-MOVIE-URL (critical). M3U movies could not play or download, because `catalog.item` never returned a stream URL for them. A unit test mocked the field the core never sent, so the suite stayed green.
- FW-M3U-SERIES-MIGRATION (high). Series grouping reached only new imports. Existing M3U sources kept their episodes as thousands of movies, and pasted or uploaded playlists could never be refreshed.
- SS-1 (high). The Add and Edit source dialogs threw away typed credentials on a stray backdrop click or Escape.
- PL-SPACE-CLICKED-CONTROL, PL-MENU-OUTSIDE-CLICK and PL-IOS-FULLSCREEN (high). Space pressed the last clicked control again (click Fullscreen, press Space, and you leave fullscreen). Clicking the picture to close a menu paused the video. On iPhone the fullscreen button only flipped its icon.
- DS-ELEVATION-THEMES (high). The light and OLED shadow tokens never applied, so the light theme drew the dark theme's black shadows.
- VL-tmdb-deadend (high). More like this and Known for listed titles the source did not carry, and each one opened an empty search.
- SR-1 and SR-2 (high). There was nothing to download, and no distributable carried third-party licence notices.

What changed, in 55 commits on audit/saas-polish (884 files) plus 18 Rust commits from saas/rustfix-a and saas/rustfix-b:

- A new design system, Night Tuner 2, with new dark, light and OLED palettes. Containers use a quiet edge token, and the 3:1 border is kept for form controls. Hover and pressed states are see-through layers, the selected item is a neutral fill with the tuning tick, and amber is kept for primary actions, progress, focus and the playing mark. LIVE and danger have solid fills, and there is a type scale from caption to display, five radii, three elevations per theme, and motion tokens with exit animations. Inter and Barlow Semi Condensed are self-hosted. The kit in `src/ui` gained Switch, Checkbox, RadioGroup, SegmentedControl, Slider, FilterChip, a rewritten Tooltip, Page, PageHeader, SectionHeader, LivePill, MetaLine, WatchedChip and SourceMonogram, all described in `docs/architecture/design-system.md`.
- One brand mark, an amber tuning dial, for the exe, installer, tray, favicon and web icons. The masters are in `docs/brand/`, and `tools/brand-icons.mjs` regenerates every icon. The web build shows a splash while it loads, and the manifest has maskable icons and shortcuts.
- Home has a first-run Welcome with the three kinds of source and Import a backup, a full-bleed hero, an On now rail with programme art, 16:9 Continue watching cards with a menu, a rail grouped into Watch, Library and Sources, a phone tab bar, one header search slot and one connection banner.
- Live TV and the guide have a stage column with a Now card and an idle card that offers to resume the last channel, a guide preview band, genre stripes and filters, the playing row marked in the guide, pinned Favorites and Recently watched views, one channel menu everywhere, and a catch-up page with its own player.
- Movies, series and the library have landings built from rails, a detail hero with one primary action, related titles drawn only from the catalog, Top results in search, My List as a poster grid, recordings as wide cards, and toasts for finished or failed downloads.
- Sources and settings have a discard guard on the source dialogs, a grouped settings navigation, About as a product page, new source cards, and a one-card first-run tour.
- The player has fixes for the focus and click bugs above, error screens whose buttons fit the failure, a control bar with a 48 px play button and skip buttons, an unmute prompt, and a phone mini bar.
- For shipping there is a README written as a product page with six screenshots, a user guide, CHANGELOG, CONTRIBUTING and SECURITY files, a release workflow for the installer and a multi-arch image, a notices generator plus IPTVnator's NOTICE, a Caddy recipe for HTTPS and a password in `deploy/`, and CI jobs for advisories and licences, the minimum Rust version, the Docker image, the desktop build and Playwright.
- In Rust, M3U movies play, old M3U catalogs re-import with series, group locks follow episodes, and the phone remote's channel list stays current. Fixes from the GPT-6.1 review keep M3U state through a token rotation and staged playlist text through a crash, limit trust to a source's exact host and port, check the Origin's scheme and port, resume proxy reads only with a validator, apply guide shifts to provider guides, record in server mode only over the guarded HTTP copy, and refuse `file:` and UNC paths from playlists.

After round 1, a second set of critics scored 69 screens again. The average rose from 5.0 to 7.0, the phone screens from 4.0 to 6.7, and the empty first-run dashboard from 4 to 8. Every screen gained between 1 and 4 points. The lowest after round 1 were the actor page (5), the movie player, Radio, the light guide and the phone guide (5.5 each). Round 2 then filed 99 issues, 10 of them high, and fixed 86. Nothing was scored after round 2 or after the GPT-6.1 fixes, so the scores describe the branch before those fixes.

What still stands between this branch and a public release:

- No licence is chosen, and the workspace Cargo.toml still says `license = "MIT"` as a placeholder.
- The version (0.2.0 or 0.3.0) is undecided, and no tag exists.
- The installer is unsigned, and the updater has a placeholder feed and no key.
- Private vulnerability reporting is off, and the ghcr package may start private.
- cargo-deny reports six advisories in rustls 0.23.45 and quick-xml 0.37.5.
- CI run 2 failed Windows clippy on five new lints.
- The Rust fixes from the GPT-6.1 review have not been compiled yet, and one of them (refresh-admission-race) was still being written.
- Neither CI run included Playwright, which lives in e2e.yml and starts on pull requests, on Mondays and by hand. Every spec change was checked only against the screenshot mock.
- Server mode still has no login of its own. The Caddy recipe puts basic auth in front of it, and that setup is untested in Safari.

## Method

The screenshot harness in `scratch/shots` builds the production web bundle and serves it against a Node mock of the API with invented sources, channels, programmes and titles. It captures about 80 shots (79 at the end of the day): desktop dark and light at 1280 px, phone at 390 px, and interaction shots for menus, dialogs, sheets, the mini player and toasts. Every reviewer and fixer used it.

Round 1 had nine auditors and four critics. Six auditors took UI areas: the design system (DS), the shell and Home (SH), Live TV and the guide (LG), movies, series and the library (VL), sources and settings (SS), and the player (PL). Three looked at the product: wiring from the UI to the core (FW), ship readiness (SR), and a benchmark against TiviMate, Smarters, Sparkle, UHF, Channels DVR, Plex, Jellyfin, Emby, Apple TV, Infuse and IPTVnator (CB). The critics each took a set of screens (desktop media and library, desktop live and guide, desktop sources, settings and admin pages, phone) and scored every screen from 1 to 10.

Fix round 1 split the 142 findings into nine packages. The design system package ran tokens, then the kit, then a visual and a code review and a fix pass. Brand and Rust ran alongside it. Docs and release tooling followed, and then the shell, settings, live, player and VOD packages, each with two build stages, a visual review, a code review and a fix pass. An integrator merged them and worked through the notes the agents left for each other. A verifier found eight gaps in that work. A second integration pass fixed seven of them. The eighth was a set of notes for other owners, which it wrote up with an owner for each.

Round 2 had four visual critics, who scored the screens again and filed 73 issues, and three code reviewers, who drove cross-area flows, checked accessibility, keyboard, RTL and translations, and measured bundles, requests and security. They filed 26 issues. Six fixers (kit, shell, player, settings, VOD and live) worked through them, and the one translation issue went into the translation pass below.

GPT-6.1 then reviewed commit `f4549d1` in 15 slices: four Rust slices, six frontend slices, e2e, two translation slices, docs and CI, and security. It filed 84 findings. Every change in this report was made by Claude Opus 5.5 agents; GPT-6.1 only reviewed. Each fixer checked every finding against the code before changing anything and skipped findings that were wrong, with a reason.

Nothing on gmk1 can build Rust. Every Rust change was written without a compiler and then checked by a separate review that read each changed line against the definitions it uses, for rustc, clippy and rustfmt. The branch was pushed to GitHub, and CI compiled all of the Rust for the first time (see CI state at publication).

The machine lost power once, at about 21:55 UTC. The loss corrupted the git object store. Two merge commits were rebuilt from the branches they merged, which were intact, and no work was lost. Two Rust fixers were cut off by it, and their uncommitted work was saved as WIP commits (`5b065ff`, `f816df3`). Earlier, at about 19:50, four round-2 fixers had stopped before finishing, and their work was saved the same way (`f129c2c`, `4cb521a`, `81468a1`, `54c69b2`). Each next fixer reviewed its WIP commit and finished it. The live round-2 fixer's final report was cut off in its journal, so its commit message (`1b577ab`) is the record of that work.

The statuses below come from each fixer's report, checked against the git history. For the items under Known remaining issues, I checked the code at `e8eea35` myself.

## Screen scores

Round 1 scored 68 screens (the list page and the lists index shared one score). After round 1, the second critics scored the same screens, split those two, and added the rail, the header and the phone tab bar, which had no earlier score.

| Group | Screens | Round 1 | After round 1 |
| --- | --- | --- | --- |
| Home, shell and dialogs | 9 | 5.2 | 7.3 |
| Movies, series and library | 26 | 4.8 | 6.9 |
| Live TV, guide and lists | 15 | 4.9 | 6.2 |
| Sources and settings | 19 | 5.4 | 7.4 |
| All screens | 69 | 5.0 | 7.0 |
| Phone screens only | 10 | 4.0 | 6.7 |

| Screen | Round 1 | After round 1 |
| --- | --- | --- |
| desktop-dark-dashboard | 6.5 | 8 |
| desktop-light-dashboard | 6 | 7.5 |
| phone-dark-dashboard | 4.5 | 7 |
| desktop-dark-empty-dashboard | 4 | 8 |
| phone-dark-empty-dashboard | 4 | 6.5 |
| desktop-dark-command-palette | 6 | 7.5 |
| desktop-dark-shortcut-help | 5.5 | 7 |
| desktop-dark-tour | 5 | 7.5 |
| desktop-dark-whats-new | 5 | 7 |
| rail (all desktop shots) | none | 7.5 |
| header (all shots) | none | 7.5 |
| phone tab bar (all phone shots) | none | 8 |
| desktop-dark-movies | 5 | 7.5 |
| desktop-light-movies | 5 | 7 |
| desktop-dark-movies-category | 5.5 | 7 |
| desktop-dark-series | 5 | 7.5 |
| desktop-dark-series-category | 5.5 | 6.5 |
| desktop-dark-movie-detail | 5.5 | 7.5 |
| desktop-light-movie-detail | 5 | 7.5 |
| desktop-dark-series-detail | 6 | 7.5 |
| desktop-light-series-detail | 5 | 7.5 |
| desktop-dark-player-movie | 4.5 | 5.5 |
| desktop-dark-search | 4.5 | 7.5 |
| desktop-dark-my-list | 4.5 | 7.5 |
| desktop-dark-actor | 4 | 5 |
| desktop-dark-stalker-movies | 5 | 7.5 |
| desktop-dark-my-videos | 4.5 | 6 |
| desktop-dark-my-video-detail | 4 | 6.5 |
| desktop-dark-favorites | 4.5 | 6.5 |
| desktop-dark-recent | 5.5 | 7 |
| desktop-dark-downloads | 6 | 7 |
| desktop-dark-scheduled | 5 | 7 |
| desktop-dark-stats | 6 | 7.5 |
| desktop-light-stats | 5 | 6.5 |
| phone-dark-movies | 4.5 | 7.5 |
| phone-dark-movie-detail | 4 | 7 |
| phone-dark-series-detail | 3.5 | 6.5 |
| phone-dark-search | 3 | 6.5 |
| desktop-dark-live | 5.5 | 7 |
| desktop-light-live | 5 | 6 |
| desktop-dark-live-category | 5 | 6 |
| desktop-dark-live-stalker | 5 | 6 |
| desktop-dark-radio | 4.5 | 5.5 |
| desktop-dark-guide | 5 | 6.5 |
| desktop-light-guide | 4.5 | 5.5 |
| desktop-dark-guide-search | 5 | 7 |
| desktop-dark-archive | 4.5 | 6 |
| desktop-dark-multiview | 6 | 7 |
| desktop-dark-list | 5 | 6 |
| desktop-dark-lists | 5 | 6 |
| desktop-dark-context-menu | 6 | 7 |
| phone-dark-live | 3.5 | 6.5 |
| phone-dark-guide | 4 | 5.5 |
| desktop-dark-sources | 5 | 7.5 |
| desktop-light-sources | 5 | 7.5 |
| desktop-dark-empty-sources | 6 | 7.5 |
| desktop-light-empty-sources | 6 | 7.5 |
| desktop-dark-add-source | 6 | 7.5 |
| desktop-dark-settings-general | 6 | 7.5 |
| desktop-dark-settings-playback | 6 | 7.5 |
| desktop-dark-settings-epg | 5 | 7.5 |
| desktop-dark-settings-recording | 6 | 8 |
| desktop-dark-settings-metadata | 6 | 7.5 |
| desktop-dark-settings-appearance | 7 | 8 |
| desktop-light-settings-appearance | 6 | 7 |
| desktop-dark-settings-parental | 5 | 7.5 |
| desktop-dark-settings-remote | 4 | 7 |
| desktop-dark-settings-backup | 5 | 7.5 |
| desktop-dark-settings-shortcuts | 6 | 7.5 |
| desktop-dark-settings-about | 4 | 7.5 |
| phone-dark-sources | 4 | 7 |
| phone-dark-settings-general | 4.5 | 6.5 |

The live critic named four regressions after round 1: past descriptions cut off on the archive page, four fewer guide rows with the preview band open, taller controls above the phone guide, and an idle glow that came out brown or green behind blue logos. Round 2 addressed all four.

## Round 1 findings by area

Status is Fixed, Partial, Not done or Owner decision. Commits are on audit/saas-polish unless a note says otherwise.

### DS: design system and kit (C+)

| ID | Finding | Severity | Status | Note |
| --- | --- | --- | --- | --- |
| DS-ELEVATION-THEMES | Light and OLED shadow tokens never apply | High | Fixed | Each theme defines `--elevation-1/2/3`, and `@theme` maps the shadow utilities to them. contrast.test guards the mapping. |
| DS-FONTS-PLATFORM | Brand type exists only on Windows | High | Fixed | Inter Variable and Barlow Semi Condensed 600 are self-hosted as seven woff2 files split by script range. |
| DS-BRAND-MARK | Three logos; the app icon is a generic cyan play button | High | Fixed | One tuning-dial mark. Masters in `docs/brand/`, icons generated by `tools/brand-icons.mjs` (`9aabcd3`). |
| DS-BORDER-WEIGHT | A bright 3:1 border on every container | High | Fixed | About 90 containers moved to the edge token; the border stays on inputs and selects. Round 2 removed the last heavy outlines on Sources and the backup drop zone. |
| DS-DUPLICATE-CONTROLS | Two or three versions of each form control | Medium | Fixed | The kit controls in `src/ui/Field.tsx` replaced the copies, and round 2 added Slider and FilterChip. The multi-view empty-state layout picker is still hand-rolled. |
| DS-TOOLTIP-UNUSED | The kit Tooltip is never rendered | Medium | Fixed | Icon controls use the kit tooltip with key caps. Native titles stay only on truncated text, by rule. |
| DS-STATE-FILLS | Hover and selected fills are nearly invisible | Medium | Fixed | See-through hover and pressed layers, and a neutral selected fill with the tuning tick. |
| DS-TYPE-SCALE | Small, flat type scale | Medium | Partial | The caption-to-display scale exists and headings use it. 13 arbitrary `calc(11rem/15)` and `calc(13rem/15)` sizes remain, because virtualised rows depend on fixed heights. |
| DS-PAGE-FRAME | No shared page container | Medium | Fixed | `src/ui/Page.tsx` with Page, PageHeader and SectionHeader. Settings, Sources, the library pages, VOD pages and the archive use it. |
| DS-RAIL-CARD-DRIFT | Rails and cards differ on Home, Movies and My Videos | Medium | Partial | Library cards share `CARD_ART` and `CARD_ROOT`, and round 2 fixed rail clipping. VOD posters still use their own caption spec, not Home's. |
| DS-FOCUS | Focus ring heavy, lost in High Contrast | Medium | Fixed | A lighter glow, a border focus on fields, and a forced-colors Highlight outline. |
| DS-ICON-SCALE | Icons ignore the Interface size setting | Medium | Fixed | Lucide sizes from 11 to 32 px scale in rem. |
| DS-SEMANTIC-FILLS | Amber, danger and LIVE fills change between themes | Medium | Fixed | Solid danger and LIVE fills with white text and one LivePill. Each light accent got one bright fill in `e095f09`. |
| DS-TOUCH-TARGETS | No larger size for touch | Medium | Fixed | 44 px targets under a coarse pointer. |
| DS-MOTION-EXIT | Overlays vanish in one frame | Low | Fixed | `usePresence` keeps Dialog, Menu, the live context menu and the scope picker mounted while they animate out; drawers slide. |
| DS-GLASS-ADHOC | Player chrome skips the glass tokens | Low | Fixed | Multi-view and player chrome use the glass tokens; the player package swept the rest. |
| DS-KIT-HYGIENE | Dead and off-scale kit pieces | Low | Fixed | Dialog and Menu use IconButton, and there is one link style. Pagination still has no callers and was left in place. |

### SH: shell and Home (B-)

| ID | Finding | Severity | Status | Note |
| --- | --- | --- | --- | --- |
| SH-brand-mismatch | Three logos and an off-palette app icon | High | Fixed | Same work as DS-BRAND-MARK. |
| SH-welcome-generic | First-run Home is a generic empty state | High | Fixed | `Welcome.tsx` with the mark, the source-kind tiles, Import a backup and a privacy line. The add dialog opens in place. |
| SH-home-empty-m3u | Home stays almost empty for M3U sources | High | Fixed | An On now rail with programme art, a channels rail, and Get started tiles while Home is quiet. |
| SH-titlebar-theme | The desktop title bar ignores the theme | High | Partial | ThemeSync sets the window theme. With an explicit theme opposite to the OS, the bar shows the OS colour for a moment at launch; fixing that needs window setup in Rust. |
| SH-rail-ia | Flat rail of 12 links | Medium | Partial | The rail is grouped into Watch, Library and Sources, and each source remembers whether it is open. There are no top-level Live TV, Movies and Series links; phones get a Live TV tab. |
| SH-native-tooltips | Icon chrome uses native title tooltips | Medium | Fixed | Kit tooltips on all shell chrome. |
| SH-hero-skeleton-flash | A hero skeleton flashes on every launch | Medium | Fixed | Home remembers that the hero is empty and skips its skeleton. |
| SH-pwa-manifest | Manifest and icons not production-ready | Medium | Fixed | Maskable and opaque Apple icons, an id, a description and shortcuts. The manifest has no screenshots. |
| SH-no-webfont | No brand type outside Windows and macOS | Medium | Fixed | Same work as DS-FONTS-PLATFORM. |
| SH-ctrl-r-browser | Ctrl+R opens Recently watched in the browser | Medium | Fixed | Ctrl+R is a desktop-only shortcut; the browser reloads. |
| SH-offline-stack | Three error surfaces when the server is down | Medium | Fixed | One connection banner after 3 s offline, with Try again. |
| SH-alerts-gutter | Alerts use another side gutter on phones | Low | Fixed | |
| SH-quiet-live-path | Browse live TV ignores the source home path | Low | Fixed | |
| SH-kind-labels-copy | Inconsistent source-kind labels | Low | Fixed | One `kindShortKey()` for the rail and Home. |
| SH-cancel-returns | Cancelling Add source leaves Home | Low | Fixed | Cancel stays on Home. |
| SH-live-pill-noise | A LIVE pill on every Home channel card | Low | Fixed | The progress bar is the live cue. |
| SH-boot-skeletons | Two boot skeletons and a blank page before JavaScript | Low | Fixed | A static splash in `index.html` and one shell skeleton. |
| SH-touch-chrome | Keyboard-only chrome on phones | Low | Fixed | Shortcut buttons and key hints are hidden on coarse pointers. |
| SH-trending-dead-end | Trending posters open searches that may be empty | Low | Fixed | Trending cards are checked against the catalog and say "Find in your sources". |

### LG: Live TV, guide, multi-view and lists (B-)

| ID | Finding | Severity | Status | Note |
| --- | --- | --- | --- | --- |
| LG-01 | The guide doesn't know what is playing | High | Fixed | The playing row is marked, and the guide opens on the playing channel and group. Typing a number jumps to that row. The GPT-6.1 fix `0757955` retries focus links until the channel is found. |
| LG-02 | A third of the Live stage column is blank | High | Fixed | The ribbon header is a Now card with art, progress and description, with Up next below. |
| LG-03 | Four lines of text in 64 px rows | Medium | Fixed | Three-line rows of 68 px. |
| LG-04 | Touch users can't favorite or open the channel menu | High | Fixed | The star and a Channel options button show on touch; a long press opens the menu. |
| LG-05 | Mini player Expand can open another source | Medium | Fixed | `expandPath()` opens the playing channel's own page, Favorites and Recently watched views included. Round 2 fixed it for recordings and the guide band. |
| LG-06 | The ribbon header sticks on the last hovered programme | Medium | Fixed | Hover previews, a click pins, and Back to now returns. |
| LG-07 | The list page keeps the old letterboxed stage | Medium | Fixed | Lists use the shared LiveStageColumn. |
| LG-08 | Catch-up goes by three names | Medium | Fixed | "Catch-up" in every locale. |
| LG-09 | Catch-up plays in the corner mini player | Medium | Fixed | The catch-up page has its own 16:9 stage. |
| LG-10 | A guide with no EPG looks broken | Medium | Fixed | An empty-state card with Add guide. |
| LG-11 | Native selects in the guide | Medium | Fixed | A ScopePicker combobox, whose list loads lazily since round 2. Sources without live channels are not offered. |
| LG-12 | No Favorites group on Live | Medium | Fixed | Favorites and Recently watched are pinned in the Live and Radio sidebars. |
| LG-13 | Lists built one channel at a time | Medium | Fixed | One channel menu for Live, Radio, lists and the guide, Add all to list on groups, and Add channels on the list page. |
| LG-14 | Logos on a theme plate; missing logos all look alike | Medium | Fixed | Coloured monograms. Since round 2 the idle glow takes its hue from the logo. |
| LG-15 | Selection and "now" colours vary by component | Medium | Fixed | One selected and one playing style. |
| LG-17 | About three rows of list room on a playing phone | Medium | Fixed | The phone ribbon folds to one line. |
| LG-19 | The multi-view picker can't browse groups or lists | Medium | Fixed | A Show picker for groups, favorites and lists. |
| LG-16 | Hand-rolled menus, search fields and badges | Low | Fixed | Search fields and LIVE pills use the kit. The cursor menu copies the kit Menu but stays its own component, because the kit Menu opens only from a trigger. |
| LG-18 | Hidden now dot, no current time, rows ignore density | Low | Fixed | A now pill in the ruler; rows follow density and UI scale. |

### VL: movies, series, search and library (B-)

| ID | Finding | Severity | Status | Note |
| --- | --- | --- | --- | --- |
| VL-hero-actions | Up to nine large buttons bury Play | High | Fixed | One primary Play or Resume, Trailer, round icon buttons and a More menu. |
| VL-landing-index | The landing is a text list of categories | High | Fixed | Continue watching, Recently added, Top rated and category rails. |
| VL-tmdb-deadend | More like this opens empty searches | High | Fixed | More like this and Known for show only titles the catalog has. |
| VL-detail-empty-no-tmdb | With TMDB off a movie page ends at the hero | Medium | Fixed | Other sources, More in the category, an About block and a one-time TMDB card. |
| VL-start-over-unwatches | Start over deletes the watched mark | Medium | Fixed | `fromStart` skips both resume sources instead of deleting the position. The GPT-6.1 follow-ups (a restart of the same URL, recovery forgetting Start over) are fixed in `9f8a949`. |
| VL-grid-toolbars | Two or three stacked toolbars on category grids | Medium | Fixed | One toolbar with a Filters button. |
| VL-hero-chrome | Dimmed backdrop under an opaque header | Medium | Partial | The backdrop shows at full strength. Since round 2 the header shows the section until the title scrolls away. A transparent header over the hero is an owner decision. |
| VL-download-feedback | Downloads finish or fail silently | Medium | Partial | Toasts for finished and failed downloads. A rail badge is an owner decision. |
| VL-offline-play | A downloaded title still streams | Medium | Fixed | Plays the file while it is on disk, per episode too. |
| VL-library-cards | My Videos cards have their own style | Medium | Fixed | |
| VL-page-rhythm | Gutters and poster sizes change per screen | Medium | Fixed | VOD pages use Page and the page gutter. |
| VL-fixed-height-pages | Library pages hard-code 100dvh | Medium | Fixed | A test keeps 100dvh out of those pages. |
| VL-mylist-rows | My List rows can't play | Medium | Fixed | A poster grid by default, with progress, Play and Resume. |
| VL-cancel-recording | One click cancels a recording | Medium | Fixed | An Undo toast. |
| VL-search-title-dup | Search and My Video detail show the title twice | Low | Partial | Search shows its title once. My Video detail still has the header title and its own Back pill. |
| VL-watchstage-letterbox | Black bars above 1700 px | Low | Fixed | |
| VL-next-episode-live | The countdown announces every second | Low | Fixed | |
| VL-clear-finished-copy | "Clear finished" removes failed downloads | Low | Fixed | Now "Clear failed". |
| VL-search-locks | Search hides parental locks | Low | Fixed | `useSearchLocks`. |
| VL-stats-interaction | The stats chart responds only to clicks | Low | Fixed | KPI tiles and a hover card. |
| VL-upnext-strip | Up next scrolls with a hidden scrollbar | Low | Fixed | Edge fades and wheel scrolling. |
| VL-category-row-nit | Divider curls at rounded corners | Low | Fixed | |

### SS: sources, settings and onboarding (B-)

| ID | Finding | Severity | Status | Note |
| --- | --- | --- | --- | --- |
| SS-1 | Source dialogs discard typed details | High | Fixed | A backdrop click does nothing while the form has changes, and Escape, Cancel and the X ask first (`useDiscardGuard`). GPT-6.1 found that a pending guide URL in Edit escapes the guard; see follow-ups. |
| SS-2 | Focus starts on the kind tab; Name comes first | Medium | Fixed | Focus starts on the address field, and Name comes after the connection fields. |
| SS-3 | Reset all edits unreachable for renames only | Medium | Fixed | "Hidden and renamed channels" in each card's menu. |
| SS-4 | The auto-refresh hint gives the wrong schedule | Medium | Fixed | It reads the real interval. |
| SS-5 | New connection details don't reload the source | Medium | Fixed | |
| SS-6 | First run takes about eight interactions | Medium | Fixed | Welcome adds the first source in place and moves to its page, where the tour is one coach card. |
| SS-7 | Settings navigation moves around | Medium | Fixed | A grouped side list (App, Watching, Household, System), and a section list on phones. |
| SS-8 | General is a 25-row catch-all | Medium | Fixed | Rows moved to Appearance, Recording and Backup and storage, which ends in a danger zone. |
| SS-9 | Hand-rolled settings inputs | Medium | Fixed | Kit controls, and a test that checks every settings field. |
| SS-10 | Sources toolbar too heavy for one source | Medium | Fixed | New cards. Sort and filters appear with three or more sources, behind one View button since round 2. |
| SS-11 | "Source", "playlist" and "portal" mixed | Medium | Partial | Settings and sources say "source" throughout. About 50 "Could not" strings remain in other namespaces. |
| SS-12 | About reads like a developer build screen | Medium | Fixed | A product page, with diagnostics folded away. |
| SS-13 | Source dialogs float on phones | Medium | Fixed | Bottom sheets. |
| SS-15 | No warning that a PIN can't be recovered | Medium | Fixed | The warning is in place. Recovery itself is still unbuilt (2026-10-19 audit). |
| SS-14 | Stacked tab bars in the Add dialog | Low | Fixed | |
| SS-16 | An invalid guide shift is dropped on Save | Low | Fixed | |
| SS-17 | The save mark sits in a covered corner | Low | Fixed | Saved marks sit beside the row that changed. |
| SS-18 | Raw English core messages | Low | Fixed | A translated sentence first, with the core's text under it. |
| SS-19 | What's new lists desktop items in the browser | Low | Fixed | |
| SS-20 | Guide status rows lead with the raw URL | Low | Fixed | |

### PL: player (B-)

| ID | Finding | Severity | Status | Note |
| --- | --- | --- | --- | --- |
| PL-SPACE-CLICKED-CONTROL | Space presses the last clicked control | High | Fixed | A mouse press no longer focuses bar buttons. |
| PL-MENU-OUTSIDE-CLICK | Clicking the picture pauses and leaves the menu open | High | Fixed | An outside press closes the menu without pausing. |
| PL-IOS-FULLSCREEN | iPhone fullscreen only flips the icon | High | Fixed | Falls back to `webkitEnterFullscreen` on the video. |
| PL-LIGHT-THEME-ACCENT | Deep page accent over video in light | High | Fixed | The glass override covers every player surface. |
| PL-ERROR-DEAD-ENDS | Errors name actions they don't offer | Medium | Fixed | `ErrorActions` picks buttons per failure. The GPT-6.1 follow-ups (stale recoveries, Play as HLS offered for VOD) are fixed in `9f8a949`. |
| PL-STALE-PROGRAMME | The title bar keeps an ended programme | Medium | Fixed | The title bar and OS media controls follow the airing programme. |
| PL-NATIVE-CONTEXT-MENU | Right-click opens the browser menu | Medium | Fixed | |
| PL-NATIVE-TOOLTIPS | Native tooltips on player chrome | Medium | Fixed | |
| PL-MUTED-AUTOPLAY | Reload restores playback silently muted | Medium | Fixed | An unmute prompt. |
| PL-BAR-HIERARCHY | Ten equal-weight icons | Medium | Fixed | A 48 px play button, 10 s skip buttons for VOD, and times at the seek bar ends. |
| PL-TOUCH-ERGONOMICS | Desktop-sized touch targets | Medium | Fixed | 44 px controls and a 36 px seek area under a coarse pointer. |
| PL-SYNC-DEAD-ROW | Sync menu all disabled in the browser | Low | Fixed | Sync is hidden while nothing in it can change. |
| PL-MENU-A11Y | Menu triggers announce as toggles | Low | Fixed | |
| PL-COPY-I18N | Copy and i18n slips | Low | Fixed | |
| PL-DUPLICATE-CHROME | Duplicate LIVE marks and titles | Low | Fixed | One live mark. Since round 2 the watch view shows the title once. |

### SR: ship readiness (C)

| ID | Finding | Severity | Status | Note |
| --- | --- | --- | --- | --- |
| SR-1 | Nothing to download | High | Partial | `release.yml` builds the installer and a multi-arch image from `v*` tags, and `image-latest.yml` moves `latest` on publish. Nothing is published until the owner settles the version and pushes a tag. |
| SR-2 | No third-party licence notices | High | Partial | `tools/third-party-notices.mjs` writes `THIRD_PARTY_NOTICES.md` for each release, the installer and the image, and NOTICE carries IPTVnator's MIT notice. Settings > About has no licences link. |
| SR-3 | Three unrelated brand marks | Medium | Fixed | Same work as DS-BRAND-MARK. |
| SR-4 | Server mode over plain HTTP; no TLS or auth recipe | Medium | Partial | `deploy/` runs Caddy with HTTPS and basic auth, and the UI shows a one-time notice when the page is not a secure context. Copy actions have no fallback on plain HTTP, and Safari is untested. |
| SR-5 | Placeholder installer identity | Medium | Owner decision | Copyright, homepage and descriptions are set. Identifier, publisher, binary name, NSIS languages and the `iptv://` scheme need the owner (checklist item 10). |
| SR-6 | The updates panel points users at the README | Medium | Fixed | |
| SR-7 | The README reads as a developer manual | Medium | Fixed | A product page with six screenshots (`e8eea35`); the manual moved to `docs/user-guide.md`. |
| SR-8 | Minimal PWA manifest and meta | Low | Fixed | `package.json` still describes the app as "IPTVnator rebuilt on Tauri 2 with a Rust core". |
| SR-9 | What's new shows desktop items in the browser | Low | Fixed | |
| SR-10 | CI never builds the image, runs e2e or checks advisories | Low | Fixed | ci.yml gained cargo-deny, msrv, docker and tauri-build jobs; e2e.yml runs Playwright; Dependabot covers npm, cargo and Actions. |
| SR-11 | No OCI labels; Debian 12 base | Low | Partial | Labels added. The images are still on bookworm. |
| SR-12 | Public docs read as an agent build log | Low | Partial | Rust version claims agree at 1.90, with an msrv job. `docs/SPEC.md` line 7 still says "stable 1.96", and SPEC.md and this folder are still in the public tree. |
| SR-13 | Brand type only on Windows and Apple | Low | Fixed | Same work as DS-FONTS-PLATFORM. |

### FW: wiring, front to back (C+)

| ID | Finding | Severity | Status | Note |
| --- | --- | --- | --- | --- |
| FW-M3U-MOVIE-URL | M3U movies can't play or download | Critical | Fixed | `catalog.item` returns the URL and headers for M3U movies only, after the parental check (`2a309d8`). The new e2e spec `m3u-vod` plays and downloads one. |
| FW-M3U-SERIES-MIGRATION | Existing M3U sources never get series grouping | High | Fixed | Each import records its version, start-up re-imports older catalogs once, and pasted or uploaded playlists get Re-import. `IMPORT_VERSION` moves to 4 with the GPT-6.1 fixes. |
| FW-M3U-SERIES-PARENTAL | Grouping drops group locks | Medium | Fixed | A movie group's lock and hidden flag carry over to its series category. |
| FW-ARCHIVE-DOWNLOAD-UNBOUNDED | Catch-up downloads can run forever | Medium | Fixed | Download is offered only for archive links that end on their own; shift and Flussonic TS links can only play. |
| FW-ERROR-HINT-LEAD | Error descriptions lead with a generic hint | Medium | Fixed | The UI's own message comes first; the browser hint drops the external-player advice. |
| FW-CI-COVERAGE | CI skips e2e, Docker and the desktop build | Medium | Fixed | e2e.yml, docker and tauri-build jobs. CI run 1 compiled the branch's Rust for the first time. |
| FW-DEAD-RPC | 13 registered commands are never called | Low | Not done | No fixer took it. `catalog.allLiveChannels` and `remote.publishChannels` are still registered with no caller (checklist item 13). |
| FW-REMOTE-LIST-STALE | The phone list misses hidden groups | Low | Fixed | Hiding live groups or changing English only refills it. |

### CB: competitive benchmark (B)

| ID | Finding | Severity | Status | Note |
| --- | --- | --- | --- | --- |
| CB-GUIDE-PREVIEW | No live preview or details band in the guide | High | Fixed | A preview band with its own stage, from md up on windows at least 700 px tall. Starting playback in it automatically needs a new setting. |
| CB-GUIDE-GENRE | No genre colours or filters | Medium | Fixed | Genre stripes and filter chips. A setting to turn the colours off needs the core. |
| CB-PROGRAM-ART | Programme images never shown | Medium | Fixed | The Now card and the On now rail show them. |
| CB-VOD-LANDING | The landing is one rail and an index | Medium | Partial | Rails landing done. Pin to Home needs a new persisted setting. |
| CB-CONTINUE-MENU | Continue watching cards can only play | Medium | Fixed | Details, Mark watched and Remove with Undo, on cards and hero slides. |
| CB-AUTOPLAY-LAST | Live never resumes the last channel | Medium | Partial | The idle stage offers Resume for the last channel. Starting it on its own needs a new setting. |
| CB-TYPEFACE | No bundled typeface | Medium | Fixed | Same work as DS-FONTS-PLATFORM. |
| CB-PHONE-NAV | Desktop rail on phones | Medium | Fixed | A tab bar below 640 px: Home, Live TV, Guide, Search and More. |
| CB-TITLE-LOGOS | No TMDB title logos | Low | Not done | Needs TMDB image requests in the core. |

## GPT-6.1 review of f4549d1

84 findings: 6 high, 52 medium, 5 low, and 21 translation fixes without a severity. 77 are fixed, 3 partly, 1 was still being fixed when this was written, 1 was wrong, and 2 were never assigned. Commits marked (a) or (b) are on saas/rustfix-a or saas/rustfix-b.

| Group | Findings | Fixed | Partial | Other | Commits | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Rust core | 3 | 2 | 0 | 1 in progress | `5b065ff`, `936d1e8`, `da63250` (a) | playlist-file-after-commit is the same bug as staged-text-crash-loss. An i64::MIN guide shift in a backup no longer panics. refresh-admission-race (two refreshes queued behind a partial sync each run a full import) was still with the fixer. |
| Rust M3U | 7 | 6 | 1 | | `5b065ff`, `936d1e8`, `0538d16`, `8fec6de` (a) | Favorites, positions and locks follow episodes through a token rotation; staged text survives a crash; The Office [US] and [UK] stay apart; plain tvg-names name the show. Episode ids no longer follow playlist order, but when the first-by-name version of an episode leaves, the next one takes its id. |
| Rust hosts | 4 | 4 | | | `261008d`, `224b321`, `a253612`, `9f37a42` (b) | Trust only the source's exact host and port; the Origin must match scheme, host and port; the proxy resumes only with a validator; windowStart applies after an early reveal. |
| Rust portals | 6 | 5 | 1 | | `1ebb34e`, `5876b99`, `6e9dda1`, `5470f5d`, `e3b7e93` (b) | Long list requests get a read timeout longer than their head wait; Stalker scrubs credentials in arrays and stops at the first empty page. guide-search-shift-window is partial. Provider guides now follow guide shifts, which moves catch-up requests (checklist item 12). |
| Security | 5 | 5 | | | `e90b21d`, `e32bb9d`, `cda5adf` (a), `261008d` (b), `bbf4544`, `9fb6f69` | Server mode records only over the guarded HTTP copy. Playlists can't send `file:` or UNC paths to native players. Xtream headers export only with secrets, and the UI no longer calls a backup without passwords safe to share. Cleared searches stay cleared across tabs. |
| Docs and CI | 3 | 3 | | | `0dead7b` | Backup, recording-delete and NOTICE claims corrected. |
| e2e | 12 | 11 | | 1 wrong | `4346c29`, `d7f9c02` | xtream-password-role was wrong, because Playwright 1.64 gives a password input the textbox role. New specs: m3u-vod, phone-tabs and welcome. All were checked only against the screenshot mock. |
| Kit | 6 | 6 | | | `806fbe7` | A 3:1 ring on the selected segment, glass focus and track, hoverable tooltips, forced-colors marks, keyboard tooltips and Escape-back. |
| Shell | 2 | 2 | | | `7ecb543` | Focus after removing a Continue watching card; Library reopens per page. |
| Live | 5 | 4 | 1 | | `d5845b9`, `0757955`, `80c4ab0` | Pickers search inside their scope and page past 1,000 rows; focus links retry; the idle stage hides a locked channel's programme. picker-epg-request-cascade is partial. Favorites and Recent still look up on-screen rows one `catalog.item` at a time, because the core has no batch command. |
| Player | 4 | 4 | | | `9f8a949` | `playGeneration` reloads a new play of the same URL; recoveries stop after Stop or a newer play; Start over survives recovery; Play as HLS is only for live and radio. |
| VOD | 4 | 4 | | | `c35dd12`, `42b3a91`, `9fb6f69`, `729b466` | Recent searches hidden under Hide mode and while parental status is unknown; My List keeps focus after Delete; Stalker rails honour Hide watched; Top rated dropped for Stalker. |
| Settings and sources | 2 | 0 | | 2 not assigned | none | optional-name-blocks-paste and guide-url-escapes-discard-guard were left out of the fix assignments (see follow-ups). |
| Translations, European | 11 | 11 | | | `7b03743` | German and Hungarian formal address, Dutch informal, Brazilian Portuguese terms, Polish, Belarusian and Turkish wording. |
| Translations, other | 10 | 10 | | | `7b03743` | Arabic duals, the server and web-edition messages in Arabic, Darija, Korean and Chinese, and one name each for Continue watching, Favorites and the palette. |
| Total | 84 | 77 | 3 | 4 | | |

## Round 2 issues

The round-2 critics and reviewers filed 99 issues on the integrated branch: 10 high, 39 medium and 50 low (73 visual, 26 from code review). All ten high issues are fixed.

| Area | Issues | Fixed | Partial | Not done | Commits | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Shell and Home | 26 | 21 | 3 | 2 | `036af67` | Detail pages show Back and the section in the header, then the title once the hero scrolls away. The phone hero, the palette, the rail's current mark, the More tab's current state and the duplicate import toasts are fixed, and series resumed from Home now play the next episode. Partial: phone welcome tiles, and the header search slot (Movies categories and My List keep their own toolbar fields). Not done: the More tab stays lit on a source's Movies and Series pages by design, and dashboard rails hand-build their header until SectionHeader gets a meta slot. |
| Kit | 11 | 10 | 0 | 1 | `2d68ac8` | An accent mark tone, so ticks and progress are not brown in light; Slider; FilterChip; one WatchedChip; ProgressBar reports percentages; the dialog close button sits on the title line. Not done: the flat light chrome (grey header over a white rail), which belongs to the shell. |
| Player | 4 | 4 | 0 | 0 | `f129c2c`, `908cb3b` | A full-width phone mini bar above the tab bar; Expand goes to the playing title's page; RTL sliders fill from the right side; the programme follower asks the guide less often. |
| Settings and sources | 18 | 15 | 3 | 0 | `4cb521a`, `7aaf2e5`, `e095f09` | "Settings" no longer appears twice on phones; a View button replaces three bordered selects; light accents got bright fills. Partial: the Toggle description wraps one word alone, the image cache hint is still long, and What's new has no release date. |
| Movies, series and library | 19 | 17 | 1 | 1 | `81468a1`, `aa8b417` | The watch view shows the title once; recordings show their own cards; search Top results, Downloads retry and the Stats chart are fixed; Search, Settings and category pages no longer load the player controls. Partial: Live and Guide still load the 69 kB Controls chunk. Not done: Poster size still skips Home's and My List's rails. |
| Live TV and guide | 19 | 18 | 0 | 1 | `54c69b2`, `1b577ab` | Opaque airing cells with a red now stub, so the now line no longer strikes through titles; the idle card and ribbon describe one channel; the archive layout; the phone guide fits two control rows; portaled menus; the scope picker loads lazily. Not done: `/lists` still opens the first list, a product decision. |
| Translations | 1 | 1 | 0 | 0 | `7b03743` | German formal address in the new strings. |
| Not assigned | 1 | 0 | 0 | 1 | | Hero slide controls come before the slide's own actions in tab order. |
| Total | 99 | 86 | 7 | 6 | | |

## Owner decisions and release checklist

Settle these before the first public tag. "Now" is the state at `e8eea35` with the Rust branches.

| # | Item | Now | To do |
| --- | --- | --- | --- |
| 1 | Licence | None chosen. The workspace Cargo.toml has `license = "MIT"` as a placeholder. README says no licence is chosen, and the installer's copyright line names none (`38ab5ee`). NOTICE carries IPTVnator's MIT notice. | Choose one. Add a LICENSE file, fill the README line, set Cargo.toml's `license`, add the `org.opencontainers.image.licenses` label, and add the licence to deny.toml and about.toml if they need it. |
| 2 | Version | 0.2.0 in package.json, Cargo.toml, tauri.conf.json and `notes.ts`. The redesign is under Unreleased in CHANGELOG.md. release.yml refuses a tag that doesn't match package.json, Cargo.toml and tauri.conf.json. | Either release 0.2.0 (move Unreleased into 0.2.0 and add the redesign to `notes.ts`), or bump to 0.3.0 in all four places, run `cargo update -w`, and add a release-notes entry so What's new fires. |
| 3 | Code signing | Unsigned. SmartScreen warns on the installer and the exe. | Get a certificate and add the signing setup to release.yml. |
| 4 | Updater key and feed | `tauri.conf.json` points at `https://example.invalid/tsrust-iptv/latest.json` with an empty pubkey. The updater feature is off, and release.yml sets `includeUpdaterJson: false`. | Generate a key, host `latest.json`, turn on updater artifacts, and enable the feature. |
| 5 | Private vulnerability reporting | Off. SECURITY.md asks reporters to open a detail-free "Security contact" issue. An HTML comment in it holds the `gh api` command and the replacement paragraph. | Turn it on and swap in the paragraph. |
| 6 | ghcr package visibility | No image has been pushed. New packages may start private. The arm64 image job runs on `ubuntu-24.04-arm`, which is free only while the repository is public. | After the first push, make the tsrust-iptv package public. When publishing, wait for the image jobs, or re-run "Image latest tag" afterwards. |
| 7 | Advisories | cargo-deny reports six advisories, four in rustls 0.23.45 and two in quick-xml 0.37.5. The advisories job doesn't fail CI. | `cargo update -p rustls` to 0.23.46 or later (lockfile only). Raise quick-xml from 0.37 to 0.41 or later in Cargo.toml and adapt `crates/iptv-core/src/epg/xmltv.rs`. The lockfile already has quick-xml 0.42.0 for another dependency. |
| 8 | mpv bundling and its GPL notice | The release builds the standard installer only, and the built-in player is the default. `vendor/mpv/LICENSE.txt` offers source through the issue tracker "or the contact address published with the release", and no address is published. | Decide whether to publish an installer with mpv. If so, attach the mpv, FFmpeg and libplacebo sources or honour the written offer, and publish a contact address or drop that phrase. |
| 9 | Stalker sort menu | Top rated is gone from Stalker landings (`42b3a91`). CategoryGridPage still offers Rating and Year sorts and the direction flip for Stalker, but `stalker/vod.rs` knows only name and added, so those sorts silently fall back to Added. | Limit the menu to Added and Name for Stalker (choose the direction rule and the copy), or add the sorts in the core. |
| 10 | Installer identity | Identifier `com.philly.tsrustiptv` fixes the data folder; publisher "philly"; the exe is `iptv-tauri.exe`; the installer is English only; the app registers the generic `iptv://` scheme. | Settle all of them before the first public build. The identifier can't change afterwards without moving users' data. |
| 11 | Server login | Server mode has no login of its own. `deploy/` puts Caddy basic auth in front of it. A reported problem with basic auth and WebSockets in Safari is documented but untested. | Decide whether to build a login. Test the recipe in Safari on iOS and macOS, and move to forward_auth with a cookie login if the connection message stays on screen. |
| 12 | Which clock provider guides use | `5470f5d` (b) moves Xtream and Stalker provider guides by the source and channel guide shifts. Catch-up URLs are built from the shifted start, so a shift set to correct an XMLTV feed now makes panel catch-up ask for the wrong hour. | Keep the provider's times for its own guide (revert `5470f5d`), or carry the provider's original start with each programme and build catch-up URLs from it. |
| 13 | Dead commands | `catalog.allLiveChannels` and `remote.publishChannels` lost their only caller; 13 registered commands are never called from the UI. | Keep `remote.publishChannels` only if an outside client needs it and say so in remote.md; otherwise drop both with their tests. |
| 14 | Public internal docs | SPEC.md and `docs/audits/` sit in the public tree, and SPEC.md still says "stable 1.96". | Move them to `docs/internal/` or a wiki, or keep them public on purpose. Fix the 1.96 line either way. |

Product and design calls the fixers left open, none of which blocks a release:

- A transparent header over detail heroes. Both the shell and VOD fixers declined it because of the rule that the header sits on `bg-bg/95` for performance.
- A downloads badge in the rail (VL-download-feedback). DownloadWatcher already loads `downloads.list` once the player chunk loads, so a badge could read that cached query.
- New persisted settings, each of which needs the core: start the last channel automatically (CB-AUTOPLAY-LAST), autoplay in the guide preview band, a genre colour toggle, Pin to Home for VOD categories, and TMDB title logos (CB-TITLE-LOGOS).
- Whether Start over on a downloaded title should clear its watched mark.
- A `/lists` overview page instead of opening the first list.
- Renaming Scheduled to Recordings, and top-level Live TV, Movies and Series links in the rail.
- Rail density (`--rail-item-height`), the recording trigger glyph, and per-theme chart tokens for the light Stats chart.
- Whether to delete the unused Pagination component.
- A Debian 13 (trixie) base for the Docker image.
- The product decisions at the end of the 2026-10-19 feature audit (macOS and Linux builds, PIN recovery, profiles, casting and the rest). None of them changed.

## Known remaining issues and follow-ups

Rust, landing from saas/rustfix-a and saas/rustfix-b:

- refresh-admission-race in `crates/iptv-core/src/sources/mod.rs` (around line 1958) had no commit yet when this was written; the fixer on saas/rustfix-a was still working on it.
- Guide search with shifts is partial (`crates/iptv-core/src/epg/search.rs`, `docs/architecture/guide-search.md`). A programme that only a channel's own shift or tvg-shift moves into the window is still missed, and a search can return fewer hits than its limit. A repair pass on saas/rustfix-b was working on it.
- The Origin check now needs `X-Forwarded-Proto` from an HTTPS reverse proxy (`224b321`). Caddy sends it, nginx doesn't by default. `server.md` and SECURITY.md say so; `deploy/README.md` and `docs/user-guide.md` don't yet. The same repair pass had this.
- The compile review of saas/rustfix-a found two edge cases around staged playlist text. A merge restore of a backup can be overwritten by an older staged update that failed to move (`crates/iptv-core/src/backup/import.rs`, around line 1297). A source switched from pasted text to a URL with a failed move still pending fails every refresh (`crates/iptv-core/src/m3u/importer.rs`, around line 759). The review gives a fix for each.
- Episode ids are only partly stable (`crates/iptv-core/src/m3u/series.rs`). The full fix reuses the previous import's ids and needs a compiler.
- `IMPORT_VERSION` 4 makes every M3U source re-import once after the upgrade. Series ids for shows with country tags, and episode ids for extra versions of an episode, change once, so per-episode positions and watched marks on those are lost once. No version has been released, so only development databases are affected.
- Two new Rust tests assume reqwest 0.12's read timeout also covers the wait for the response head, which the fixer could not confirm. A new Stalker guide test uses the fixed port 7207, next to the 7205 and 7206 that other tests use.
- A narrow race in `crates/iptv-tauri/src/lib.rs` (around line 528) can make a fullscreen start run on a still-hidden window. The reviewer rated it low and optional.

Frontend:

- Live and Guide still load the 69 kB player Controls chunk before their first render, because `src/features/player/index.ts` re-exports PlayerDock. `tools/check-bundle.mjs` marks both routes `pending`. Import the dock from its own module in ShellLayout and drop the export.
- On phones the mini bar covers the last 64 px of a page. PlayerDock sets `--player-bar-inset`, but the shell's `<main>` doesn't pad by it (`src/shell/ShellLayout.tsx`).
- My Video detail still shows the header title and its own Back pill (`src/features/library/pages/MyVideoDetailPage.tsx`, around line 482).
- Category grids and My List keep their own search fields instead of the header search slot (`src/features/vod/pages/CategoryGridPage.tsx` around line 644, `src/features/mylist/components/MyListToolbar.tsx` around line 76).
- The Poster size setting doesn't reach Home's rails or My List's rail, which don't use `useRailCardWidth`.
- The hero's slide controls come before Resume and Details in tab order (`src/shell/dashboard/HeroCarousel.tsx`).
- Two GPT-6.1 findings were never assigned. A pasted playlist with an empty, optional name fails validation (`src/features/sources/lib/draft.ts`, `buildAddArgs`), and a pending guide URL in the Edit dialog escapes the discard guard (`src/features/sources/components/EpgLinksEditor.tsx`). Neither was checked by a fixer.
- Favorites and Recent in the channel pickers look up on-screen rows one `catalog.item` call at a time. A batch command in the core would remove that.
- The light theme's chrome is flat, with a grey header over a white rail and white panes (`src/shell/Rail.tsx`, `Header.tsx`).
- Smaller kit gaps remain. The multi-view empty-state layout picker (`src/features/multiview/components/EmptyIntro.tsx`) is hand-rolled, the Toggle description in `src/ui/Field.tsx` needs `text-pretty`, SectionHeader has no meta slot, VOD posters don't use Home's caption spec, and recording fallback tiles all share one colour (`src/ui/Poster.tsx`).
- Copy actions fail on plain HTTP with no fallback, and Settings > About has no Open-source licences link (SR-2, SR-4).
- `package.json` still describes the app as "IPTVnator rebuilt on Tauri 2 with a Rust core".
- A guide focus link scrolls its row to the top of the grid instead of the middle.
- Some timing tests fail under load: lists sortable, the guide's gridLoad and gridPerf, and two tests in `src/features/live/test/stalkerGridArchive.test.tsx`. The two Stalker tests also fail on `7b03743` and `f4549d1` when run alone on a loaded machine. They may point at a real guide bug and need a look on a quiet machine. In CI run 1, one frontend test of 4,790 failed, on a timeout.

Tests and fixtures:

- The e2e fixer could check the specs only against the screenshot mock, and neither CI run included Playwright. The three new specs (m3u-vod, phone-tabs, welcome) depend on core behaviour the mock only faked: M3U series grouping, the movie's User-Agent from `catalog.item`, mp4 range requests through the proxy, a finished download, and a playlist text update followed by a refresh. Run e2e.yml by hand before the first tag.
- `crates/iptv-mock/src/catalog.rs` and `fixtures/sample.m3u` still use real broadcaster and programme names. The README screenshots came from the invented-data mock, so this matters only if someone captures from `iptv-mock` (`docs/screenshots/README.md`).

## CI state at publication

GitHub has the branch at `41f86e2`. The 16 commits merged after it (the GPT-6.1 frontend, docs and e2e fixes, and the README screenshots) and the Rust fixes on saas/rustfix-a and saas/rustfix-b had not been through CI when this was written.

- CI run 1 compiled all of the Rust for the first time. Before today none of it had ever been compiled, because nothing on gmk1 can build Rust. On Linux it built and passed every test except `mpv_commands_without_session`. rustfmt flagged seven layouts. The frontend job passed 4,789 of 4,790 tests; the one failure was a timeout. `41f86e2` fixed all three.
- In CI run 2 the Linux Rust job and the frontend job passed. Windows clippy failed on five lints that are new in the latest stable clippy, all in iptv-mock (`manual_is_multiple_of`, `chunks_exact_to_as_chunks`). A fix was in progress.
- cargo-deny reports the advisories in rustls 0.23.45 and quick-xml 0.37.5 without failing CI (checklist item 7).

<!-- final CI result -->
