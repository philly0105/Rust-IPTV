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
  - defines the keyframes (`shimmer`, `toast-in`, `fade-in`, `pop-in`, `live-pulse`, `indeterminate`), utilities (`scrollbar-none`, `tabular`, `skeleton-surface`, `tuning-tick`), and cmdk styles
- Layout variables: `--rail-width` 248px, `--rail-width-collapsed` 72px, `--header-height` 60px, `--panel-width` 340px.

## UI primitives (`@/ui`, C11)

All of these are Radix-free and keyboard-complete:

- `Button`, `IconButton`, `buttonClass`. A `loading` Button sets `aria-disabled` and `aria-busy` and ignores activation instead of using native `disabled`, so keyboard focus stays on it.
- Direction: primitives and shell use logical utilities (`start-*`/`end-*`, `ps-*`/`pe-*`, `border-s`/`border-e`, `text-start`) and `rtl:` variants for transforms and gradients, so they mirror in RTL; Tabs, VirtualGrid, the vod `gridNav` rails and grids, and the dashboard rails swap ArrowLeft and ArrowRight there, and Menu's `align` is logical. Provider text (titles, plots, programme names) carries `dir="auto"` with the `text-match-parent` utility, which aligns it to the parent's start (left, or right under an RTL parent) whatever its own script. `ErrorState` shows a translated body and a local-server hint when the transport marks a `network` error with `details.transport === 'unreachable'`, with the raw browser text in a details disclosure.
- `Input`, `Textarea`, `Select`, `Toggle` (role=switch), and `SearchInput`. The first Escape clears the field; the next one propagates.
- `Dialog`: portal, focus trap, Escape, focus restore, scroll lock, and `[data-autofocus]`. The trap stands down once the dialog starts closing, so an always-`open` Dialog that its parent unmounts still hands focus back to the opener. The title row and footer are plain `div`s, because a portaled `<header>`/`<footer>` would add a second banner/contentinfo landmark.
- `Tabs` and `Menu`: roving focus. Menu also has type-ahead.
- `Tooltip`, `Kbd`, `Badge`, `LiveBadge`, `ProgressBar`
- `Skeleton`, `SkeletonList`, `SkeletonGrid`
- `EmptyState` and `ErrorState`. ErrorState maps each `RpcErrorCode` to a title and a next-step hint.
- `Poster`: lazy, blur-up, with an initials fallback.
- `Pagination`
- `VirtualList` and `VirtualGrid`: listbox semantics, arrow, Page, Home, and End keys, Enter to select, and `onEndReached`.
- `toast()`, `useToast`, `ToastViewport`, `focusToasts()`. `toast()` works outside React and upserts by `id`. The stack is keyboard-reachable: `focusToasts()` (bound to F8 by the shell) focuses the newest toast's first button, Up and Down move between toasts, and Escape dismisses the focused one. Hovering or focusing a toast pauses its timer. When a focused toast goes away by any route, focus moves to the neighbouring toast, or back to where it was before F8 (falling back to `main#main`), never to `<body>`.
- `cn(...)` is `twMerge(clsx(...))` (tailwind-merge 3, pinned), extended with the theme's `shadow-1`/`shadow-2` and `animate-*` names. Later classes win, so a caller's `className` overrides a primitive's default (`cn('px-3 bg-surface', 'px-6 bg-accent')` gives `px-6 bg-accent`).

## Shell (`@/shell`)

`ShellLayout` is the `/` layout route. It renders:

- a skip link
- `ThemeSync`
- the `Rail` (the only `nav` labelled "Main navigation"): primary navigation, then sources from `sources.list` with `railLinks(source)` per C7, then manage sources, settings, shortcuts, and collapse
- the `Header` (the only `banner`), with title, subtitle, search slot, actions, a panel toggle, the palette button, and the theme toggle. The title is a styled `<p>`, not a heading: every page renders its own single `<h1>`, so the header must not add a second one. The header also sets `document.title` to `<title> · Tsrust IPTV` (just the app name when no page title is set).
- `main#main` with the `Outlet`. It is a flex column with `min-h-0` inside a row of definite height (the root is `h-dvh`; header and footer are `shrink-0`), at every width from 800 to 2560 px. A page either grows and lets `main` scroll, or fills it with `flex-1 min-h-0` (or `h-full`) and scrolls inside, which gives `VirtualList` / `VirtualGrid` a bounded scroll parent.
- the `ContextPanel`: inline at 1440px and wider, a drawer below that
- `ExternalPlaybackFooter` and `PlayerDock`, both from `@/features/player`
- `CommandPalette`, `ShortcutOverlay`, and `ToastViewport`
- `OnboardingHost` (Run 3 C7), lazy from `@/features/onboarding/host`, not the barrel, so the release notes and their icons stay out of the shell chunk. It decides on the first-run tour and What's new and shows them; see onboarding.md.

The rail collapses to icons below 1024px or when the user collapses it. That preference is stored in localStorage.

Tour anchors (`[data-tour]`, read by the onboarding tour's `findAnchor`, which takes the first laid-out match inside the window):

- `live`: the first source's rail row, collapsed or expanded. It is always rendered, unlike a source's Live TV sub-link, which only shows while the source is open.
- `vod`: the My List rail link (always shown), the closest primary entry to movies and series.
- `search`: from 1024px up, the header's search field when the page has one, otherwise its "Search everything" button. Below 1024px, where the button folds away and the rail is auto-collapsed, the rail's Search link carries it instead and the header's field does not, so exactly one element on screen has the anchor at every width. The palette button never does: it opens commands, not search.

The palette's Settings group has "Take the tour" (`help.tour`) and "What's new" (`help.whatsNew`); Settings > About has the same two buttons. All four import `openTour` / `openWhatsNew` from `@/features/onboarding/store`, which has no UI imports.

Page API, which works without a provider (zustand):

- `useShell()` returns `{ setHeader, setContextPanel }`. Both reset on unmount if the page still owns them.
- `useShellHeader(header, deps)`
- `registerCommands(cmds)` returns an unregister function. Commands appear in the palette.
- `useShortcut(combo, handler, { description, area, enabled, allowInInput, allowInModal, global })`
  - There is one window listener (bubble phase, so focused widgets such as Dialog, SearchInput, Menu, and VirtualList handle their keys first and claim them with `preventDefault`). The most recently registered matching entry wins.
  - Once an entry matches, the registry calls `preventDefault()` and `stopPropagation()` before it runs the handler, so browser defaults (Space scrolling, `/` quick find, F11, Ctrl+F/R) never fire, even if the handler throws (errors are logged).
  - Shortcuts are skipped while the user is typing (input, textarea, select, contenteditable), unless `allowInInput` is set. A skipped key keeps its default.
  - Plain `space`/`enter` shortcuts are skipped when a button, link, checkbox, option, tab, or similar control has focus, so the key activates the control. Plain arrow, Home/End, and Page keys are skipped on sliders, spinbuttons, and selects.
  - While an aria-modal dialog is open, only `escape`, `mod+*`, and `allowInModal` shortcuts fire.
  - `global: true` bypasses all of the above (typing, focused controls, modals).
- `useTheme()` and `persistTheme(theme)`
- `openPalette()` and `openShortcutHelp()`

Shortcuts the shell owns: `mod+k` (toggles the palette, including from inside its input; cmdk's `vimBindings` are off so its Ctrl+K never swallows the key), `mod+f` (focuses `[data-shell-search]` or `[data-page-search]`, otherwise goes to `/search`), `mod+r` (`/recent`), `?` (overlay), `mod+shift+l` (flip light/dark, same as the header button; "match system" is in the palette and Settings), `f8` (jump to notifications), and `escape` (closes the palette, then the overlay, then the panel, then blurs). The overlay's list is a focusable region so arrow and Page keys scroll it. The overlay merges registered shortcuts with the documented C16 list (`DOCUMENTED_SHORTCUTS`), so playback and live keys are listed even when those pages are not mounted. `shortcutReference(registered, t)` in `ShortcutOverlay.tsx` builds that merged, grouped list, with each area's heading translated through `SHORTCUT_AREA_KEYS`; Settings > Shortcuts calls the same function, so the two lists always match. A new documented area needs an entry in `SHORTCUT_AREA_KEYS` (and in `AREA_ORDER` for its place), or its raw id shows as the heading.

Side effects (`effects.ts`):

- `bindEventInvalidation(EVENT_INVALIDATION)`
- `settings.changed`: `bindEventInvalidation` has already written the new settings into the query cache; the shell handler invalidates `sources.schedule` only when `sourceRefreshIntervalHours` changed (so a `lastRoute` write refetches nothing), and checks `englishOnly`.
- `import.progress` shows one updating toast per source, with progress.
  - Dedupe with the Sources page (decision): while `/sources` is the active route, the shell shows no progress or `done` toast and dismisses any `import-<sourceId>` toast it showed earlier, because that page already shows per-card progress and its add dialog and refresh flow toast their own success ("Added X"). Coalescing by toast id was not an option: the page's toasts carry no id, and the shell does not edit feature code. Errors still toast on `/sources` (a refresh that returns `lastError` gets no page toast), without the "Open Sources" action. On every other route (auto refresh, deep links, an import still running after the user left the page) the shell toasts every phase. The rule is `importToastPolicy(phase, isSourcesRoute(pathname))`, read from a ref so the event subscription is not rebuilt on navigation.
- `deeplink.open` maps `iptv://add?url=` to `/sources?add=<url>` and `iptv://search?q=` to `/search?q=`.
- In web mode, a toast appears if the event stream stays closed for 3 s, including before it first opens; it shows once per outage and goes away when the stream opens.
- Language sync from `settings.language`.
- `lastRoute` is saved through `settings.update` with a 1200 ms debounce. `/` and `?add=` routes are never saved.
- Window state on desktop. Decision: `tauri-plugin-window-state` owns the OS window. It restores size, position, maximized, and fullscreen before the window is shown, so the shell never calls `setSize`, `setPosition`, or `maximize`. A second restore from the webview would land after first paint and make the window jump, and the two stores could disagree. The shell only mirrors geometry into the core: it reads `window.getState` once to seed the last normal (unmaximized) geometry, then writes `window.setState` (C4) with an 800 ms debounce on move and resize, skipping minimized windows and keeping the normal geometry while maximized or fullscreen. That keeps the core copy accurate for diagnostics and backups. What the plugin does not cover stays with the shell: rail collapse in localStorage (`tsrust.railCollapsed`), the last route in `settings.lastRoute`, and the theme in `settings.theme` mirrored to localStorage.

Theme: `settings.theme` is mirrored to localStorage (`tsrust.theme`) and applied before React mounts, so there is no flash. `data-theme` is set on `<html>`.

Routes: `src/shell/routes.tsx` exports `shellRoutes`:

- the index route is `StartupRedirect`. It goes to `lastRoute` when `startupBehavior` is `restore-last-view`, otherwise to `/dashboard`, or to `/sources` when `showDashboard` is off. On desktop it first waits for the one `app.pendingDeepLinks` pull (`pullStartupDeepLink`, memoized); a cold-start link wins and becomes the only navigation, so a lazy target route or late settings cannot override it. `useShellEvents` navigates to that link itself only when the app did not start at `/` (`src/shell/test/deepLinkStartup.test.tsx`).
- `dashboard` renders `DashboardPage`.

Wire them as:

```tsx
{ path: '/', element: <ShellLayout />, children: [...shellRoutes, ...featureRoutes] }
```

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

`src/i18n/index.ts` bundles only `src/i18n/en/*.json` eagerly (the fallback, exported as `resources`). Every other `src/i18n/<lang>/<ns>.json` is a lazy chunk (non-eager `import.meta.glob`, one chunk per locale and namespace). `loadLanguage(code)` loads all namespaces of a folder and adds them with `addResourceBundle` under the BCP 47 key (`by` becomes `be`, `zhtw` becomes `zh-TW`); loads are cached and a failed one is retried next time. `applyLanguage(code)` loads first, then calls `changeLanguage`, stores the choice in localStorage (`tsrust.language`), and sets `lang` and `dir`; when switches overlap, the newest request wins, and a failed load falls back to English. Importing the module initializes i18next in English and starts loading the stored language; `initI18n(lang?)` resolves once that language is active (it never rejects), and `main.tsx` awaits it before the first render so there is no English flash. It also exports `NAMESPACES`, `LANGUAGES` (19 entries, with `rtl` for Arabic), and `i18n`. Moving the 18 other locales out of the main chunk took it from 2,689.72 kB (gzip 768.26 kB) to 1,024.37 kB (gzip 313.66 kB). Keys are flat camelCase per namespace, and plurals use `_one` / `_other`.

## Tests

- `src/ui/test/ui.test.tsx`: Dialog trap, restore, and Escape; Tabs and Menu roving focus; ErrorState hints; VirtualList windowing and keys; toast upsert; pagination and grid math.
- `src/shell/test/shell.test.tsx`: layout, unique landmarks and a single `h1` on the dashboard with a non-heading header title and `document.title`, startup redirect, palette (including the mod+k toggle from inside its input), overlay, theme persistence and the mod+shift+l flip, F8 toast focus with Escape and focus handoff, the bounded outlet classes, deep links, the import toast and its Sources-route dedupe, dashboard rails, rail toggles, welcome and error states, and rail keyboard navigation. It uses mocked rpc and a mocked player.
- `src/shell/test/shortcuts.test.ts`: `preventDefault` before the handler (Space, `/`, F11, mod+f, a throwing handler), stopPropagation, typing targets including contenteditable, `allowInInput` and `global`, focused buttons and sliders, modal gating, newest-wins.
- `src/shell/test/windowState.test.tsx`: no OS-window restore on desktop, debounced `window.setState` mirror, and normal geometry kept while maximized.
- `src/shell/test/i18n.test.ts`: English-only eager resources, lazy locale load before the switch (BCP 47 key, `lang`/`dir`), newest-wins on overlapping switches, and the unknown-code fallback.
- `src/ui/test/cn.test.ts`: tailwind-merge conflict resolution with the theme tokens.
- `src/shell/test/logic.test.ts`: combo matching, deep links, the import toast policy, startup target, rail links, overlay grouping, theme resolution, and the dashboard helpers.
