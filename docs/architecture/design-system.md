# Design system

How to build a screen with the kit. Tokens live in `src/styles/tokens.css` (values per theme) and `src/styles/globals.css` (`@theme` mapping, utilities, keyframes); components in `src/ui`, imported from `@/ui` (player code imports single files, `@/ui/Tooltip`, to keep its chunk small). Theme mechanics, accents, density and UI scale are in [appearance.md](appearance.md); the shell is in [ui-shell.md](ui-shell.md).

Rule of thumb: if the kit has it, use it. A feature never draws its own switch, checkbox, radio, segmented control, LIVE pill, back button, tooltip or search field.

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
| `bg-raised shadow-1` | the thumb of a segmented control or pill tab (SegmentedControl and Tabs draw it for you) |

Selection is neutral plus the small amber tick, never an amber wash (`bg-accent/10` and the like are banned).

The airing cell in the guide grid and the EPG ribbon takes `bg-active`, not `bg-selected`: the red now line is drawn before the cells so it never strikes through a title, and it has to read through the airing cell's fill. An opaque or mostly opaque fill there hides the line or turns it grey (the contrast test checks the line through the layer).

### Accent

Amber marks, and only marks: the primary action (one per view), focus, the active nav tick and icon, progress, the playing / on-now marker and live progress. Never idle chips, saved or watched marks, segmented choices, switch-off tracks, decorative icons or section headings.

| Token | Use |
| --- | --- |
| `text-accent`, `bg-accent` (+ `-hover`, `-pressed`) | the text and indicator tone: links (`TEXT_LINK`), the active nav icon, the tick, progress fills, tab underlines, drop markers, the radio dot. Deep (#8f4f00) in light so it reads as text |
| `bg-accent-solid text-accent-solid-fg` (+ `hover:bg-accent-solid-hover`, `active:bg-accent-solid-pressed`) | every filled accent control: the primary Button, the on Switch, checked Checkbox, CTA pills in the player. Bright amber with ink text in both themes |
| `ring-focus`, `outline-focus` | focus styles. Never `ring-accent` |

A chosen filter chip is inverted (`bg-fg text-bg`), not amber.

### Status

| Token | Use |
| --- | --- |
| `bg-live-solid text-white` | LIVE pills only, through `LivePill` |
| `bg-live`, `text-live` | live dots and now-lines; live text |
| `bg-danger-solid text-white` | destructive buttons (`Button variant="danger"`) |
| `text-danger`, `bg-danger/15 text-danger` | error text, tinted danger badges |
| `text-success`, `text-warning` | status text and tinted badges (`Badge variant`) |

### Glass (over video and artwork)

`bg-glass` / `bg-glass-strong`, `text-on-glass` / `text-on-glass-muted`, `border-glass-border`, `bg-glass-accent` with `text-glass-accent-fg`. Glass stays dark in every theme, so never use theme text or accent colours on it. Blur only through `glass-blur`, and only on small, short-lived overlays. Kit components take `tone="glass"` where they appear on glass (Tooltip, IconButton's tooltip, SegmentedControl, BackButton).

## Type

Inter Variable for everything (`font-sans`, `font-display`); Barlow Semi Condensed 600 (`font-numeric`) only for channel numbers, clocks and time readouts, the channel-number OSD and LIVE pills, always with `tabular-nums`. Only weight 600 of Barlow ships.

Scale (rem against the 15 px root, so it follows the UI scale; size / line height at 100 %):

| Class | Size | Use |
| --- | --- | --- |
| `text-caption` | 12/16 | metadata, counts, hints under a row |
| `text-body-sm` | 13.5/20 | card titles (`font-medium`), dense rows |
| `text-body` | 15/22 | running text, the default |
| `text-title-sm` | 18/24, 600 | section, rail and dialog headings |
| `text-title` | 22/28, 600 | page titles (the shell header, PageHeader, settings sections) |
| `text-headline` | 28/34, 600 | the search page heading, large empty states |
| `text-display` | 36 to 54, 600 | hero, movie, series and actor titles |

Weights are 400, 500 and 600 only. Headings track in by -0.01 to -0.02 em (the classes set it). Prefer these over `text-[calc(…rem/15)]` in new code; a new `@theme` text size must also go into `src/ui/cn.ts`, or `cn()` treats it as a colour.

## Radii, elevation, spacing

- Radii: `rounded-xs` 4 (badges, checkboxes, key caps), `rounded-sm` 6 (segments, small chips), `rounded-md` 8 (buttons, inputs, rows, menu items), `rounded-lg` 12 (cards, posters, menus, toasts, panels, settings groups), `rounded-xl` 16 (dialogs, the hero frame, sheets), `rounded-full`. Bare `rounded` is a mistake; use `rounded-xs`.
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

- `Button` variants: `primary` (one per view), `secondary` (filled surface with an edge), `ghost`, `danger`. Sizes `sm` (h-8), `md` (h-10), `lg` (h-12). `buttonClass(variant, size, extra)` styles a Link as a button. `loading` keeps focus (aria-disabled).
- `IconButton`: `label` is the accessible name and the tooltip. `tooltip` replaces the tooltip text (the state behind a toggle) or turns it off (`false`); `shortcut` adds key caps; `tooltipSide`, `tooltipTone="glass"`; `pressed` for toggles. It has no `title` prop: no native tooltips on icon buttons.
- `TEXT_LINK`: the one inline link style.

### Tooltip

```tsx
<Tooltip content={t('openGuide')} shortcut="g" side="inline-end" tone="glass" describe={false}>
  <Link to={href} aria-label={t('openGuide')}>…</Link>
</Tooltip>
```

Shows on hover after 400 ms (the next one within 500 ms shows at once), and at once on keyboard focus; never after a touch. Escape, a press, blur or scrolling hides it. On a keyboard-focused trigger Escape also goes on to whatever handles it (a menu or dialog closes, a player menu steps back, PiP ends), so a tooltip never costs an extra press; a tooltip the pointer brought up claims the Escape, so dismissing it does not close the dialog under it. It adds handlers and a ref to its single child, with no wrapper element, so the child keeps its layout. `describe` (default true) points `aria-describedby` at it while shown; pass `false` when it only repeats the accessible name. `content={null}` turns it off without remounting the child. For a custom hook-level trigger, `useTooltip(options)` returns `{ triggerProps, tooltip }`; its `content` may be JSX built in the caller's render.

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
```

- Fields: `Input`, `Textarea`, `Select` (native, restyled), `SearchInput` (search icon, clear button that keeps focus, first Escape clears). A field a feature must build itself takes `fieldClass('sm' | 'md', extra)`. The settings `CommitInput` (commit on blur or Enter, Escape restores) is built on it and merges classes, so `className="w-28"` works.
- `Switch`: the only switch. Off is a recessed track with the control border and a `fg-muted` knob; on is the solid accent with a knob in the fill's text colour (`accent-solid-fg`) and an outline in the accent's indicator tone, so the on track keeps 3:1 against a white panel in light. A white knob is not an option: 1.2:1 on the light off track, 1.8:1 on amber. The classes live in `SWITCH_TONES` (`Field.tsx`), which `contrast.test.ts` reads. `Toggle` is a labelled Switch; the settings `SwitchRow` renders one too.
- `Checkbox`: a native input drawn as an 18 px box; `indeterminate` for mixed. Wrap it in a `<label>` with its text. When the row draws its own focus ring, pass `className="focus-visible:outline-none focus-visible:shadow-none"`.
- `Radio` and `RadioGroup`: native inputs (arrow keys work); RadioGroup is a list of labelled rows with a description and an optional `note`, the chosen row on `bg-selected`.
- `SegmentedControl`: two to six short options side by side (role radiogroup, arrows choose). One neutral raised thumb. `content` shows an icon or sample instead of the label, which then becomes the tooltip. `tone="glass"` inside player menus. `itemClassName="flex-1"` for equal segments. The settings `Segmented` wraps it.
- `Tabs`: `variant="underline"` (page sections: accent bar under the chosen tab) or `variant="pill"` (compact toolbars: the SegmentedControl look). Use Tabs when the choice switches a panel, SegmentedControl when it sets a value.

### Overlays

- `Dialog`: `open`, `onClose`, `title`, `description`, `footer`, `size` (`sm` … `xl`, `full`), `placement="end"` for a drawer. Focus trap, Escape, focus restore, scroll lock, exit animation. Mark the first field `data-autofocus` if it is not the first focusable.
- `Menu`: `items` (actions with `icon`, `hint`, `danger`, `disabled`; separators), `label`, `align`, `placement`. The default trigger is an IconButton (ellipsis) with `label` as its tooltip; a custom `trigger` can take `tooltip`.
- `toast({ title, description, variant, action, progress, duration, id })`: works outside React; an `id` updates in place. Use `errorDescription(err)` as the description of an error toast.

### Status and data

```tsx
<Badge variant="neutral">HD</Badge>
<LivePill />                       {/* pulsing dot, badge size */}
<LivePill size="sm" dot="none" />  {/* inside guide and ribbon cells */}
<MetaLine items={[year, runtime, rating]} />
<ProgressBar value={40} label={t('progress')} tone="glass" size="xs" />
<Kbd combo="mod+k" />
```

- `Badge`: `neutral`, `accent` (accent text on a neutral chip), `success`, `warning`, `danger`, `outline`, `live`. Long text truncates.
- `LivePill`: the only LIVE mark. `dot="still"` in rails of many cards (a running animation per card keeps the compositor busy).
- `MetaLine`: joins metadata with one drawn separator (spoken as commas); empty items drop out. `as="span"` inside a button.
- `ProgressBar`: `tone` accent (default), success, danger, fg, glass; `indeterminate`.
- `Kbd`: key caps in the UI language (`comboKeys` for the strings).
- `EmptyState` (`icon`, `title`, `description`, `action`, `size="page" | "inline"`) and `ErrorState` (`error`, `onRetry`, `action`, `hint`). For a core error the translated hint for its code leads; an error the UI raised itself (a plain `Error`) leads with its own message.
- `Skeleton`, `SkeletonList`, `SkeletonGrid`; `Poster`; `VirtualList`, `VirtualGrid`; `Pagination`.
- Cards: `CARD_ROOT` on the focusable card, `CARD_ART` on the artwork frame, `CARD_ART_CURSOR` for a grid's keyboard cursor (see [appearance.md](appearance.md#cards)). Chips on artwork use `bg-glass-strong text-on-glass`.

## Checks that guard this

- `src/ui/test/contrast.test.ts`: every text pair AA and control boundaries 3:1 in all 21 themes, the edge between divider and border, the state layers (and the now line through the airing cell), the Switch as drawn (`SWITCH_TONES`), the elevation mapping.
- `src/ui/test/kit.test.tsx`: the kit pieces above, and that no feature draws its own switch, checkbox or radio, puts a native `title` on an IconButton, or builds a text field whose border colour hides its focus border.
- `src/ui/test/cn.test.ts`: tailwind-merge knows the theme's sizes, shadows and animations.
