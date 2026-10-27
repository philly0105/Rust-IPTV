# Appearance

Which token and component to use where is in [design-system.md](design-system.md); this page covers how themes, accents, density and scale work.

Code: `src/shell/theme.tsx` (applies everything), `public/theme-boot.js` (the first paint), `src/styles/tokens.css` (the values), `src/styles/globals.css` (Tailwind mapping, utilities, keyframes), `src/ui/scale.ts` (scale for JS-sized layouts), `src/ui/card.ts` (card states), `src/features/settings/sections/AppearanceSection.tsx` (the settings page), `src/shell/dashboard/HeroCarousel.tsx` (the dashboard hero). Tests: `src/ui/test/contrast.test.ts`, `src/ui/test/appearance.test.tsx`, `src/ui/test/themeBoot.test.ts`, `src/shell/dashboard/test/hero.test.tsx`.

## Settings (contract C1)

Four fields in `settings` sit beside `theme`. The core validates and stores them like any other setting (`settings.update`).

| Field | Values | Default |
| --- | --- | --- |
| `accent` | `amber`, `teal`, `violet`, `rose`, `lime`, `sky`, `coral` (`ACCENTS`, the picker order) | `amber` |
| `oledBlack` | boolean | `false` |
| `density` | `comfortable`, `compact` (`DENSITIES`) | `comfortable` |
| `uiScale` | 0.9 to 1.25 (`UI_SCALE_MIN`, `UI_SCALE_MAX`), rounded to 4 decimals | `1` |

## What lands on the document

`applyThemeToDocument` and `applyAppearanceToDocument` in `theme.tsx` write these on `<html>`:

| Attribute | When |
| --- | --- |
| `data-theme` | `light` or `dark`; `system` resolves against `prefers-color-scheme` (dark unless the OS asks for light) |
| `data-accent` | always, one of the seven accents |
| `data-oled` | present (empty value) only when `oledBlack` is on and the resolved theme is dark; switching to light drops it, switching back restores it |
| `data-density` | always, `comfortable` or `compact` |
| `style="--ui-scale: <n>"` | always; `html { font-size: calc(15px * var(--ui-scale)) }` follows it |
| `data-reduced-motion` | mirrors `prefers-reduced-motion: reduce` |
| `data-theme-switching` | for two frames while the theme, accent or OLED state flips, so every colour swaps in one frame instead of each control fading on its own |

Values are sanitized before they are written: an unknown accent or density falls back to the default and the scale is clamped, so a stale mirror or a hand-edited file never leaves the document half-styled.

## Cold start and live updates

- The theme is mirrored to localStorage under `tsrust.theme`, the appearance under `tsrust.appearance` (JSON of the four fields). `public/theme-boot.js` applies that copy before the first paint. `index.html` loads it as a blocking external script in `<head>`, after the `theme-color` meta and before the app's module script (CSP is `script-src 'self'`, so it cannot be inline). It sets `data-theme` (`system` resolves dark unless the OS asks for light), `data-oled` only while dark, `data-accent`, `data-density`, `--ui-scale` clamped to 0.9 to 1.25, and the `theme-color` meta, which it keeps in step with later `data-theme` and `data-oled` changes. With storage blocked, the dark default in `index.html` stands. `theme.tsx` applies both again when it loads, before React mounts, and is the source of truth from then on.
- The boot script copies rules from `theme.tsx` (the storage keys, the accent names, the scale range) and the page background of `tokens.css` (`--color-bg` for dark, light and OLED), so a change to either has to be made in `theme-boot.js` too. `src/ui/test/themeBoot.test.ts` checks its colours against `tokens.css`, along with the script's place in `index.html`.
- `ThemeSync` (mounted once by `ShellLayout`, through its `SettingsThemeSync` leaf, with `settingsTheme` and `appearance={settings.data}`) updates the stores from settings, which rewrites the mirrors, and reapplies the document attributes. While settings are still loading it keeps the mirror.
- In the desktop app the native title bar follows the theme (`syncWindowTheme` in `theme.tsx`, SH-titlebar-theme): Light and Dark call the window's `setTheme('light' | 'dark')`, and System calls `setTheme(null)` so the window follows the OS again. The main window's capability allows it (`core:window:allow-set-theme` in `crates/iptv-tauri/capabilities/default.json`); a refusal leaves the bar as the OS draws it. The window has no theme of its own in `tauri.conf.json`, so with an explicit theme on an OS set the other way the bar shows the OS colour for a moment at launch, until `ThemeSync` runs.
- `previewAppearance(partial)` lays an unsaved overlay over the saved appearance; `previewAppearance(null)` ends it. The interface size slider uses it: dragging resizes the whole app, and the value is saved only on release (pointer up, key up after an arrow, Home, End or Page key, or blur). The preview stays up until the save settles so the size never flickers back.
- `useAppearance()` returns the appearance in effect, preview included.

## Tokens

`tokens.css` is unlayered CSS keyed on the attributes above; Tailwind reads the variables through `@theme` in `globals.css`, so a class like `bg-accent` follows every attribute without a rebuild.

- Base blocks: `:root, :root[data-theme='dark']` and `:root[data-theme='light']`. The amber accent lives in them. The page colour (`bg`) of each theme is copied into `public/theme-boot.js` and the theme-color meta.
- Lines: `divider` (quiet rules between regions), `edge` (container outlines: cards, panels, dialogs, menus, toasts, chips, key caps, poster rings, secondary buttons; about 1.3:1) and `border` (form controls only, 3:1).
- States: `hover` and `active` are see-through layers (`bg-hover`, `bg-active`) for ghost buttons, rail links, menu items and rows on any surface; `selected` is the opaque neutral fill of the current item, paired with `tuning-tick`; `raised` is the thumb of a segmented control or pill tab (with `shadow-1`).
- Accent tones: `accent` (+ `-hover`, `-pressed`, `-fg`) is the text tone (links, accent text, active icons). `accent-mark` is the tone of marks that are not text: the tuning tick, progress fills, tab underlines, the radio dot, the on switch's outline, slider fills, the guide's airing foot. `accent-solid` (+ `-hover`, `-pressed`, `-fg`) fills primary buttons, the on switch and checked boxes. In dark all three are the same. In light, the mark is a mid shade between the deep text tone and the solid fill (#c26900 for amber), because the text tone drawn as a bar or a tick reads as brown, and every accent fills with its bright dial tone and ink text, the same family as in dark: when teal, violet, rose and sky filled with their deep shade and white text, the swatch row and the primary button changed model with the accent. Filled controls that sit on a panel (the on switch, a checked box, the slider thumb) take a mark-tone outline, so they keep 3:1 on white.
- Status fills with white text: `live-solid` (LIVE pills) and `danger-solid` (+ `-hover`, `-pressed`) for destructive buttons; `live` and `danger` stay the text tones.
- Elevation: `--elevation-1` (cards, raised thumbs, the primary button), `--elevation-2` (menus, popovers, toasts, tooltips, floating panels), `--elevation-3` (dialogs, drawers, sheets), set per theme: an inner top highlight in dark, navy-tinted shadows in light, a faint white ring on OLED. `@theme` maps `shadow-1` to `shadow-3` to them as `var()`, because Tailwind 4 inlines a literal `@theme` shadow into the utility and every theme would get the dark values.
- Accent blocks: `:root[data-accent='<accent>']` sets the dark family (`accent`, `accent-hover`, `accent-pressed`, `accent-fg`, `accent-mark`, the `accent-solid` family, `focus`, `glow`) and the bright glass accent; `:root[data-theme='light'][data-accent='<accent>']` sets the deep light family with white text on it, the light mark and the solid family, which repeats the dark one. Light blocks never touch the glass accent.
- OLED block: `:root[data-oled]:not([data-theme='light'])` puts `bg` and `surface` on `#000`, steps `surface-2`, `surface-3`, `pressed`, `raised`, `selected`, the edge and the divider up from black so panels still separate, and darkens the scrim and glass. It never sets accent tokens; the dark accent block keeps applying.
- Type (`globals.css` `@theme`, rem against the 15 px root, so it follows the UI scale): `text-caption` 12/16, `text-body-sm` 13.5/20, `text-body` 15/22, `text-title-sm` 18/24, `text-title` 22/28, `text-headline` 28/34, `text-display` 36 to 54 px; title-sm and up are 600 and tracked in. Page titles use `text-title`, rail and section headings `text-title-sm`, detail and hero titles `text-display`. Fonts: `font-sans` and `font-display` are Inter Variable, `font-numeric` is Barlow Semi Condensed 600 for channel numbers, clocks, the number OSD and LIVE pills.
- Radii: `rounded-xs` 4, `-sm` 6, `-md` 8 (buttons, inputs), `-lg` 12 (cards, posters, menus, toasts), `-xl` 16 (dialogs, hero, sheets), `-full`.
- Motion: `--duration-fast` 120 ms, `--duration-base` 180 ms, `--duration-slow` 280 ms; `ease-enter` and `ease-exit`. Each overlay keyframe has an exit twin (`animate-fade-out`, `animate-pop-out`, `animate-toast-out`, `animate-drawer-out`, `animate-sheet-out`) at the next shorter duration that holds its last frame; Dialog, the drawer, Menu and toasts play them on close (`usePresence` in `src/ui/presence.ts`). Reduced motion cuts all of it, and the overlays then unmount at once.
- Glass (contract C8): `--color-glass`, `--color-glass-strong`, `--color-glass-border`, `--color-on-glass`, `--color-on-glass-muted`, `--color-glass-accent`, `--color-glass-accent-fg`, and `--blur-glass`. Glass is dark in every theme, including light, because it sits over video and artwork. Text on it uses the on-glass pair, and accents on it use the glass accent (the bright dial tone), never the theme accent, which is deep in the light theme and would sink. The `glass` utility applies the strong fill, on-glass text and border colour with no blur, so it is cheap enough for chrome that is always on screen. Since Run 3 (C5) blur comes only from the `glass-blur` utility (`backdrop-filter: blur(var(--blur-glass))`, 10 px at most, dropped for a strong fill under `prefers-reduced-transparency: reduce`), paired with `bg-glass` on small, short-lived overlays such as menus, hover chips and the player's control pane; `src/perf-budget.test.ts` enforces this. `hero-frost` is the hero's gradient frost. Consumers outside `src/ui` may read the variables with a fallback: `var(--color-glass, <fallback>)`.

### Contrast

`contrast.test.ts` parses `tokens.css` and checks every combination the user can reach: 7 accents by dark, light and OLED (21 themes). In each: control borders, the focus ring, the accent and the mark tone reach 3:1 against the page and every surface (the accent and the mark also on the selected fill); the mark equals the accent in dark and is clearly brighter than it in light; the container edge sits between the divider and the control border; every text colour (including the accent as text) reaches 4.5:1, also on the selected fill; text on the accent and solid accent fills (rest, hover, pressed) and white on the LIVE and danger fills reach 4.5:1; tinted badges keep 4.5:1; the hover and active layers stay visible (1.1:1) and keep text at 4.5:1 composited over each surface. It also keeps the `@theme` colour defaults equal to the dark block and the shadow utilities pointed at `--elevation-N`. For glass: on-glass text reaches 4.5:1 on glass and glass-strong composited over both black and white, for the dark, light and OLED blocks; each accent's glass accent reaches 3:1 on glass in all of those cases, and text on it reaches 4.5:1.

## Density and UI scale

- Compact density sets Tailwind's `--spacing` to `0.21875rem` (0.875 of the default), so every spacing utility (`p-*`, `gap-*`, `h-*`, `w-*`) tightens together. It also shrinks the chrome sizes: `--rail-width`, `--header-height`, `--panel-width` and `--rail-item-height`. In comfortable density a window under 60rem tall (a 1080p screen at 125 %, a 900 px laptop) takes `--rail-item-height` down to `2.25rem` (`tokens.css`), so the rail's Watch, Library and Sources groups fit without scrolling.
- The UI scale changes the root font size, so everything in `rem` follows: Tailwind text sizes, the spacing scale, and the custom `text-2xs` (10 px at 100 %). The chrome sizes are `calc(<px> * var(--ui-scale))`. Lucide icons follow too: a base rule in `globals.css` restates each `size={n}` in use (11 to 32) as `calc(n rem / 15)`, so a 16 px icon is 20 px at 125 %; a size utility on the icon still wins. The 44 px touch floor (`TOUCH_TARGET`) and the search field's clear button are written the same way, so they follow the scale but not compact density.
- Rules for new code: size text with the type scale (`text-caption` to `text-display`), the Tailwind scale (`text-xs`, `text-sm`, `text-2xs`) or `rem`, never `text-[13px]`; px literals do not follow the scale. An off-scale size is written against the 15 px root, so 13 px at 100 % is `text-[calc(13rem/15)]`. No feature component sizes text in px any more. Layouts that measure in JS (virtualised lists and grids, rails with fixed card widths, skeleton grids) read `useScaledPx(px, spacing)` from `@/ui`; `spacing: true` also applies the density factor.
- Virtualised rows have a fixed slot height that mixes both kinds of length: text lines and logos follow the UI scale only, while the row's vertical padding and the gaps between its lines are spacing and should tighten under compact density too. `scaleRowPx(px, spacingPx, uiScale, density)` and its hook `useRowHeight(px, spacingPx)` compute such a slot: `px` is the whole row at 100 %, `spacingPx` the padding-and-gap part of it. `VirtualList` takes the same split as `itemHeight` plus `itemSpacing`. A list that leaves the spacing part at 0 keeps the same row height in both densities, so compact fits no more rows.
- The Live channel and group lists follow compact density. `ChannelList` sizes its rows with `useRowHeight(CHANNEL_ROW_HEIGHT, CHANNEL_ROW_SPACING)` (60 px, of which 22 px is the row's `py-2` and the gaps between its three lines), so a channel row is 57 px in compact at 100 %; `LivePage`'s loading skeleton uses the same height. `CategorySidebar` sizes group rows with `useRowHeight(36, 17)` (the 17 px is the slot less its `text-sm` line), so a group row is 34 px in compact. The channel row's own `py-*` and `gap-*` classes shrink by the same factor, so its content still fits the slot. In both lists a change of scale or density drops the virtualizer's cached sizes.

## Cards

`src/ui/card.ts` holds the one interaction language every artwork card uses (VOD posters, dashboard posters, channel and source tiles), drawn on the artwork rather than around the caption:

| State | Look |
| --- | --- |
| rest | hairline ring, resting shadow |
| hover | lifts 2 px, ring brightens, shadow deepens |
| focus-visible | 2 px focus ring plus the soft glow |
| pressed | settles back and gives a little (scale 0.98) |
| cursor | a listbox grid's active descendant: the focus ring, no lift |

Put `CARD_ROOT` on the focusable element (it names the `card` group and hands its focus ring to the artwork), `CARD_ART` on the artwork frame, and add `CARD_ART_CURSOR` for the grid cursor. Movement is behind `motion-safe`; reduced motion keeps every colour and ring change. Inside a frame, pass `after:hidden` to `Poster` so its inner hairline does not double the frame's ring. Chips on artwork (rating, language) use `bg-glass-strong text-on-glass` and the glass accent; the watched mark is the kit's `WatchedChip` in the top-end corner. A progress bar on artwork takes `tone="glass"` (a light track and the glass accent in every theme), never the theme tone. That amber is for the user's own progress (Continue watching, posters); a programme's progress on a channel card is quiet: `glass-quiet` over a programme picture, `quiet` (the theme's track) over a channel's logo card.

A channel card on Home (`LogoArt` in `src/shell/dashboard/cards.tsx`) centres the channel's logo on a soft glow of the channel's hue over `surface-2`. The hue is a CSS variable (`--logo-hue`) and the glow is in classes (`LOGO_GLOW`): a deep tint in the dark themes and a pale one in light, where the deep tint showed as a grey smudge on the pale card. A channel with no logo, or one whose logo fails, gets Poster's initials tile there as a logo-sized mark (a square 46% of the card's height, rounded like an app icon, no type glyph) instead of a tile across the whole card, so a provider without logos does not turn Home into rows of colour blocks. The mark scales with the card, so a phone card keeps the same room around it as a desktop one.

## Dashboard hero

`HeroCarousel` follows the WAI-ARIA auto-rotating carousel with tabs.

- Slides (`buildHeroSlides` in `heroSlides.ts`): up to 3 continue-watching entries, then recently added movies and series with artwork, those with a backdrop first, at most 6, never the same title twice. Continue-watching slides fetch the catalog item for the backdrop, plot, year, genres and rating.
- The section is labelled "Featured" with role description "carousel"; the visible slide is the `tabpanel` ("2 of 5", role description "slide"). The other slides stay in the same grid cell, hidden and `inert`, so the hero keeps the height of its tallest slide and nothing below moves.
- Controls sit in a glass pill in the top corner: rotation toggle, previous, one dial tick per slide (a `tablist`; arrows move and choose, flipped in RTL, Home and End jump, roving tab stop), next. The active tick fills over the dwell (8 s) and freezes with the timer. The fill is a transform that a timer moves every 200 ms (`DIAL_TICK_MS`), not a CSS animation, because a running animation makes the browser draw at the display's refresh rate; the tick's grow from dot to bar animates width and colour, so it plays only when the user changes slides. An automatic turn swaps the ticks at once, which keeps an idle Home off the main thread.
- Rotation pauses while the pointer is over the hero, while focus is inside, while the window is hidden or unfocused, while the hero is scrolled off screen, and after the user pauses it. It also rests after `HERO_IDLE_ROUNDS` (2) full rounds with no pointer, key, wheel or touch input in the window, until the next input. Resuming finishes the dwell that was left. Under `prefers-reduced-motion` it never rotates and the toggle is not shown; the other controls still work. The live region is off while rotating and polite once the user drives it.
- Frame (`HERO_FRAME` in `HeroSkeleton.tsx`, shared with the skeleton): dark glass in every theme. In the dark themes it runs full width straight under the header and fades into the page (`HERO_PAGE_FADE`). The light page is no colour it can fade to, so there it is a card inset by the page gutter, `rounded-xl` with `shadow-2`, through the `light:` variant (`globals.css`, which follows `data-theme` as `dark:` does).
- Height: about two fifths of the window from sm up (`HERO_BODY`: 40vh, capped by the width and at 30rem; the copy sets it where it needs more), so the first rail starts in the top half of a 900 px window; on a phone as tall as its copy (the floor is 38vh up to 20rem), so On now starts on the first screen.
- Artwork: the backdrop, else the poster blown up and blurred into colour, else a tint from the title's hue. A failed image falls to the next option. A poster standing in for the backdrop also stands upright at the inline end from lg up, from 8 % of the height down to 64 %, above the slide controls and on the same end edge (the page gutter); a slide with no artwork at all puts the title's initials tile (the rails' fallback poster) there, over its tint. Text sits on glass that clears toward the inline end, so it reads on any artwork in every theme.

## Settings page

Settings, Appearance:

- Theme cards (light, dark, system) whose previews draw the chosen accent and OLED state.
- OLED black switch; its hint says it applies with the dark theme when the light theme is in effect.
- Accent picker: seven swatches as a radio group (arrows move and choose, Home and End jump), with a live sample of real chrome (rail item, poster, progress, primary button) drawn with the live tokens.
- Size and spacing: density (two-way choice) and interface size (slider 90 to 125 % in 5 % steps, live preview, Reset back to 100 %).

`PREVIEW_PALETTE` and `ACCENT_PALETTE` in `AppearanceSection.tsx` copy token values, because each theme card previews its own theme regardless of the active one. Tests keep them equal to `tokens.css` (`src/features/settings/test/b6.test.tsx` for dark and light, `src/ui/test/appearance.test.tsx` for OLED and every accent).
