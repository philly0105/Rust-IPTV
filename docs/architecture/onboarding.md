# First-run tour and What's new

Code: `src/features/onboarding/`. Strings: `src/i18n/<locale>/onboarding.json` (19 locales). Tests: `src/features/onboarding/test/` and `e2e/onboarding.spec.ts`.

Two overlays help people find their way (contract C7):

- The tour: three steps that point at Live TV, Movies (My List when no source has movies), and search. It runs on its own once, after the first source is added, as a single card (the coach mark) on search and the command palette, with "Show me around" for the three steps. A source whose imports have all failed does not count, so it waits for one that imports.
- What's new: a dialog listing what changed since the version the user last saw, each item with an icon. It shows once per update.

Neither needs the core beyond the two settings markers, `app.info` and `sources.list`. The markers live in settings but are machine-local: they are not in `backup::APP_SETTING_KEYS`, so backups leave them out, unlike the preferences that travel in backups (the split is in [settings.md](settings.md)). They belong to this install.

## Settings markers (C1)

| Key | Default | Meaning |
| --- | --- | --- |
| `tourCompleted` | `false` | The tour was finished or skipped. |
| `lastSeenVersion` | `''` | The app version whose notes the user has seen. `''` or 1-32 characters of `[0-9A-Za-z.+-]`. |

`settings.reset` keeps both markers. A reset must not replay the tour or show What's new for an unchanged version. Use `openTour()` to replay the tour.

## The decision

`onboardingAction({ version, lastSeenVersion, tourCompleted, sourceCount })` in `decide.ts` is pure. `test/decide.test.ts` covers every branch.

| Inputs | Action |
| --- | --- |
| (A) `lastSeenVersion === ''`, no sources | `silent`: store `lastSeenVersion = version`. Nothing shows. |
| (B) `lastSeenVersion === ''`, sources | `whatsNew` with `since: ''`: notes for the running version only. The host also stores `tourCompleted = true`, because someone upgrading from a build without onboarding already knows the app. |
| A source exists and `!tourCompleted` | `tour`. This comes before (C), so What's new waits for the tour. |
| (C) `lastSeenVersion !== version` | `whatsNew` with `since: lastSeenVersion`: notes newer than it, up to the running version. |
| (D) anything else | `none`. |

(C) has two refinements, both `silent` stores of the running version:

- Still new: no sources and the tour not done. There is nothing to compare against, so this case behaves like (A).
- Downgrade: the stored version is newer than the running one. There are no notes to show.

`compareVersions` orders versions by their numeric dot segments. It ignores `+build`, sorts a pre-release below its release, and treats a missing segment as 0. `releasesToShow(notes, version, since)` picks the releases: every release up to `version` for a hand-made open (`since: null`), only `version` for rule B, and releases above `since` and up to `version` for rule C. Notes for a version later than the running one never show.

## The host

`OnboardingHost` (`host.tsx`) is mounted once in the shell. It reads `settings.get`, `app.info` and `sources.list` through the query cache and re-runs the decision whenever any of them changes. Adding the first source invalidates `sources.list`, so the tour starts without a reload. `sourceCount` comes from `countUsableSources` in `decide.ts`: a source counts once it has imported (`lastRefreshAt`) or while its first import runs (no `lastError`). A source whose imports have all failed does not count, so the tour waits for one that imports instead of showing over an empty app.

- A `silent` result is written once per session.
- An automatic overlay opens only when the app is idle. Idle means no `[aria-modal="true"]` on the page (for example the add-source dialog or a PIN prompt), no fullscreen element, and a visible document. The host first checks after `START_DELAY_MS` (600 ms) and then every `IDLE_POLL_MS` (400 ms). The delay also gives the rail time to render its anchors.
- Each automatic overlay opens at most once per session. A module-level set records what was shown. `saveOnboarding` updates the cached settings before the core answers. If a write fails, the overlay is not reopened in a loop; the marker is tried again at the next start.
- Closing the tour (Got it, Done, Skip tour or Escape) stores `tourCompleted = true`. Closing What's new (Got it, Escape, the close button or the backdrop) stores the running version if it differs.

An automatic tour opens as the coach mark (`coach`, from the store's `auto` flag); `openTour()` opens the three steps.

The overlays share one slot in `store.ts`, so they never show together. A request that arrives while the other overlay is open waits in `pending` and opens when that overlay closes. A hand-made request replaces a queued automatic one. `openTour()` (command palette) and `openWhatsNew()` (About) are store functions with no UI imports, so callers do not pull the overlays into their chunks.

## Bundle

None of the feature belongs in the entry chunk:

- The shell mounts the host lazily, like the other hosts. Importing it from `@/features/onboarding/host` keeps the barrel's `RELEASE_NOTES` (and its lucide icons) out of the host's chunk.
- The host loads `Tour` and `WhatsNewDialog` as separate lazy chunks. `RELEASE_NOTES` travels with `WhatsNewDialog`.
- Callers that only open an overlay (the command palette, the About section) import `openTour` and `openWhatsNew` from `@/features/onboarding/store`, which has no UI imports, rather than from the barrel.

`useOnboardingStrings()` (`strings.ts`) loads `en/onboarding.json` the first time an overlay opens if the bundle is not registered yet. The overlay renders nothing until the strings arrive. The other 18 locales are already lazy (`i18n/lazyLocales.ts`). The shell's eager English glob in `src/i18n/index.ts` can exclude `./en/onboarding.json`. That is optional: `vite.config.ts` puts every `src/i18n/en/*.json` in the `locale-en` chunk, not the entry, so leaving it in only adds about 2.5 kB to the startup download.

## The tour

`tour/Tour.tsx` is portalled to `body`.

- Steps (`tour/steps.ts`): `live` ("Live TV"), `vod` ("Movies, series and My List") and `search` (`TOUR_STEPS`). Each step anchors to the first laid-out `[data-tour="<id>"]` inside the window. Elements under `[inert]` or `[aria-hidden="true"]` are skipped, and so are elements with an empty box. The shell (the rail, the header's search, the phone's tab bar) carries the anchors; ui-shell.md lists them.
- Coach mark (`COACH_STEPS`, SS-6): one card on the `search` anchor, titled "Your source is ready", that names search and the command palette, the two things the screen does not show on its own. It has no step count and no Skip; "Show me around" turns it into step 1 of the three without closing, and Got it closes it.
- The `vod` anchor is the rail's My List entry, because it is the one movie and series entry that is always there, in the expanded and the icon rail alike; the Watch group's Movies and Series drop out while no source has movies or series. So the step is titled "Movies, series and My List", uses the bookmark icon of the rail entry, and its text says where posters live (under each source) and what My List keeps.
- Missing anchor: the card is centred over a plain scrim. The tour looks for the anchor again every `ANCHOR_POLL_MS` (300 ms) and on resize and scroll, so an anchor that mounts late is picked up.
- Spotlight: a box around the anchor (`SPOTLIGHT_PAD`, 4 px, so the ring round a rail item stays inside the rail) whose huge `box-shadow` is the scrim, with a ring in the accent's mark tone and a glow. The anchor shows through the hole. `spotlightBox` keeps the box `SPOTLIGHT_EDGE` (6 px) inside the window, so its 2 px ring never touches the window's edge.
- Placement (`tour/placement.ts`, pure and unit-tested): the card goes on the anchor's inline-end side first (right in LTR, left in RTL), then below, above, and on the inline-start side. Along the other axis it is centred on the anchor and clamped 12 px inside the window. When no side fits, the card is centred.
- Card: an icon, then the title, the text, and a footer with the step's buttons around a row of step dots: the current one stretched in the accent's mark tone, the ones done in `fg-subtle`, the ones to come in `fg-subtle/50`, so they show on the card. The dots say where the tour is; "Step n of 3" is for screen readers only. When the card sits beside its anchor, a small arrow on the facing edge points at the anchor's middle (`placeCard` returns it; a centred card has none). The search step adds key hints (mod+F, mod+K, ?), hidden by `pointer-coarse:hidden` when the main pointer is a finger, where they mean nothing (the hover prefetch uses the same coarse-pointer rule). Skip tour shows on steps 1 and 2, Back from step 2, and Next, which becomes Done on step 3.
- Keyboard: Escape skips. ArrowRight and ArrowLeft step forward and back, and are mirrored in RTL. Tab and Shift+Tab cycle through the card's buttons; from anywhere else (the card itself, `<body>`) Tab starts at the first and Shift+Tab at the last. The handler is a `keydown` listener on `window` in the capture phase, added while the tour is open, so it gets every key first wherever focus is, not only keys typed inside the layer. It stops every key, so the app's shortcut registry (`window`, bubble phase) and the page behind see none. Default actions still run, so Enter and Space press the focused button. Keys whose target sits in another modal layer pass through, in case one ever opens above the tour.
- Focus: Next takes focus on open. The card is `tabIndex={-1}`, like the shared Dialog panel: a click on its title or text focuses the card instead of dropping focus to `<body>`. After a step change, focus stays on the button the user pressed if it still exists, and otherwise goes to Next. Focus that leaves the tour is pulled back, unless it lands in another modal layer (`[aria-modal="true"]` or `[data-dialog-layer]`), whose own focus trap would otherwise fight the tour's. On close, focus returns to where it was, or to `#main` if that element is gone. A click on the page behind does nothing.
- Screen readers: the card is `role="dialog"` with `aria-modal`, labelled by its title and described by its text. A polite live region announces each new step.
- Motion: the spotlight and card glide between anchors and the body fades in. Every one of these is behind `motion-safe:`, so under reduced motion nothing moves. The global reduced-motion rule in `globals.css` covers the shared controls.

## What's new

`WhatsNewDialog.tsx` uses the shared `Dialog` (size `lg`).

- Description: "Version x", the running version, whenever it is known.
- Body: a scrolling region. The newest release leads with its first three items as highlights, full-width rows in one panel, each with its icon tile beside its title and text (three columns in the `lg` dialog were about 185 px each, and their texts ran to five lines); the rest follow as a compact list with a small icon. When the dialog lists several releases (an open by hand from About), each one the description does not name gets a version badge as its heading, so the newest release has no badge on a row of its own above its highlights; if the version cannot be read, every release has one.
- Footer: "Take the tour" (only when a source exists; it closes the dialog and then opens the tour) and "Got it", which takes focus.
- States: a skeleton while `app.info` loads, and an empty message when an open by hand has nothing to list. A startup open with nothing in range stores the version and renders nothing. If `app.info` fails, an open by hand still lists every release.
- The list region is a Tab stop only while it overflows, so keyboard users can scroll it.
- Scroll cues: while the list overflows, a fade into the surface colour covers each edge that has more content past it (the bottom one at first, the top one once scrolled). At 1280x800 in English the twelve 0.1.0 notes overflow by about 28 px, so without the fade the last row would look cut off at the footer. The fades sit 2 px inside the region so its focus ring stays visible, and they fade in and out only under `motion-safe:`.

## Release notes

`RELEASE_NOTES` (`notes.ts`) is newest first. Each release has a `version` matching `app.info.version` and items of `{ key, icon }`. The strings are `<key>Title` and `<key>Text` in `onboarding.json`.

To add a release:

1. Put a new entry at the top.
2. Add its keys to all 19 locales. The i18n parity test enforces this.
3. Keep the list short.

`test/notes.test.ts` checks the order, the version format, unique keys, icons, and that every key used has an English string and none is unused.

Writing notes:

- Describe what works in both the desktop app and server mode, or say which one a note is about. The screenshot note says "save the current frame as an image", because the desktop app saves to `Pictures\Tsrust IPTV` while server mode downloads the file.
- In the right-to-left locales (`ar`, `ary`), never put a full stop in front of Latin text, as in `.srt`. Under the Unicode bidi algorithm the full stop takes the paragraph's right-to-left direction and shows on the far side of the word (`srt.`). Write the name without the dot (`SRT`), or wrap the Latin run in U+2066/U+2069 isolates. `test/notes.test.ts` checks this.

Version 0.2.0 sums up Loops 1-5 and the feature and performance audit fixes in twelve notes: M3U series, speed, programme search, guide zoom and shifts with favorites zapping, picture settings and ClearKey, source updates, more downloads and hourly catch-up, play, pause and stop on the phone remote, the phone and touch layout, translated messages and formats, the window at startup, and the fixes. The version is set in four places that move together: `package.json`, the workspace `Cargo.toml` (`app.info` reports iptv-core's `CARGO_PKG_VERSION`), `crates/iptv-tauri/tauri.conf.json`, and the newest `RELEASE_NOTES` entry; `Cargo.lock` carries the workspace crates' version too. An upgrade from 0.1.0 lists the 0.2.0 notes only; an open by hand lists both releases under their headings.

Version 0.1.0 lists the round-two features: multi-view, parental controls, My List, custom channel lists, guide search and series recording, subtitle files and styles, the sleep timer, browsing by decade, watch stats, the appearance options, screenshots, and the poster cache.

## Tests

- `test/decide.test.ts`: rules A-D, the tour before What's new, both refinements, `compareVersions` and `releasesToShow`.
- `test/placement.test.ts`: every side, RTL, clamping, the centred fallback, and the spotlight box.
- `test/store.test.ts`: the single slot, queueing, and hand-made over automatic requests.
- `test/tour.test.tsx`: Next, Back, Skip, Escape, the arrow keys (also in RTL), the Tab wrap, focus pulled back and returned, no keys reaching the shortcut registry, keys that still work with focus on the card or on `<body>`, a modal above the tour keeping its focus and keys, the key hints hidden on a coarse pointer, a missing, hidden or late anchor, the live announcement, and motion-safe-only transitions.
- `test/whatsNew.test.tsx`: items with icons, Got it and Escape store the version, no write when it is unchanged, a failed write, a silent auto-close, the empty, loading and no-version states, Take the tour, and the edge fades with the list's Tab stop.
- `test/host.test.tsx`: rules A-D end to end against an in-memory core, the tour started by the first source, waiting for a modal to close, no reopen after a failed write, and `openTour` and `openWhatsNew`.
- `test/persist.test.tsx`: the optimistic write, merging back only its own keys, never rejecting, and loading the strings on demand.
- `e2e/onboarding.spec.ts`: a fresh data dir with no source stores the version silently; the mock Xtream source starts the tour; Next, Back, the arrow keys, the Tab trap and Escape work, also after a click on the card's text, and `tourCompleted` is stored (also by Skip and Done); no motion under `emulateMedia({ reducedMotion: 'reduce' })`; `lastSeenVersion = 0.0.1` shows What's new, and Got it stores the version; What's new waits for the tour; axe and layout of both overlays at 390x844 and 1280x800. The spec puts both markers back to "seen" when it ends.
