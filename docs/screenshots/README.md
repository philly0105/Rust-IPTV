# Screenshots

The README shows these images. The current set was captured on 2026-10-20 from the production web build, against a mock API that serves only invented sources, channels, programmes and titles. Retake them whenever the interface changes enough that the README would mislead.

Capture them from the web build with made-up data only: no real provider, broadcaster, show or film. `iptv-mock` (`pnpm mock`) needs two changes first. Its movies, series, posters and backdrops are invented, and its logos are generated initials. But its live channels carry real broadcaster names (BBC One, CNN International, Sky News, Sky Sports and others), and so does `fixtures/sample.m3u`. Its guide mixes invented programme titles with real ones such as Newsnight, Grand Designs and Tom & Jerry Classics. Before capturing, replace those names in `crates/iptv-mock/src/catalog.rs` (`CHANNELS`, `NEWS_SHOWS`, `SPORTS_SHOWS`, `ENT_SHOWS`) on a scratch branch. Renaming channels in the app (Rename in a channel's right-click menu) fixes the channel names but not the programme titles that `live.png` and `guide.png` show.

| File | Screen | Used in |
| --- | --- | --- |
| `home.png` | Dashboard with the hero, Continue watching and a few rails | README, top |
| `live.png` | Live TV: group sidebar, channel list with now and next, the player docked | README, Live TV and the guide |
| `guide.png` | TV guide grid with the now line and a selected programme | README, Live TV and the guide |
| `movie-detail.png` | A movie's detail page with artwork, Resume and My List | README, Movies and series |
| `sources.png` | Sources page with an M3U, an Xtream and a Stalker source card | README, Quick start |
| `phone.png` | The phone layout (390 x 844), live TV or the dashboard | README, Remote and phones |

Desktop shots are 1280 x 800 CSS pixels, phone shots 390 x 844, both at device scale factor 2, in the dark theme unless a screen reads better in light. Save them as PNG and compress them (for example with `oxipng`) so each file stays small enough for the README to load fast.

For layout checks there is also `e2e/screens.spec.ts`, which captures the main screens against `iptv-mock` into `test-results/screens/` (see CONTRIBUTING.md).
