# Design system

How to build a screen with the kit. Tokens live in `src/styles/tokens.css` (values per theme) and `src/styles/globals.css` (`@theme` mapping, utilities, keyframes); components in `src/ui`, imported from `@/ui` (player code imports single files, `@/ui/Tooltip`, to keep its chunk small). Theme mechanics, accents, density and UI scale are in [appearance.md](appearance.md); the shell is in [ui-shell.md](ui-shell.md).

Rule of thumb: if the kit has it, use it. A feature never draws its own switch, checkbox, radio, slider, segmented control, filter chip, watched mark, LIVE pill, back button, tooltip or search field.

## Tokens

### Surfaces and lines

| Token | Use |
| --- | --- |
| `bg-bg` | the page |
| `bg-surface` | panels, cards, dialogs, menus, settings groups |
| `bg-surface-2` | recessed or secondary fills: segmented tracks, secondary buttons, chips, the toast |
| `bg-surface-3` | a step up again: tooltips, neutral badges, the secondary button's hover |
| `bg-pressed` | the pressed state of anything that rests on a surface step |
| `border-divider` | rules between regions already told apart by spacing (rail edge, header rule, list separators, dialog footer) |
| `border-edge` / `ring-edge` | the outline of every container: cards, panels, dialogs, menus, toasts, tooltips, settings groups, guide cells, chips, key caps, poster rings, secondary buttons. About 1.3:1, decorative |
| `border-border` | form controls only: inputs, selects, the off switch track, checkboxes, radios, PIN cells. 3:1, so it identifies the control (WCAG 1.4.11). `hover:border-border` may firm up an edge-outlined thing on hover |

Never put `border-border` on a container: it turns the dark theme into a wireframe.

### State layers

| Token | Use |
| --- | --- |
| `hover:bg-hover`, `active:bg-active` | see-through layers for anything transparent at rest: ghost buttons, rail links, menu items, list rows, disclosures. They read on every surface |
| `bg-surface-2 hover:bg-surface-3 active:bg-pressed` | the same states for something with its own resting fill |
| `bg-selected` + `tuning-tick` | the current item: rail link, settings nav, category, list row, chosen day. Write it conditionally, because `hover:bg-hover` would replace it: `selected ? 'tuning-tick bg-selected text-fg' : 'hover:bg-hover'` |
| `bg-raised shadow-1 ring-1 ring-border` | the thumb of a segmented control or pill tab (SegmentedControl and Tabs draw it for you). The ring is what keeps the choice at 3:1 against the track: the raised fill alone is 1.1 to 1.25:1 |

Selection is neutral plus the small amber tick, never an amber wash (`bg-accent/10` and the like are banned).

The airing cell in the guide grid and the EPG ribbon takes `bg-active`, not `bg-selected`: the red now line is drawn before the cells so it never strikes through a title, and it has to read through the airing cell's fill. An opaque or mostly opaque fill there hides the line or turns it grey (the contrast test checks the line through the layer).

### Accent

Amber marks, and only marks: the primary action (one per view), focus, the active nav tick and icon, progress, the playing / on-now marker and live progress. Never idle chips, saved or watched marks, segmented choices, switch-off tracks, decorative icons or section headings.

| Token | Use |
| --- | --- |
| `text-accent` (+ `-hover`, `-pressed`) | the text tone: links (`TEXT_LINK`), accent text, the active nav icon. Deep (#8f4f00) in light so it reads as text |
| `bg-accent-mark`, `border-accent-mark` | the mark tone, for indicators that are not text: the tuning tick, progress fills (`ProgressBar`), tab underlines, the radio dot, the on switch's and the checked checkbox's outline, slider fills, drop markers, the guide's airing foot. The accent itself in dark; a mid shade in light (#c26900 for amber), 3:1 on every surface and the selected fill, because the deep text tone drawn as a bar reads as brown. A bar, tick or dot still written `bg-accent` moves to it when its file is next touched |
| `bg-accent-solid text-accent-solid-fg` (+ `hover:bg-accent-solid-hover`, `active:bg-accent-solid-pressed`) | every filled accent control: the primary Button, the on Switch, checked Checkbox, CTA pills in the player. The bright dial tone with ink text in both themes, for every accent |
| `ring-focus`, `outline-focus` | focus styles. Never `ring-accent` |

A chosen filter chip is inverted (`bg-fg text-bg`), not amber. A favourite is a state too: its star is neutral (`fill-current text-fg-subtle` inline, `text-fg` on a pressed toggle), never amber and never `text-warning`, which is a status tone (olive in light). On artwork the star beside a rating takes the glass accent.

### Status

| Token | Use |
| --- | --- |
| `bg-live-solid text-white` | LIVE pills only, through `LivePill` |
| `bg-live`, `text-live` | live dots and now-lines; live text |
| `bg-danger-solid text-white` | destructive buttons (`Button variant="danger"`) |
| `text-danger`, `bg-danger/15 text-danger` | error text, tinted danger badges |
| `text-success`, `text-warning` | status text and tinted badges (`Badge variant`) |

### Glass (over video and artwork)

`bg-glass` / `bg-glass-strong`, `text-on-glass` / `text-on-glass-muted`, `border-glass-border`, `bg-glass-accent` with `text-glass-accent-fg`. Glass stays dark in every theme, so never use theme text or accent colours on it. Blur only through `glass-blur`, and only on small, short-lived overlays. Kit components take `tone="glass"` where they appear on glass (Tooltip, IconButton's tooltip, SegmentedControl, BackButton, ProgressBar). A focusable glass control draws focus in the glass accent (`GLASS_FOCUS` in `src/ui/focus.ts` sets `--color-focus` and `--color-glow` on it), because the theme's focus is a deep shade in light that does not read on glass. Anything drawn on a picture is glass: a progress bar on a poster, a thumbnail or the hero is `ProgressBar tone="glass"` (the strong glass as its track and the glass accent as its fill in every theme, so the fill keeps 3:1 on pale art), and its band under it `bg-glass/60`, not the theme's scrim.

Buttons over the picture (the player's error screen, Up next, the sleep prompt, the external player's stage) use the player's `glassButton(variant, size)` (`src/features/player/components/glassButton.ts`): the kit Button's shapes with `primary` (the solid accent, one per surface), `secondary` (a see-through fill with a hairline) and `ghost`, white state layers, and the 44 px touch floor. The kit Button has no glass variants; if it gets them, the player can switch. Inside the player a level is not progress: volume sliders are white, and only playback progress is amber.

## Type

Inter Variable for everything (`font-sans`, `font-display`); Barlow Semi Condensed 600 (`font-numeric`) only for channel numbers, clocks and time readouts, the channel-number OSD and LIVE pills, always with `tabular-nums`. Only weight 600 of Barlow ships.

Scale (rem against the 15 px root, so it follows the UI scale; size / line height at 100 %):

| Class | Size | Use |
| --- | --- | --- |
| `text-caption` | 12/16 | metadata, counts, hints under a row |
| `text-body-sm` | 13.5/20 | card titles (`font-medium`), dense rows |
| `text-body` | 15/22 | running text, the default |
| `text-title-sm` | 18/24, 600 | section, rail and dialog headings, settings section headings |
| `text-title` | 22/28, 600 | page titles (the shell header, PageHeader) |
| `text-headline` | 28/34, 600 | the search page heading, large empty states |
| `text-display` | 36 to 54, 600 | hero, movie, series and actor titles |

Weights are 400, 500 and 600 only. Headings track in by -0.01 to -0.02 em (the classes set it). Prefer these over `text-[calc(…rem/15)]` in new code; a new `@theme` text size must also go into `src/ui/cn.ts`, or `cn()` treats it as a colour.

## Radii, elevation, spacing

- Radii: `rounded-xs` 4 (badges, checkboxes, key caps), `rounded-sm` 6 (segments, small status chips on artwork), `rounded-md` 8 (buttons, inputs, rows, menu items, segmented tracks), `rounded-lg` 12 (cards, posters, menus, toasts, panels, settings groups), `rounded-xl` 16 (dialogs, the hero frame, sheets), `rounded-full` (filter chips, the watched mark, sliders, dots, avatars). Bare `rounded` is a mistake; use `rounded-xs`.
- Elevation: `shadow-1` (cards, raised thumbs, the primary button), `shadow-2` (menus, popovers, toasts, tooltips, floating panels, the mini player), `shadow-3` (dialogs, drawers, sheets). They read `--elevation-N`, which differs per theme; in CSS write `var(--elevation-N)`. Never put a literal shadow in `@theme`.
- Spacing follows density (compact shrinks every spacing step by an eighth); text and icons follow the UI scale only.
- Page gutter: `--page-gutter` (1rem, 1.5rem from `sm`, 2rem from `lg`), shared by the header and `Page`.

## Icons

Lucide, sized with the `size` prop on this scale: 12 (inline metadata), 14 (dense rows), 16 (buttons, menus; the default), 18 (rail, header, dialog close), 24 (hero and large art). A rule in `globals.css` restates each size in rem, so icons grow with the UI scale like the text beside them; a size utility on the icon (`size-4`) still wins. `EmptyState` sizes its own icon. Icons are `aria-hidden` unless they are the only content of something without a label.

## Motion

Durations `--duration-fast` 120 ms, `--duration-base` 180 ms, `--duration-slow` 280 ms (`duration-(--duration-fast)`); curves `ease-enter`, `ease-exit`. Enter animations: `animate-fade-in`, `animate-pop-in`, `animate-toast-in`, `animate-drawer-in`, `animate-sheet-in`; each has an `-out` twin that holds its last frame. Always behind `motion-safe:`.

Overlays animate out through `usePresence(open, ref)`: it keeps the element mounted with `closing` true until its `*-out` animation ends, and unmounts at once when nothing animates (reduced motion, jsdom). Dialog, the drawer (slides back to the inline end), Menu and Toast use it. A new overlay does the same:

```tsx
const ref = useRef<HTMLDivElement>(null);
const { present, closing } = usePresence(open, ref);
if (!present) return null;
return <div ref={ref} inert={closing || undefined} className={closing ? 'motion-safe:animate-pop-out' : 'motion-safe:animate-pop-in'}>…</div>;
```

Treat `closing` as closed for everything but drawing: focus goes back and scrolling unlocks when `open` turns false.

## Focus and touch

- Focus: the global `:focus-visible` rule draws a 2 px focus outline with a soft glow. Text fields draw a focus border and a 3 px glow instead. That field rule sits in `@layer base`, so any `border-*` colour utility on the field outranks its focus border: a field built by hand that sets its own border colour must also set `focus-visible:border-focus` (or its own focus ring), or take `fieldClass`. `kit.test.tsx` flags text fields that do neither. Forced-colours mode gets a system outline on every focused control, so `outline-none` plus a ring is safe. A scroll container holding fields keeps a little padding so the glow is not clipped (Dialog's body does).
- Touch: under `(pointer: coarse)` Button `sm`/`md`, IconButton, menu items and the toast's dismiss button grow to 44 px (`TOUCH_TARGET`, exported for hand-built controls). Keyboard-only hints use `pointer-coarse:hidden`.

## Components

### Page scaffold

```tsx
<Page width="wide" className="flex flex-col gap-8">
  <PageHeader title={t('title')} count={fmt.format(total)} subtitle={t('lead')} actions={<Button variant="primary">{t('add')}</Button>} />
  <section aria-labelledby="recent-h" className="flex flex-col gap-3">
    <SectionHeader id="recent-h" title={t('recent')} count={n} seeAll={{ to: '/recent' }} />
    …
  </section>
</Page>
```

- `Page`: side padding from `--page-gutter`, `py-6`, and a width cap: `narrow` 56rem (settings, forms), `default` 80rem (lists, stats), `wide` 120rem (grids, rails), `full` (the guide, the player). It starts at the gutter, on the header title's line, and is not centred. A page root that pads itself (`px-6`) or centres itself (`mx-auto max-w-…`) leaves that line, so the title and the content no longer share a left edge; a full-height page passes its own height and padding (`className="flex h-[calc(100dvh-var(--header-height))] flex-col pt-4 pb-4"`).
- `PageHeader`: h1 in `text-title`, optional `count` (muted, formatted by the caller), `subtitle` and `actions`. Most pages set their title in the shell header with `usePageHeader` and keep a visually hidden h1; use PageHeader when the title belongs in the content.
- `SectionHeader`: h2 in `text-title-sm` with optional `count`, `action` (rail arrows, a sort menu) and `seeAll={{ to, label? }}` ("See all" and a chevron).
- `BackButton`: `<BackButton to="/movies" label={t('movies')} />`, or `onClick={goBack}` (with `to` as well, the link still shows where back is and opens in a new tab). `tone="glass"` over artwork.

### Buttons and links

```tsx
<Button variant="primary" icon={<Play size={16} />}>{t('play')}</Button>
<Button variant="secondary" size="sm" loading={saving}>{t('save')}</Button>
<IconButton label={t('mute')} shortcut="m" icon={<VolumeX size={18} />} onClick={toggle} />
<Link to="/sources" className={TEXT_LINK}>{t('addSource')}</Link>
```

- `Button` variants: `primary` (one per view), `secondary` (filled surface with an edge), `ghost` (no fill at rest, its label in the full text tone so it reads as something to press; an icon-only ghost `IconButton` rests in the muted tone, `GHOST_ICON`), `danger`. Sizes `sm` (h-8), `md` (h-10), `lg` (h-12). `buttonClass(variant, size, extra)` styles a Link as a button. `loading` keeps focus (aria-disabled).
- `IconButton`: `label` is the accessible name and the tooltip. `tooltip` replaces the tooltip text (the state behind a toggle) or turns it off (`false`); `shortcut` adds key caps; `tooltipSide`, `tooltipTone="glass"`; `pressed` for toggles. It has no `title` prop: no native tooltips on icon buttons.
- `TEXT_LINK`: the one inline link style.

### Tooltip

```tsx
<Tooltip content={t('openGuide')} shortcut="g" side="inline-end" tone="glass" describe={false}>
  <Link to={href} aria-label={t('openGuide')}>…</Link>
</Tooltip>
```

Shows on hover after 400 ms (the next one within 500 ms shows at once, and the one before it goes), and at once on keyboard focus; never after a touch. It stays while the pointer is on the trigger or on the tooltip itself and goes 150 ms after it leaves both (`TOOLTIP_CLOSE_MS`), so the pointer can cross onto it and rest there (WCAG 1.4.13); a press on it closes it, and its pointer events stop at the tooltip, so they never reach the trigger's ancestors. Escape, a press, blur or scrolling hides it. On a keyboard-focused trigger Escape also goes on to whatever handles it (a menu or dialog closes, a player menu steps back, PiP ends, a page with Escape-back goes back), and the tooltip is gone from the page before it does, so a tooltip never costs an extra press. A tooltip the pointer brought up hears Escape wherever focus is (WCAG 1.4.13: the body, a field, another control) and claims that press, so dismissing it does not close the dialog under it or go Back on a page with Escape-back; the next press does. It adds handlers and a ref to its single child, with no wrapper element, so the child keeps its layout. `describe` (default true) points `aria-describedby` at it while shown; pass `false` when it only repeats the accessible name. `content={null}` turns it off without remounting the child. For a custom hook-level trigger, `useTooltip(options)` returns `{ triggerProps, tooltip }`; its `content` may be JSX built in the caller's render.

Keep native `title` only for text cut by truncation (a long channel name) and for the reason on a disabled button, which gets no pointer events.

### Form controls

```tsx
<Input label={t('name')} hint={t('nameHint')} error={err} value={v} onValueChange={setV} />
<SearchInput size="sm" value={q} onChange={setQ} label={t('filterGroups')} />
<Select label={t('sort')} options={opts} value={sort} onValueChange={setSort} />
<Toggle label={t('autoRefresh')} description={t('autoRefreshHint')} checked={on} onChange={setOn} />
<Switch id={id} checked={on} onCheckedChange={setOn} aria-describedby={descId} />
<label className="flex items-center gap-3"><Checkbox checked={c} onCheckedChange={setC} />{t('alsoDelete')}</label>
<RadioGroup label={t('player')} value={p} onValueChange={setP} options={[{ value: 'mpv', label: 'mpv', description: t('mpvHint') }]} />
<SegmentedControl label={t('density')} value={d} onChange={setD} options={[{ value: 'comfortable', label: t('comfortable') }, { value: 'compact', label: t('compact') }]} />
<Slider id={id} min={0} max={10} step={0.5} value={v} onValueChange={setV} onPointerUp={save} aria-valuetext={t('stars', { value: v })} className="w-44" />
```

- Fields: `Input`, `Textarea`, `Select` (native, restyled), `SearchInput` (search icon, clear button that keeps focus, first Escape clears). A field a feature must build itself takes `fieldClass('sm' | 'md', extra)`. The settings `CommitInput` (commit on blur or Enter, Escape restores) is built on it and merges classes, so `className="w-28"` works.
- `Switch`: the only switch. Off is a recessed track with the control border and a `fg-muted` knob; on is the solid accent with a knob in the fill's text colour (`accent-solid-fg`) and an outline in the accent's indicator tone, so the on track keeps 3:1 against a white panel in light. A white knob is not an option: 1.2:1 on the light off track, 1.8:1 on amber. The classes live in `SWITCH_TONES` (`Field.tsx`), which `contrast.test.ts` reads. Forced colours would paint the knob over, so the switch opts out of them and draws itself in system colours (`SWITCH_FORCED`): off a framed Canvas track with a CanvasText knob, on a Highlight track with a HighlightText knob. `Toggle` is a labelled Switch; the settings `SwitchRow` renders one too.
- `Checkbox`: a native input drawn as an 18 px box; checked and mixed fill with the solid accent inside a mark-tone outline; `indeterminate` for mixed. Wrap it in a `<label>` with its text. When the row draws its own focus ring, pass `className="focus-visible:outline-none focus-visible:shadow-none"`.
- `Radio` and `RadioGroup`: native inputs (arrow keys work), which go back to the system's own radio in forced colours, where the drawn dot would vanish; RadioGroup is a list of labelled rows with a description and an optional `note`, the chosen row on `bg-selected`. To hide a radio inside a card that draws the choice itself, wrap it in a `<span className="sr-only">`: `wrapperClassName="sr-only"` does not work, because the radio's own `relative` and size outlast it in `cn`.
- `SegmentedControl`: two to six short options side by side (role radiogroup, arrows choose). One neutral raised thumb with a 3:1 ring (`SEGMENT_TONES`, which `contrast.test.ts` reads); in forced colours the chosen segment takes the system's Highlight. The track's edge is an outline drawn just inside it, not a border, so the control is exactly as tall as an `md` button or field (and `sm` as an `sm` one) and lines up with them in a toolbar or a settings row; not an inset ring either, since forced colours drop box-shadows and would leave the unchosen segments as loose text, while they repaint an outline in the system's text colour. `content` shows an icon or sample instead of the label, which then becomes the tooltip. `tone="glass"` inside player menus and over the multi-view wall. `size="sm"` (h-8, 30 px at 100 %) beside `sm` buttons in a compact header (the ribbon's view switch, the multi-view layout picker). `itemClassName="flex-1"` for equal segments. An option with `disabledReason` cannot be chosen but stays focusable and hoverable (aria-disabled): its tooltip and description give the reason, and the arrows stop on it without choosing it; plain `disabled` takes an option out with no reason. `testId` per option. The settings `Segmented` wraps it. A row of view or layout buttons is a SegmentedControl, never IconButtons with `bg-raised` on a track of their own.
- `Slider`: the one range slider (`Field.tsx`, the `slider` utility in `globals.css`). A native input, so arrows, Home, End and Page keys work; `onValueChange` gets a number on every move, so a costly save goes on pointer up, key up or blur. Up to the value the track fills in the mark tone, the rest is a recessed track with the 3:1 control border, the thumb is the solid accent with a mark outline (3:1 on a white panel) and a ring of the surface, and the fill follows the input's direction, so it grows from the right in RTL. Focus is the global outline. Name it (`<label htmlFor>` or `aria-label`) and pass `aria-valuetext` when the number does not say it. The player's level sliders over video (volume, subtitle position) keep their white `.player-range` look, since a level is not progress.
- `Tabs`: `variant="underline"` (page sections: accent bar under the chosen tab) or `variant="pill"` (compact toolbars: the SegmentedControl look). Use Tabs when the choice switches a panel, SegmentedControl when it sets a value.

### Overlays

- `Dialog`: `open`, `onClose`, `title`, `description`, `footer`, `size` (`sm` … `xl`, `full`), `placement="end"` for a drawer, and `sheet` for a dialog that is a bottom sheet below sm (full width from the bottom edge, top corners rounded, clear of the home indicator, rising in; the add and edit source dialogs, the Sources page's Sort and filter, the phone's More sheet). A sheet's height cap can be changed with `className="max-sm:max-h-…"`. `hideTitle` keeps the title as the accessible name only; with `hideClose` too no header row is drawn at all (the command palette). The close button sits in a box one title line tall, so it centres on the title and its 40 px do not set the header's height. Focus trap, Escape, focus restore, scroll lock, exit animation. Mark the first field `data-autofocus` if it is not the first focusable.
- `Menu`: `items` (actions with `icon`, `hint`, `danger`, `disabled`; separators), `label`, `align`, `placement`. A `danger` item is red as a whole, its icon too, with a red wash under the pointer and focus (`MENU_DANGER`; `contrast.test.ts` holds its text to 4.5:1 on the strongest wash). The default trigger is an IconButton (ellipsis) with `label` as its tooltip; a custom `trigger` can take `tooltip`.
- `toast({ title, description, variant, action, progress, duration, id })`: works outside React; an `id` updates in place. Use `errorDescription(err)` as the description of an error toast.

### Status and data

```tsx
<Badge variant="neutral">HD</Badge>
<LivePill />                       {/* pulsing dot, badge size */}
<LivePill size="sm" dot="none" />  {/* inside guide and ribbon cells */}
<MetaLine items={[year, runtime, rating]} />
<ProgressBar value={40} label={t('progress')} tone="glass" size="xs" />
<FilterChip pressed={on} dot={genreColor(g)} onClick={toggle}>{t('sports')}</FilterChip>
<WatchedChip className="absolute end-1.5 top-1.5" />
<Kbd combo="mod+k" />
```

- `Badge`: `neutral`, `accent` (accent text on a neutral chip), `success`, `warning`, `danger`, `outline`, `live`. Long text truncates.
- `LivePill`: the only LIVE mark. `dot="still"` in rails of many cards (a running animation per card keeps the compositor busy).
- `MetaLine`: joins metadata with one drawn separator (spoken as commas); empty items drop out. Each separator is one unit with the item after it, so a wrapped line never ends on a dot. `as="span"` inside a button.
- `ProgressBar`: `tone` accent (default, the mark tone), success, danger, fg, glass (every bar on artwork); `indeterminate`. It reports a percentage (0 to 100) whatever `max` is, so `value={0.63} max={1}` reads 63 %; `valueText` says the value in words ("16 minutes left"). `decorative` hides it from assistive tech, for a bar inside a control whose name already gives the share (a poster card's link ends in "18% watched", an episode button); every other bar takes a `label`.
- `FilterChip`: a pill that turns a filter on or off (aria-pressed) in a row of others: `h-7`, `rounded-full`, `bg-surface-2` with the edge at rest, inverted (`bg-fg text-bg`) when on, never amber. `dot` (a colour) or `icon` leads, `count` trails in the quiet tone; the label truncates and takes `dir="auto"`, so pass the whole text as `title` when it can be cut. `filterChipClass(on, extra)` styles a link as a chip. Chips that only inform (where a list's channels come from) are not filter chips: show the source's `SourceMonogram` with the count.
- `WatchedChip`: the one watched mark on artwork, a 20 px round glass tick in the top-end corner of posters, My List cards and episode thumbnails. A watched title shows it instead of a progress bar. Hidden from assistive tech; the card's name says "Watched".
- `Kbd`: key caps in the UI language (`comboKeys` for the strings).
- `EmptyState` (`icon`, `title`, `description`, `action`, `size="page" | "inline"`) and `ErrorState` (`error`, `onRetry`, `action`, `hint`). For a core error the translated hint for its code leads; an error the UI raised itself (a plain `Error`) leads with its own message.
- `Skeleton`, `SkeletonList`, `SkeletonGrid`; `Poster`; `VirtualList`, `VirtualGrid`; `Pagination`.
- `SourceMonogram`: a source's initials on its own hue (`name`; size, corner and text size through `className`). The rail, the phone's More sheet, the source cards and the library's source badges draw it, so a source looks the same everywhere.
- Cards: `CARD_ROOT` on the focusable card, `CARD_ART` on the artwork frame, `CARD_ART_CURSOR` for a grid's keyboard cursor (see [appearance.md](appearance.md#cards)). Chips on artwork use `bg-glass-strong text-on-glass`.

## Checks that guard this

- `src/ui/test/contrast.test.ts`: every text pair AA and control boundaries 3:1 in all 21 themes, the mark tone 3:1 on every surface and the selected fill, the edge between divider and border, the state layers (and the now line through the airing cell), the Switch as drawn (`SWITCH_TONES`), the chosen segment's ring on its track (`SEGMENT_TONES`, app and glass), glass focus and the glass progress track (`PROGRESS_TRACK`) over black and white for every accent, the elevation mapping.
- `src/ui/test/kit.test.tsx`: the kit pieces above, and that no feature draws its own switch, checkbox, radio or range input (outside the level sliders over video), puts a native `title` on an IconButton, or builds a text field whose border colour hides its focus border.
- `src/ui/test/round2.test.tsx`: ProgressBar percentages and decorative bars, glass bars and the watched chip on posters, My List cards, episode and Up next thumbnails, MetaLine wrapping, the dialog close button, hover tooltips closing on Escape from anywhere, Slider, FilterChip and segmented options with a reason.
- `src/ui/test/review3.test.tsx`: hoverable tooltips, one Escape for Back from a keyboard tooltip, the segment ring and glass focus as rendered, the glass progress track, and the Switch, Radio and Checkbox marks for forced colours and the light theme.
- `src/ui/test/cn.test.ts`: tailwind-merge knows the theme's sizes, shadows and animations.
