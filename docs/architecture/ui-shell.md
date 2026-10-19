# UI shell, design system, and dashboard

Owner: U1. Covers `src/styles`, `src/ui`, `src/shell`, `src/i18n/index.ts`, and the `/dashboard` page. Contracts are SPEC C7, C10, C11, and C16.

## Visual direction: Night Tuner

The app is a TV and radio tuner, so the design borrows from a backlit radio dial at night.

- Surfaces are ink navy in dark mode and cool paper in light mode.
- One accent at a time, amber by default (dark `#f5b544`, light `#8f4f00`); the user can pick one of seven in Settings > Appearance. The accents, OLED black, density and UI scale are in [appearance.md](appearance.md). The accent is used for active navigation, primary actions, progress, and focus. Nothing else wears it, so it always means "here" or "go".
- The signature detail is the tuning tick, a short accent bar on the leading edge of the active rail item (the `tuning-tick` utility). Focus rings use the same accent with a soft glow.
- Type: Bahnschrift (`font-display`) for headings, titles, and numbers; Segoe UI Variable Text for body; Cascadia Mono for key caps.
- Artwork fallbacks are initials on a per-title hue gradient (`hueOf`, `initialsOf` in `Poster`), so missing posters still look intentional.
- Motion only answers user actions (dialogs, toasts, card lift). Everything runs under `motion-safe:`. `html[data-reduced-motion='true']` and the OS media query both turn animation off. The player OSD is the exception: it hides through its keyframe, so under reduced motion it keeps a 2.4 s duration with a no-fade `player-osd-still` animation (shown, then gone).

Dark is the default when the OS has no stated preference.

## Styles

- `src/styles/tokens.css` defines the C10 variables for `:root` / `[data-theme='dark']` and `[data-theme='light']`. Text pairs meet WCAG AA on their surfaces.
- `src/styles/globals.css`:
  - imports Tailwind and the tokens
  - declares `@custom-variant dark` keyed on `data-theme`
  - maps tokens into `@theme`, which provides `bg-surface`, `text-fg-muted`, `border-border`, `bg-accent`, `text-accent-fg`, `bg-live`, and the rest
  - sets base styles, the focus ring, and scrollbars
  - defines the keyframes (`shimmer`, `toast-in`, `fade-in`, `pop-in`, `live-pulse`, `indeterminate`), utilities (`scrollbar-none`, `tabular`, `skeleton-surface`, `animate-shimmer`, `tuning-tick`), and cmdk styles
  - the skeleton shimmer is `@utility animate-shimmer` (used as `skeleton-surface motion-safe:animate-shimmer`): a band on an `::after` layer that sweeps by `transform` only, with `contain: paint` on the element, so the compositor runs it with no style recalc or repaint per frame. `src/ui/offscreen.ts` stops the loops nobody can see. `pauseWhenOffscreen` is a ref callback, used on the `Poster` placeholder while it loads and on the `LiveBadge` dot: one shared IntersectionObserver (64 px root margin) keeps `data-offscreen` on the element while it is out of view, set before the first observation, and globals.css turns its animation off there. While the window is hidden, `html[data-page-hidden]` pauses every shimmer, `live-pulse` and `indeterminate` loop, so a plain `Skeleton` pauses only then. Without IntersectionObserver nothing is marked. `live-pulse` runs three times as a live dot appears and then holds still, since an endless pulse kept the compositor drawing at the display rate wherever a LIVE badge showed; the player's live dot uses the same count (`LIVE_PULSES` in `Controls.tsx`).
- Layout variables: `--rail-width` 248px, `--rail-width-collapsed` 72px, `--header-height` 60px, `--panel-width` 340px.

## UI primitives (`@/ui`, C11)

All of these are Radix-free and keyboard-complete:

- `Button`, `IconButton`, `buttonClass`. A `loading` Button sets `aria-disabled` and `aria-busy` and ignores activation instead of using native `disabled`, so keyboard focus stays on it.
- Direction: primitives and shell use logical utilities (`start-*`/`end-*`, `ps-*`/`pe-*`, `border-s`/`border-e`, `text-start`) and `rtl:` variants for transforms and gradients, so they mirror in RTL; Tabs, VirtualGrid, the vod `gridNav` rails and grids, and the dashboard rails swap ArrowLeft and ArrowRight there, and Menu's `align` is logical. Provider text (titles, plots, programme names) carries `dir="auto"` with the `text-match-parent` utility, which aligns it to the parent's start (left, or right under an RTL parent) whatever its own script. The mini player docks with `inset-inline-end` (its saved offset is `{end, bottom}` in `player.mini.pos`; an older `{right, bottom}` still reads), so in RTL it sits bottom-left, clear of the rail on the right, and its arrow-key and drag moves follow `<html dir>`.
- `Input`, `Textarea`, `Select`, `Toggle` (role=switch), and `SearchInput`. The first Escape clears the field; the next one propagates.
- `Dialog`: portal, focus trap, Escape, focus restore, scroll lock, and `[data-autofocus]`. The trap stands down once the dialog starts closing, so an always-`open` Dialog that its parent unmounts still hands focus back to the opener. The title row and footer are plain `div`s, because a portaled `<header>`/`<footer>` would add a second banner/contentinfo landmark.
- `Tabs` and `Menu`: roving focus. Menu also has type-ahead.
- `Tooltip`, `Kbd`, `Badge`, `LiveBadge`, `ProgressBar`. `Kbd` and `comboKeys` print key names from `common` (`keyCtrl`, `keySpace`, `keyDelete`...: German "Strg", "Entf"), and media keys show their symbol with a translated spoken name (`keyNamePlayPause`...). Arrows and the macOS ⌘ and ⌥ stay symbols. Header tooltips build their shortcut text with `comboKeys`, so macOS shows ⌘.
- `Skeleton`, `SkeletonList`, `SkeletonGrid`
- `EmptyState` and `ErrorState`. ErrorState maps each `RpcErrorCode` to a translated title and next-step hint; the raw message (usually the core's English text) sits with the code in a folded "Technical details" disclosure. When the transport marks a `network` error with `details.transport === 'unreachable'`, it adds a translated body and a local-server hint. `errorDescription(err, redact?)` is the same for error toasts: the translated hint for the code leads and the raw message follows in small print (`data-error-message`). Toasts whose text is already localized keep their own (source errors, import toasts, the player's error overlay, multi-view).
- `Poster`: lazy, blur-up, with an initials fallback.
- `Pagination`
- `VirtualList` and `VirtualGrid`: listbox semantics, arrow, Page, Home, and End keys, Enter to select, and `onEndReached`. The grid's cursor moves to a cell on pointer down and on a right click, so its menu and keys act on that title; only keyboard focus (`:focus-visible`) starts it on the first cell.
- `toast()`, `useToast`, `ToastViewport`, `focusToasts()`. `toast()` works outside React and upserts by `id`. The stack is keyboard-reachable: `focusToasts()` (bound to F8 by the shell) focuses the newest toast's first button, Up and Down move between toasts, and Escape dismisses the focused one. Hovering or focusing a toast pauses its timer. When a focused toast goes away by any route, focus moves to the neighbouring toast, or back to where it was before F8 (falling back to `main#main`), never to `<body>`.
- `cn(...)` is `twMerge(clsx(...))` (tailwind-merge 3, pinned), extended with the theme's `shadow-1`/`shadow-2` and `animate-*` names. Later classes win, so a caller's `className` overrides a primitive's default (`cn('px-3 bg-surface', 'px-6 bg-accent')` gives `px-6 bg-accent`).

## Shell (`@/shell`)

`ShellLayout` is the `/` layout route. It renders:

- a skip link
- `ThemeSync`
- the `Rail` (the only `nav` labelled "Main navigation"): primary navigation, then sources from `sources.list` with `railLinks(source)` per C7 (an imported Xtream source drops Radio, Movies and Series links whose counts are 0, a Stalker one drops Radio only), then manage sources, settings, shortcuts, and collapse. The primary links and the sources scroll apart: the primary list is capped at the larger of half the rail's middle and all of it but 10rem (`RAIL_PRIMARY_MAX`), and the sources take the rest, so a source's page reveals its link in the sources list without pushing Home, Search or the guide out of view. The source of the current route (`routeSourceId`: `/s/:id/...`, and the catch-up archive `/live/archive/:id/...`, which sits outside `/s/:id`) is marked and opened
- the `Header` (the only `banner`), with title, subtitle, search slot, actions, a panel toggle, the palette button, and the theme toggle. The title is a styled `<p>`, not a heading: every page renders its own single `<h1>`, so the header must not add a second one. The header also sets `document.title` to `<title> · Tsrust IPTV` (just the app name when no page title is set).
- `main#main` with the `Outlet`. It is a flex column with `min-h-0` inside a row of definite height (the root is `h-dvh`; header and footer are `shrink-0`), at every width from 800 to 2560 px. A page either grows and lets `main` scroll, or fills it with `flex-1 min-h-0` (or `h-full`) and scrolls inside, which gives `VirtualList` / `VirtualGrid` a bounded scroll parent.
- the `ContextPanel`: inline at 1440px and wider, a drawer below that
- `ExternalPlaybackFooter` and `PlayerDock`, both from `@/features/player`
- `CommandPalette`, `ShortcutOverlay`, and `ToastViewport`
- `OnboardingHost` (Run 3 C7), lazy from `@/features/onboarding/host`, not the barrel, so the release notes and their icons stay out of the shell chunk. It decides on the first-run tour and What's new and shows them; see onboarding.md.

The rail collapses to icons below 1024px or when the user collapses it. That preference is stored in localStorage. Below 1024px the rail never expands, so in the collapsed rail each source's mark is a `Menu` trigger that lists the source's `railLinks` (Live TV, Radio, Movies, Series, Favorites, Recent, as its kind has them); the item for the current page gets an accent icon and a screen-reader "current page" hint (`railCurrentPage`). An M3U source lists Radio only once its radio probe (`catalog.channels` with `radio: true`, limit 1) has answered, and in the collapsed rail that probe starts when the mark is hovered or focused.

Below 1024px the collapse toggle is replaced by "Hide sidebar" (`hideRail`, `toggleRailHidden` in the shell store, localStorage `tsrust.railHidden`): the layout then renders no rail, and the header leads with "Show sidebar" (`showRail`, `data-testid="rail-show"`). Each button moves focus to the other as it goes (`flushSync`, then focus). The flag only applies below 1024px; a wider window always shows the rail, so it cannot go missing on a desktop. While the rail is hidden the tour's `live`, `vod` and narrow-width `search` anchors are absent and those steps show as centred cards.

Tour anchors (`[data-tour]`, read by the onboarding tour's `findAnchor`, which takes the first laid-out match inside the window):

- `live`: the rail row, collapsed or expanded, of the first source with live channels and no import error, else the first with live channels (`liveTourSource`); with neither, no row has it and the step shows as a centred card. It is always rendered, unlike a source's Live TV sub-link, which only shows while the source is open.
- `vod`: the My List rail link (always shown), the closest primary entry to movies and series.
- `search`: from 1024px up, the header's search field when the page has one, otherwise its "Search everything" button. Below 1024px, where the button folds away and the rail is auto-collapsed, the rail's Search link carries it instead and the header's field does not, so exactly one element on screen has the anchor at every width. The palette button never does: it opens commands, not search.

The palette's Settings group has "Take the tour" (`help.tour`) and "What's new" (`help.whatsNew`); Settings > About has the same two buttons. All four import `openTour` / `openWhatsNew` from `@/features/onboarding/store`, which has no UI imports.

Palette matching (`paletteFilter`): an item matches only when every typed word appears unbroken in its title or keywords, case-insensitive; title matches rank above keyword-only ones, and cmdk's score orders the matches inside each band. Internal ids never match. While a query is typed, groups are ordered by their best match.

The palette's "Favorites and recent" group (`groupFavoritesRecent`) lists favourites and recently watched items whose titles match the query (`matchContent`: one entry per item, best first, at most 8, favourites ahead of recent items on equal scores). It reads `favorites.list` and `recent.list` with the dashboard's arguments (`{ limit: 60 }`), so Home's cache serves it, and only while the palette is open, so typing sends no requests. Items of a removed source, or one waiting out its delete-undo window, are left out. A channel or radio station plays in the dock through `playItem`, as from a dashboard card; a movie or series opens `/s/<sourceId>/<movie|series>/<itemId>`. The group comes first, so a tie with a command goes to the content.

The palette's "Guide programmes" group (`groupProgrammes`) lists up to 5 programmes whose titles match the query, from `epg.search` of every visible source (`useProgrammeSearch` in `src/features/live/guide/programmeSearch.ts`), asked 200 ms after typing stops and only while the palette is open. The core folds diacritics, so the typed words count as each hit's keywords and the palette's own filter keeps it. A hit opens the guide at the programme (`guideHitLink`: `/epg?source=<id>&at=<start>` with the hit in the router state), where the channel's row takes the cursor and is marked, as for a hit of the guide's own search.

Page API, which works without a provider (zustand):

- `useShell()` returns `{ setHeader, setContextPanel }`. Both reset on unmount if the page still owns them.
- `useShellHeader(header, deps)`
- `registerCommands(cmds)` returns an unregister function. Commands appear in the palette.
- `useShortcut(combo, handler, { description, area, enabled, allowInInput, allowInModal, global, when, priority })`
  - There is one window listener (bubble phase, so focused widgets such as Dialog, SearchInput, Menu, and VirtualList handle their keys first and claim them with `preventDefault`). Among the matching entries the highest `priority` (default 0) wins, then the most recently registered. The multi-view page gives its F, M and L priority 1, so they beat the playback keys of the same letters, which register again (as newer) whenever main playback starts.
  - `when(e)` is checked at key time after the combo matched; false skips the entry as if it were not registered, so an older entry or the browser default gets the key. The playback keys use it to leave Space, the arrows and Page Up/Down to the page while the player is only the mini dock (`playerOwnsPageKeys`, players.md).
  - Once an entry matches, the registry calls `preventDefault()` and `stopPropagation()` before it runs the handler, so browser defaults (Space scrolling, `/` quick find, F11, Ctrl+F/R) never fire, even if the handler throws (errors are logged).
  - Shortcuts are skipped while the user is typing (input, textarea, select, contenteditable), unless `allowInInput` is set. A skipped key keeps its default.
  - Plain `space`/`enter` shortcuts are skipped when a button, link, checkbox, option, tab, or similar control has focus, so the key activates the control. Plain arrow, Home/End, and Page keys are skipped on controls that use them (`isArrowTarget`): selects, range and radio inputs (the browser moves the checked radio), and the slider, spinbutton, scrollbar, listbox, option, grid, menu, tab, radio and tree roles.
  - While an aria-modal dialog is open, only `escape` and `allowInModal` shortcuts fire; `mod+*` combos are no exception, so Ctrl+B or Ctrl+Alt+L do nothing over a dialog.
  - `global: true` bypasses all of the above (typing, focused controls, modals).
- `useTheme()` and `persistTheme(theme)`
- `openPalette()` and `openShortcutHelp()`
- `openSearch(navigate)` goes to `/search` with the cursor in its field, as `mod+f` does; the header's "Search everything" button uses it. `focusSearchWhenReady({ skip })` (in `focusSearch.ts`) focuses the first `SEARCH_FIELD` (`[data-page-search], [data-shell-search]`) other than `skip`, polling every 50 ms for up to 3 s, because the search page loads lazily and its header field mounts only after the chunk arrives. `openSearch` passes the leaving page's own field as `skip`: it is still mounted for a moment after `navigate()`, and focusing it would drop focus on `<body>` when it unmounts.

Shortcuts the shell owns: `mod+k` (toggles the palette, including from inside its input; cmdk's `vimBindings` are off so its Ctrl+K never swallows the key; over another dialog it does not open), `mod+f` (focuses `[data-shell-search]` or `[data-page-search]`, otherwise goes to `/search`), `mod+r` (`/recent`), `?` (overlay), `mod+shift+l` (flip light/dark, same as the header button; "match system" is in the palette and Settings; also in fields and dialogs), `f8` (jump to notifications), `f11` (fullscreen, `toggleFullscreenKey`: the player's fullscreen, as `f`, while the dock holds a source that is not playing externally; otherwise element fullscreen on the document, which the desktop window follows through `bindWindowFullscreen`, since WebView2 has no F11 of its own; registered with `allowInInput` and `allowInModal`, so it also works in fields and dialogs), and `escape` (closes the palette, then the overlay, then the panel, then blurs). `mod+f` and `mod+r` leave the page, so `navigationKeyBlocked` makes them do nothing over a dialog or in a text field, where they would throw away typed text (the Add source URL and credentials); they still claim the key there, so the browser neither reloads nor opens its find bar, and they still run from the command palette. The overlay's list is a focusable region so arrow and Page keys scroll it. While closed, `ShortcutOverlay` reads only `helpOpen`; the registry subscription (`useShortcutList`), the merged list and the filter live in a dialog mounted only while it is open, so a page registering or toggling shortcuts costs the closed overlay no render, and the filter starts empty each time. The overlay merges registered shortcuts with the documented C16 list (`DOCUMENTED_SHORTCUTS`), so playback and live keys are listed even when those pages are not mounted. `shortcutReference(registered, t)` in `ShortcutOverlay.tsx` builds that merged, grouped list, with each area's heading translated through `SHORTCUT_AREA_KEYS`; Settings > Shortcuts calls the same function, so the two lists always match. A new documented area needs an entry in `SHORTCUT_AREA_KEYS` (and in `AREA_ORDER` for its place), or its raw id shows as the heading.

Side effects (`effects.ts`):

- `bindEventInvalidation(EVENT_INVALIDATION)`. The shell's map adds prefixes to the api's `DEFAULT_EVENT_INVALIDATION` (`src/api/query.ts`). It has no `downloads.update` entry: the default refetches only `downloads.list` and the `myvideos.` queries, so a progress burst never refetches `downloads.dir` (a `downloads.` prefix here used to).
- `settings.changed`: `bindEventInvalidation` has already written the new settings into the query cache; the shell handler invalidates `sources.schedule` only when `sourceRefreshIntervalHours` changed, and checks `englishOnly`. A `lastRoute`-only write sends no `settings.changed` at all (settings.md).
- `import.progress` shows one updating toast per source, with progress.
  - Dedupe with the Sources page (decision): while `/sources` is the active route, the shell shows no progress or `done` toast and dismisses any `import-<sourceId>` toast it showed earlier, because that page already shows per-card progress and its add dialog and refresh flow toast their own success ("Added X"). Coalescing by toast id was not an option: the page's toasts carry no id, and the shell does not edit feature code. Errors still toast on `/sources` (a refresh that returns `lastError` gets no page toast), without the "Open Sources" action. On every other route (auto refresh, deep links, an import still running after the user left the page) the shell toasts every phase. The rule is `importToastPolicy(phase, isSourcesRoute(pathname))`, read from a ref so the event subscription is not rebuilt on navigation.
  - The progress line (`importProgressText`) is worded like the Sources page's counts: an M3U download reports bytes while it fetches, shown as a size (`formatFileSize`); every other count is grouped in the UI language's number format (`formatCount`). A source not cached yet counts as M3U when it fetches without a message.
  - `holdImportToasts()` holds back every per-source import toast (progress, ready, failed, cancelled) while a surface reports the whole run itself. Settings > Backup (`BackupSection.tsx`) holds them around `backup.import`, which imports each restored source in the core, and reports the result in its own toast and result card. It returns a release function that takes effect `IMPORT_TOAST_HOLD_GRACE_MS` (1 s) later, because the last events can trail the RPC's reply. Holds count, so overlapping ones stack. A held or dismissed toast is removed, and a cancelled or failed import still invalidates `sources.`.
- `deeplink.open` maps `iptv://search?q=` to `/search?q=`, and add links through the Sources feature's `addSourcePathFromDeepLink`: `iptv://add?url=<url>[&kind=m3u|xtream|stalker]` and `iptv://add/<encoded url>` open `/sources?add=<url>[&kind=]`, a bare `iptv://add` an empty form, and a target that is not http(s) is ignored.
- In web mode, a toast appears if the event stream stays closed for 3 s, including before it first opens; it shows once per outage and goes away when the stream opens.
- Language sync from `settings.language`.
- `lastRoute` (`useLastRoutePersistence`) saves the current route, query included, through `settings.update`. A move to a new pathname is saved after a 1200 ms debounce (`LAST_ROUTE_DEBOUNCE_MS`). A query-only change on the same screen (a search's `?q=`, a filter) starts no timer, because each write costs a core settings rebuild: it is saved on `pagehide` or when the document becomes hidden, unless a move to another screen saves that one first. `pagehide` and hiding also save a route still inside its debounce. `/` and `?add=` routes are never saved (`isRestorableRoute`). The core announces no `settings.changed` for a `lastRoute`-only change, so the reply goes straight into the `settings.get` cache; `StartupRedirect` does the same when it forgets a dead saved screen. A failed write is tried again on the next navigation.
- Window state on desktop. Decision: `tauri-plugin-window-state` owns the OS window. It restores size, position and the maximized state before the window is shown, so the shell never calls `setSize`, `setPosition`, or `maximize`. A second restore from the webview would land after first paint and make the window jump, and the two stores could disagree. Fullscreen, the window frame and visibility are left out of the restore (`StateFlags` in `crates/iptv-tauri/src/lib.rs`): picture-in-picture and the player's fullscreen turn the frame off, the app always opens framed and not fullscreen, and the window shows when the page has painted its first frame (`reveal_window`; a fallback timer covers a page that never renders). The shell only mirrors geometry into the core: it reads `window.getState` once to seed the last normal (unmaximized) geometry, then writes `window.setState` (C4) with an 800 ms debounce on move and resize, skipping minimized windows and keeping the normal geometry while maximized or fullscreen. That keeps the core copy accurate for diagnostics and backups. What the plugin does not cover stays with the shell: rail collapse and hiding in localStorage (`tsrust.railCollapsed`, `tsrust.railHidden`), the last route in `settings.lastRoute`, and the theme in `settings.theme` mirrored to localStorage.

Theme: `settings.theme` is mirrored to localStorage (`tsrust.theme`) and applied before the first paint by `public/theme-boot.js`, then again when `theme.tsx` loads, before React mounts, so there is no flash ([appearance.md](appearance.md)). `data-theme` is set on `<html>`.

`persistTheme(theme)` applies the choice locally and in the settings cache at once, then calls `settings.update`; only the newest call writes its reply into the cache. A write that fails with `network` or `timeout` (web mode with the server down) stays pending and is sent again when the event socket reopens after a drop or when any RPC gets an answer (`onServerAnswered`). Until the server confirms it, `ThemeSync` ignores the server's theme, so the settings refetch after a reconnect cannot flip it back. A write the server answers and refuses is not resent; the local choice stays and settings reconcile on the next load.

Routes: `src/shell/routes.tsx` exports `shellRoutes`:

- the index route is `StartupRedirect`. It goes to `lastRoute` when `startupBehavior` is `restore-last-view`, otherwise to `/dashboard`, or to `/sources` when `showDashboard` is off. On desktop it first waits for the one `app.pendingDeepLinks` pull (`pullStartupDeepLink`, memoized); a cold-start link wins and becomes the only navigation, so a lazy target route or late settings cannot override it. `useShellEvents` navigates to that link itself only when the app did not start at `/` (`src/shell/test/deepLinkStartup.test.tsx`).
- `dashboard` renders `DashboardPage`.

Wire them as:

```tsx
{ path: '/', element: <ShellLayout />, children: [...shellRoutes, ...featureRoutes] }
```

The shell tests mount `shellRoutes` that way. The app's own tree (`src/routes.tsx`) wires the same two routes as `shellChildRoutes`, with `dashboard` as a lazy chunk loaded through `loadDashboard` (exported by `StartupRedirect.tsx`); the index route itself is not lazy. `StartupRedirect` restores the saved screen only while it still exists: `src/routes.tsx` passes `isKnownPath` (a path that some route other than the not-found page renders), a screen of a source (`/s/:id/...`, and the catch-up archive `/live/archive/:id/...`) waits for `sources.list`, and a `/lists/:id` screen waits for `lists.list`. A dead screen goes to the default target, and that target is written back as `lastRoute`. A failed list restores the screen anyway. It starts the dashboard chunk download only when the startup target is `/dashboard`: once settings are in, the lists it needs too, and no startup deep link is pending (on desktop this can run while the deep-link pull is still out). Restoring any other screen downloads no dashboard code.

Before the router mounts, `src/main.tsx` prefetches `settings.get` and `sources.list` into the query cache (`queryClient.prefetchQuery` under the same `rpcKey` the pages use, with no abort signal), while the language and, on desktop, the image cache base load. The startup redirect, the rail and the dashboard then join those two requests instead of sending their own.

## Dashboard

`/dashboard` renders one visually hidden `<h1>` ("Home") in every state (loading, welcome, error, rails); rail and hero titles are `h2`. It shows the following rails. Each one is toggled by `settings.dashboardRails`.

- hero: the first `positions.continueWatching` entry, with a Resume button
- continue watching
- My List (`settings.dashboardRails.myList`), then one rail per custom list with "Show on Home" on (`CustomListRails` from `src/features/lists/rails`, in list order; a list's own `onDashboard` flag decides, not `dashboardRails`; see lists.md)
- favorite channels: live and radio favorites, with EPG now-playing from `epg.nowNext`
- recently watched channels
- favorite movies and series
- your sources: ranked by latest use, then refresh time
- recently added: `catalog.recentlyAdded` for movies and series, merged
- trending: `tmdb.trending`, only when TMDB is enabled

Above the rails, `AccountAlerts` lists Xtream and Stalker subscriptions that expired or expire within `settings.accountExpiryWarnDays` (from `account.statusAll`; nothing when that is 0 or every source is M3U), expired first. Each row links to `/sources?account=<id>`, which opens that source's subscription tab, and can be dismissed. A dismissal is stored in localStorage (`tsrust.accountAlerts.dismissed`) per source and expiry date, so a renewed subscription warns again. See account.md.

Rails show a skeleton while loading and an inline error with retry on failure, and they render nothing when empty. With no sources, the page shows a welcome state that links to `/sources?add=1`. Keyboard: each rail is one tab stop. Left, Right, Home, and End move within a rail (RTL-aware; the step buttons read `Math.abs(scrollLeft)`, and a rail at its start is put back at 0 when its items reorder, since scroll snapping would otherwise follow the old first card), and Up and Down jump to the same position in the neighboring rail. Play actions call `playItem` from `@/features/player` with the source kind.

## i18n

`src/i18n/index.ts` bundles only `src/i18n/en/*.json` eagerly (the fallback, exported as `resources`). Every other `src/i18n/<lang>/<ns>.json` loads lazily (non-eager `import.meta.glob`); `vite.config.ts` puts each language's namespaces in one `locale-<lang>` chunk ([performance.md](performance.md)). `loadLanguage(code)` loads all namespaces of a folder and adds them with `addResourceBundle` under the BCP 47 key (`by` becomes `be`, `zhtw` becomes `zh-TW`); loads are cached and a failed one is retried next time. `applyLanguage(code)` loads first, then calls `changeLanguage`, stores the choice in localStorage (`tsrust.language`), and sets `lang` and `dir`; when switches overlap, the newest request wins, and a failed load falls back to English. Importing the module initializes i18next in English and starts loading the stored language; `initI18n(lang?)` resolves once that language is active (it never rejects), and `main.tsx` awaits it before the first render so there is no English flash. It also exports `NAMESPACES`, `LANGUAGES` (19 entries, with `rtl` for Arabic; defined in the side-effect-free `languages.ts`), and `i18n`.

Every `Intl` constructor takes its locale from `intlLocale` (`src/lib/intl.ts`): `ary` becomes `ar` (Intl has no Moroccan Arabic data and would use the machine's locale), `by` becomes `be`, `zhtw` `zh-TW`, `zh` `zh-CN`, and anything else comes from the LANGUAGES table, falling back to English. i18next's built-in formats (`{{count, number}}` and the rest) are routed through it too, and counts that can pass 1,000 use `{{count, number}}`. Track language names (`trackLanguageName` in `features/player/engines.ts`) follow the app language, not the OS. Lists of names (genres, creators, the downloads summary) use `formatList` (`Intl.ListFormat`, conjunction); fact lists in labels join with `listSeparator` ("、" for Chinese and Japanese, "، " for Arabic). Moving the 18 other locales out of the main chunk took it from 2,689.72 kB (gzip 768.26 kB) to 1,024.37 kB (gzip 313.66 kB). Keys are flat camelCase per namespace, and plurals use `_one` / `_other`.

## Tests

- `src/ui/test/ui.test.tsx`: Dialog trap, restore, and Escape; Tabs and Menu roving focus; ErrorState hints; VirtualList windowing and keys; toast upsert; pagination and grid math.
- `src/shell/test/shell.test.tsx`: layout, unique landmarks and a single `h1` on the dashboard with a non-heading header title and `document.title`, startup redirect, palette (including the mod+k toggle from inside its input), overlay, theme persistence and the mod+shift+l flip, F8 toast focus with Escape and focus handoff, the bounded outlet classes, deep links, the import toast and its Sources-route dedupe, dashboard rails, rail toggles, welcome and error states, and rail keyboard navigation. It uses mocked rpc and a mocked player.
- `src/shell/test/shortcuts.test.ts`: `preventDefault` before the handler (Space, `/`, F11, mod+f, a throwing handler), stopPropagation, typing targets including contenteditable, `allowInInput` and `global`, focused buttons, sliders and native radio inputs, modal gating (mod+ combos included), newest-wins, `priority` and `when`.
- `src/shell/test/windowState.test.tsx`: no OS-window restore on desktop, debounced `window.setState` mirror, and normal geometry kept while maximized.
- `src/shell/test/i18n.test.ts`: English-only eager resources, lazy locale load before the switch (BCP 47 key, `lang`/`dir`), newest-wins on overlapping switches, and the unknown-code fallback.
- `src/ui/test/cn.test.ts`: tailwind-merge conflict resolution with the theme tokens.
- `src/shell/test/logic.test.ts`: combo matching, deep links, the import toast policy, startup target, rail links, overlay grouping, theme resolution, and the dashboard helpers.
