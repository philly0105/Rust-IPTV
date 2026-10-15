# Appearance

Code: `src/shell/theme.tsx` (applies everything), `src/styles/tokens.css` (the values), `src/styles/globals.css` (Tailwind mapping, utilities, keyframes), `src/ui/scale.ts` (scale for JS-sized layouts), `src/ui/card.ts` (card states), `src/features/settings/sections/AppearanceSection.tsx` (the settings page), `src/shell/dashboard/HeroCarousel.tsx` (the dashboard hero). Tests: `src/ui/test/contrast.test.ts`, `src/ui/test/appearance.test.tsx`, `src/shell/dashboard/test/hero.test.tsx`.

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

- The theme is mirrored to localStorage under `tsrust.theme`, the appearance under `tsrust.appearance` (JSON of the four fields). Both are applied when `theme.tsx` loads, before React mounts, so the first paint already has the right colours and size.
- `ThemeSync` (mounted once by `ShellLayout` with `settingsTheme` and `appearance={settings.data}`) updates the stores from settings, which rewrites the mirrors, and reapplies the document attributes. While settings are still loading it keeps the mirror.
- `previewAppearance(partial)` lays an unsaved overlay over the saved appearance; `previewAppearance(null)` ends it. The interface size slider uses it: dragging resizes the whole app, and the value is saved only on release (pointer up, key up after an arrow, Home, End or Page key, or blur). The preview stays up until the save settles so the size never flickers back.
- `useAppearance()` returns the appearance in effect, preview included.

## Tokens

`tokens.css` is unlayered CSS keyed on the attributes above; Tailwind reads the variables through `@theme` in `globals.css`, so a class like `bg-accent` follows every attribute without a rebuild.

- Base blocks: `:root, :root[data-theme='dark']` and `:root[data-theme='light']`. The amber accent lives in them.
- Accent blocks: `:root[data-accent='<accent>']` sets the dark family (`accent`, `accent-hover`, `accent-pressed`, `accent-fg`, `focus`, `glow`) and the bright glass accent; `:root[data-theme='light'][data-accent='<accent>']` sets the deep light family with white text on the fill. Light blocks never touch the glass accent.
- OLED block: `:root[data-oled]:not([data-theme='light'])` puts `bg` and `surface` on `#000`, steps `surface-2`, `surface-3`, `pressed` and the divider up from black so panels still separate, and darkens the scrim and glass. It never sets accent tokens; the dark accent block keeps applying.
- Glass (contract C8): `--color-glass`, `--color-glass-strong`, `--color-glass-border`, `--color-on-glass`, `--color-on-glass-muted`, `--color-glass-accent`, `--color-glass-accent-fg`, and `--blur-glass`. Glass is dark in every theme, including light, because it sits over video and artwork. Text on it uses the on-glass pair, and accents on it use the glass accent (the bright dial tone), never the theme accent, which is deep in the light theme and would sink. The `glass` utility applies the strong fill, on-glass text and border colour with no blur, so it is cheap enough for chrome that is always on screen. Since Run 3 (C5) blur comes only from the `glass-blur` utility (`backdrop-filter: blur(var(--blur-glass))`, 10 px at most, dropped for a strong fill under `prefers-reduced-transparency: reduce`), paired with `bg-glass` on small, short-lived overlays such as menus, hover chips and the player's control pane; `src/perf-budget.test.ts` enforces this. `hero-frost` is the hero's gradient frost. Consumers outside `src/ui` may read the variables with a fallback: `var(--color-glass, <fallback>)`.

### Contrast

`contrast.test.ts` parses `tokens.css` and checks every combination the user can reach: 7 accents by dark, light and OLED (21 themes). In each: component borders, the focus ring and the accent reach 3:1 against the page and every surface; every text colour (including the accent as text) reaches 4.5:1; text on the accent, its hover and pressed fills reaches 4.5:1; tinted badges keep 4.5:1. For glass: on-glass text reaches 4.5:1 on glass and glass-strong composited over both black and white, for the dark, light and OLED blocks; each accent's glass accent reaches 3:1 on glass in all of those cases, and text on it reaches 4.5:1.

## Density and UI scale

- Compact density sets Tailwind's `--spacing` to `0.21875rem` (0.875 of the default), so every spacing utility (`p-*`, `gap-*`, `h-*`, `w-*`) tightens together. It also shrinks the chrome sizes: `--rail-width`, `--header-height`, `--panel-width` and `--rail-item-height`.
- The UI scale changes the root font size, so everything in `rem` follows: Tailwind text sizes, the spacing scale, and the custom `text-2xs` (10 px at 100 %). The chrome sizes are `calc(<px> * var(--ui-scale))`.
- Rules for new code: size text with the Tailwind scale (`text-xs`, `text-sm`, `text-2xs`) or `rem`, never `text-[13px]`; px literals do not follow the scale. An off-scale size is written against the 15 px root, so 13 px at 100 % is `text-[calc(13rem/15)]`. No feature component sizes text in px any more. Layouts that measure in JS (virtualised lists and grids, rails with fixed card widths, skeleton grids) read `useScaledPx(px, spacing)` from `@/ui`; `spacing: true` also applies the density factor.
- Virtualised rows have a fixed slot height that mixes both kinds of length: text lines and logos follow the UI scale only, while the row's vertical padding and the gaps between its lines are spacing and should tighten under compact density too. `scaleRowPx(px, spacingPx, uiScale, density)` and its hook `useRowHeight(px, spacingPx)` compute such a slot: `px` is the whole row at 100 %, `spacingPx` the padding-and-gap part of it. `VirtualList` takes the same split as `itemHeight` plus `itemSpacing`. A list that leaves the spacing part at 0 keeps the same row height in both densities, so compact fits no more rows.
- The Live channel and group lists follow compact density. `ChannelList` sizes its rows with `useRowHeight(CHANNEL_ROW_HEIGHT, CHANNEL_ROW_SPACING)` (64 px, of which 19 px is the row's `py-2` and its two `gap-0.5`), so a channel row is 62 px in compact at 100 %; `LivePage`'s loading skeleton uses the same height. `CategorySidebar` sizes group rows with `useRowHeight(36, 17)` (the 17 px is the slot less its `text-sm` line), so a group row is 34 px in compact. The channel row's own `py-*` and `gap-*` classes shrink by the same factor, so its content still fits the slot. In both lists a change of scale or density drops the virtualizer's cached sizes.

## Cards

`src/ui/card.ts` holds the one interaction language every artwork card uses (VOD posters, dashboard posters, channel and source tiles), drawn on the artwork rather than around the caption:

| State | Look |
| --- | --- |
| rest | hairline ring, resting shadow |
| hover | lifts 2 px, ring brightens, shadow deepens |
| focus-visible | 2 px focus ring plus the soft glow |
| pressed | settles back and gives a little (scale 0.98) |
| cursor | a listbox grid's active descendant: the focus ring, no lift |

Put `CARD_ROOT` on the focusable element (it names the `card` group and hands its focus ring to the artwork), `CARD_ART` on the artwork frame, and add `CARD_ART_CURSOR` for the grid cursor. Movement is behind `motion-safe`; reduced motion keeps every colour and ring change. Inside a frame, pass `after:hidden` to `Poster` so its inner hairline does not double the frame's ring. Chips on artwork (rating, language) use `bg-glass-strong text-on-glass` and the glass accent.

## Dashboard hero

`HeroCarousel` follows the WAI-ARIA auto-rotating carousel with tabs.

- Slides (`buildHeroSlides` in `heroSlides.ts`): up to 3 continue-watching entries, then recently added movies and series with artwork, those with a backdrop first, at most 6, never the same title twice. Continue-watching slides fetch the catalog item for the backdrop, plot, year, genres and rating.
- The section is labelled "Featured" with role description "carousel"; the visible slide is the `tabpanel` ("2 of 5", role description "slide"). The other slides stay in the same grid cell, hidden and `inert`, so the hero keeps the height of its tallest slide and nothing below moves.
- Controls sit in a glass pill in the top corner: rotation toggle, previous, one dial tick per slide (a `tablist`; arrows move and choose, flipped in RTL, Home and End jump, roving tab stop), next. The active tick fills over the dwell (8 s) and freezes with the timer.
- Rotation pauses while the pointer is over the hero, while focus is inside, while the window is hidden, while the hero is scrolled off screen, and after the user pauses it. Resuming finishes the dwell that was left. Under `prefers-reduced-motion` it never rotates and the toggle is not shown; the other controls still work. The live region is off while rotating and polite once the user drives it.
- Artwork: the backdrop, else the poster blown up and blurred into colour, else a tint from the title's hue. A failed image falls to the next option. Text sits on glass that clears toward the inline end, so it reads on any artwork in every theme.

## Settings page

Settings, Appearance:

- Theme cards (light, dark, system) whose previews draw the chosen accent and OLED state.
- OLED black switch; its hint says it applies with the dark theme when the light theme is in effect.
- Accent picker: seven swatches as a radio group (arrows move and choose, Home and End jump), with a live sample of real chrome (rail item, poster, progress, primary button) drawn with the live tokens.
- Size and spacing: density (two-way choice) and interface size (slider 90 to 125 % in 5 % steps, live preview, Reset back to 100 %).

`PREVIEW_PALETTE` and `ACCENT_PALETTE` in `AppearanceSection.tsx` copy token values, because each theme card previews its own theme regardless of the active one. Tests keep them equal to `tokens.css` (`src/features/settings/test/b6.test.tsx` for dark and light, `src/ui/test/appearance.test.tsx` for OLED and every accent).
