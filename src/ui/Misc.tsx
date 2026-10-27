import i18next from 'i18next';
import { Check } from 'lucide-react';
import { Children, type ComponentPropsWithRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from './cn';
import { pauseWhenOffscreen } from './offscreen';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

/** Key caps drawn as a symbol, the same in every language. */
const KEY_SYMBOLS: Record<string, string> = {
  ...(IS_MAC ? { mod: '⌘', meta: '⌘', alt: '⌥' } : {}),
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  // Media keys show the symbol printed on the key. U+FE0E asks for the text glyph, so Windows
  // does not swap in a colour emoji; KEY_NAMES gives each one a spoken name.
  mediaplaypause: '⏯︎',
  mediastop: '⏹︎',
  mediatracknext: '⏭︎',
  mediatrackprevious: '⏮︎',
};

/**
 * i18n keys (common namespace) of key caps printed as a word (German keyboards say "Strg" and
 * "Entf"), with the English text for when no strings are loaded (tests, a failed locale load).
 */
const KEY_LABELS: Record<string, readonly [key: string, english: string]> = {
  mod: ['keyCtrl', 'Ctrl'],
  ctrl: ['keyCtrl', 'Ctrl'],
  meta: ['keyWin', 'Win'],
  alt: ['keyAlt', 'Alt'],
  shift: ['keyShift', 'Shift'],
  space: ['keySpace', 'Space'],
  escape: ['keyEsc', 'Esc'],
  enter: ['keyEnter', 'Enter'],
  digit: ['keyDigits', '0-9'],
  pageup: ['keyPageUp', 'PgUp'],
  pagedown: ['keyPageDown', 'PgDn'],
  backspace: ['keyBackspace', 'Backspace'],
  tab: ['keyTab', 'Tab'],
  home: ['keyHome', 'Home'],
  end: ['keyEnd', 'End'],
  delete: ['keyDelete', 'Del'],
  contextmenu: ['keyMenu', 'Menu'],
};

/**
 * i18n keys (common namespace) of spoken names for keys whose label is a symbol a screen reader
 * would read out by its Unicode name.
 */
const KEY_NAMES: Record<string, readonly [key: string, english: string]> = {
  mediaplaypause: ['keyNamePlayPause', 'Play/Pause'],
  mediastop: ['keyNameStop', 'Stop'],
  mediatracknext: ['keyNameNextTrack', 'Next track'],
  mediatrackprevious: ['keyNamePreviousTrack', 'Previous track'],
};

/** Looks up a common-namespace key. Kbd passes its hook's `t`, so it re-renders on a language switch. */
type KeyTranslate = (key: string) => string;
const globalT: KeyTranslate = (key) => i18next.t(key, { ns: 'common' });

/** The translation, or the English text when the key has none (it comes back as the key or empty). */
function translated([key, english]: readonly [string, string], t: KeyTranslate): string {
  const text = t(key);
  return text && text !== key ? text : english;
}

const comboParts = (combo: string) =>
  combo
    .split('+')
    .filter(Boolean)
    .map((k) => k.trim().toLowerCase());

function keyLabel(key: string, t: KeyTranslate): string {
  const symbol = KEY_SYMBOLS[key];
  if (symbol) return symbol;
  const label = KEY_LABELS[key];
  if (label) return translated(label, t);
  return key.length === 1 ? key.toUpperCase() : key[0]!.toUpperCase() + key.slice(1);
}

/** Human labels, in the UI language, for a combo string like `mod+shift+k`. */
export function comboKeys(combo: string, t: KeyTranslate = globalT): string[] {
  return comboParts(combo).map((key) => keyLabel(key, t));
}

/** The combo as a screen reader should say it: like {@link comboKeys}, with media keys by name. */
function comboKeyNames(combo: string, t: KeyTranslate): string[] {
  return comboParts(combo).map((key) => {
    const name = KEY_NAMES[key];
    return name ? translated(name, t) : keyLabel(key, t);
  });
}

export interface KbdProps {
  /** A combo (`mod+k`) rendered as separate keys, or arbitrary children. */
  combo?: string;
  children?: ReactNode;
  className?: string;
  /**
   * `md` (default) for key caps in running text, lists and dialogs; `sm` for a cap inside a
   * 30 px control (the header's search slot): 19 px with a 10 px label, the tooltip's size.
   */
  size?: 'sm' | 'md';
}

const KBD_SIZES = { sm: 'h-5 min-w-5 px-1 text-2xs', md: 'h-6 min-w-6 px-1.5 text-xs' } as const;

export function Kbd({ combo, children, className, size = 'md' }: KbdProps) {
  const { t } = useTranslation('common');
  const keyClass = cn(
    'inline-flex items-center justify-center rounded-xs border border-edge border-b-2 bg-surface-2 font-sans font-medium text-fg-muted',
    KBD_SIZES[size],
  );
  if (combo) {
    const tr: KeyTranslate = (key) => t(key);
    const keys = comboKeys(combo, tr);
    const names = comboKeyNames(combo, tr);
    return (
      // A plain span cannot carry aria-label (prohibited on the generic role), so the
      // spoken form is visually hidden text and the key caps are hidden from AT.
      <span className={cn('inline-flex items-center gap-1', className)}>
        <span className="sr-only">{names.join(' + ')}</span>
        {keys.map((k, i) => (
          // A symbol key also names itself on hover.
          <kbd key={`${k}-${i}`} className={keyClass} title={names[i] !== k ? names[i] : undefined} aria-hidden>
            {k}
          </kbd>
        ))}
      </span>
    );
  }
  return <kbd className={cn(keyClass, className)}>{children}</kbd>;
}

export type BadgeVariant = 'neutral' | 'accent' | 'live' | 'success' | 'warning' | 'danger' | 'outline';

export interface BadgeProps extends ComponentPropsWithRef<'span'> {
  variant?: BadgeVariant;
}

const badgeVariants: Record<BadgeVariant, string> = {
  neutral: 'bg-surface-3 text-fg-muted',
  // Accent text on a neutral chip: a solid amber chip would compete with the primary action.
  accent: 'bg-surface-3 text-accent',
  // White on the solid LIVE red, in the tuner-dial face (DS-SEMANTIC-FILLS).
  live: 'bg-live-solid text-white font-numeric tracking-wide uppercase',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-danger/15 text-danger',
  outline: 'border border-edge text-fg-muted',
};

/**
 * Puts each run of text in a block that can shrink and truncate. Badge is inline-flex, so bare
 * text under a caller's max-w would clip with no ellipsis. Icons and other elements stay flex
 * items beside it (the gap keeps them apart). leading-normal: under the badge's leading-none the
 * clip (overflow: hidden) would cut descenders (g, y, p) and Arabic marks; the line still fits h-5.
 */
function truncatingText(children: ReactNode): ReactNode[] {
  const out: ReactNode[] = [];
  let run: (string | number)[] = [];
  const flush = () => {
    if (run.length === 0) return;
    out.push(
      <span key={`text-${out.length}`} className="min-w-0 truncate leading-normal">
        {run.join('')}
      </span>,
    );
    run = [];
  };
  for (const child of Children.toArray(children)) {
    if (typeof child === 'string' || typeof child === 'number') run.push(child);
    else {
      flush();
      out.push(child);
    }
  }
  flush();
  return out;
}

export function Badge({ variant = 'neutral', className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-1.5 text-xs leading-none font-semibold tabular',
        badgeVariants[variant],
        className,
      )}
      {...rest}
    >
      {truncatingText(children)}
    </span>
  );
}

export interface LivePillProps {
  /** `md` (default): a badge-sized pill for cards and lists. `sm`: the small pill inside guide and ribbon cells. */
  size?: 'sm' | 'md';
  /**
   * `pulse` (default): a dot that pulses a few times as it appears (motion-safe, and only while
   * on screen). `still`: the dot without the pulse, for rails of many cards, where every running
   * animation keeps the compositor busy. `none`: the word alone.
   */
  dot?: 'pulse' | 'still' | 'none';
  className?: string;
}

/**
 * The one LIVE mark: white on the solid live red, upper case in the tuner-dial face
 * (DS-SEMANTIC-FILLS). Use it wherever a programme or channel is on air now; the player's own
 * status readout (on air, standby, no signal) is a different control.
 */
export function LivePill({ size = 'md', dot = 'pulse', className }: LivePillProps) {
  const { t } = useTranslation('common');
  return (
    <Badge variant="live" data-live-pill="" className={cn(size === 'sm' && 'h-4 gap-1 rounded-xs px-1 text-2xs', className)}>
      {dot !== 'none' && (
        <span
          ref={dot === 'pulse' ? pauseWhenOffscreen : undefined}
          aria-hidden
          className={cn('h-1.5 w-1.5 rounded-full bg-white', dot === 'pulse' && 'motion-safe:animate-live-pulse')}
        />
      )}
      {t('live')}
    </Badge>
  );
}

export interface MetaLineProps extends Omit<ComponentPropsWithRef<'p'>, 'children'> {
  /** The facts, in order (year, runtime, rating, source). Empty ones (null, false, '') drop out. */
  items: ReactNode[];
  /** Element to render; `span` inside a button or another line of text. */
  as?: 'p' | 'div' | 'span';
}

/**
 * A line of metadata joined by one separator: "2021 · 1 h 52 min · PG-13". The dots are drawn,
 * not spoken; a screen reader hears the facts with a comma between them. Wraps between items,
 * never inside one, and a separator travels with the item after it, so no line ends on a dot.
 * Caption size and muted colour by default; pass classes to change either.
 */
export function MetaLine({ items, as: Tag = 'p', className, ...rest }: MetaLineProps) {
  const shown = items.filter((i) => i !== null && i !== undefined && i !== false && i !== '');
  if (shown.length === 0) return null;
  return (
    <Tag className={cn('flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-caption text-fg-muted', className)} {...rest}>
      {shown.map((item, i) =>
        i === 0 ? (
          <span key={i} className="min-w-0">
            {item}
          </span>
        ) : (
          // The dot and the item are one flex unit (no break between its children), so a wrap moves
          // both; a long item can still wrap inside itself.
          <span key={i} className="inline-flex min-w-0 items-center gap-1.5">
            <span aria-hidden className="text-fg-subtle">
              ·
            </span>
            <span className="sr-only">, </span>
            <span className="min-w-0">{item}</span>
          </span>
        ),
      )}
    </Tag>
  );
}

/**
 * The inline text link: accent text, underline on hover, the pressed accent while held. Use it
 * on <a> and router <Link> elements inside running text and empty states, and on link-styled
 * buttons. A link that acts like a button (a call to action) is a Button or buttonClass instead.
 */
export const TEXT_LINK = 'rounded-xs font-medium text-accent underline-offset-2 hover:underline active:text-accent-pressed';

export interface ProgressBarProps {
  value: number;
  max?: number;
  /** Accessible name. */
  label?: string;
  /** What a screen reader says for the value instead of the percentage ("16 minutes left"). */
  valueText?: string;
  /**
   * Drawn only, hidden from assistive tech: for a bar inside a control whose name already says
   * how far (a poster card's link ends in "18% watched"), so it does not add a second, unnamed value.
   */
  decorative?: boolean;
  className?: string;
  /** Unknown progress: animated stripe. */
  indeterminate?: boolean;
  /**
   * `accent` (default) fills in the mark tone. `glass`: for every bar drawn on artwork or video
   * (C8), a dark glass track and the bright glass accent, in every theme. A theme colour never
   * sits on a picture, so a bar inside `CARD_ART`, a thumbnail or the hero takes `glass`.
   */
  tone?: 'accent' | 'success' | 'danger' | 'fg' | 'glass';
  size?: 'xs' | 'sm' | 'md';
}

/**
 * The bar's track per tone, exported so src/ui/test/contrast.test.ts checks the fill against the
 * track it really draws. On a picture the track is the strong glass, which stays dark whatever the
 * artwork is: a see-through light track left the fill at 1.3:1 on pale art.
 */
export const PROGRESS_TRACK = { theme: 'bg-surface-3', glass: 'bg-glass-strong' } as const;

/**
 * A determinate or indeterminate bar. It reports a percentage (0 to 100) whatever `max` is, so a
 * fraction with `max={1}` reads "63 %", not "1 of 1".
 */
export function ProgressBar({
  value,
  max = 100,
  label,
  valueText,
  decorative,
  className,
  indeterminate,
  tone = 'accent',
  size = 'sm',
}: ProgressBarProps) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const toneClass = { accent: 'bg-accent-mark', success: 'bg-success', danger: 'bg-danger', fg: 'bg-fg', glass: 'bg-glass-accent' }[tone];
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-hidden={decorative || undefined}
      aria-valuemin={0}
      aria-valuemax={indeterminate ? undefined : 100}
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}
      aria-valuetext={indeterminate ? undefined : valueText}
      className={cn(
        'relative w-full overflow-hidden rounded-full',
        tone === 'glass' ? PROGRESS_TRACK.glass : PROGRESS_TRACK.theme,
        { xs: 'h-0.75', sm: 'h-1.5', md: 'h-2.5' }[size],
        className,
      )}
    >
      {indeterminate ? (
        <div className={cn('absolute inset-y-0 w-1/3 rounded-full motion-safe:animate-indeterminate', toneClass)} />
      ) : (
        <div
          className={cn('h-full rounded-full motion-safe:transition-[width] motion-safe:duration-300', toneClass)}
          style={{ width: `${pct}%` }}
        />
      )}
    </div>
  );
}

export interface WatchedChipProps {
  className?: string;
  testId?: string;
}

/**
 * The one "watched" mark on artwork: a small round glass chip with a tick, at the art's top-end
 * corner (posters, My List cards, episode thumbnails). Watched is a state, so it is never amber,
 * and a watched title shows no progress bar. Hidden from assistive tech: the card's name says
 * "Watched".
 */
export function WatchedChip({ className, testId }: WatchedChipProps) {
  return (
    <span
      aria-hidden
      data-testid={testId}
      className={cn('inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-glass-strong text-on-glass shadow-1', className)}
    >
      <Check aria-hidden size={13} strokeWidth={3} />
    </span>
  );
}

/**
 * Classes of a filter chip, for a Link or a custom element drawn as one (`FilterChip` is the button).
 * A chip is as tall as an `sm` button or field (h-8), so a row of chips lines up with the "All
 * categories" button or the sort menu beside it, and its label is body text in the full text tone:
 * a caption in the muted tone read as a disabled tag rather than something to press. A count after
 * the label stays quiet (FilterChip).
 */
export function filterChipClass(on: boolean, className?: string): string {
  return cn(
    'inline-flex h-8 min-w-0 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-body-sm font-medium motion-safe:transition-colors',
    // A chosen filter is inverted, never amber: amber marks actions and progress.
    on ? 'border-transparent bg-fg text-bg hover:bg-fg/90' : 'border-edge bg-surface-2 text-fg hover:bg-surface-3 active:bg-pressed',
    className,
  );
}

export interface FilterChipProps extends Omit<ComponentPropsWithRef<'button'>, 'type'> {
  /** The chip is on: its filter applies (aria-pressed). */
  pressed: boolean;
  /** A leading dot in this colour (a genre's stripe colour). */
  dot?: string;
  /** A leading icon, instead of a dot. */
  icon?: ReactNode;
  /** A trailing count, in the quieter tone. */
  count?: ReactNode;
}

/**
 * A filter chip: a pill that turns a filter on or off (aria-pressed), in a row of others. Long
 * labels truncate; pass the whole text as `title` when that can happen. Use `filterChipClass`
 * for a chip that is a link.
 */
export function FilterChip({ pressed, dot, icon, count, className, children, ...rest }: FilterChipProps) {
  return (
    <button type="button" aria-pressed={pressed} className={filterChipClass(pressed, className)} {...rest}>
      {dot ? <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: dot }} /> : icon}
      {/* dir="auto": a chip often names provider text (a source), which keeps its own direction. */}
      <span dir="auto" className="min-w-0 truncate">
        {children}
      </span>
      {count !== undefined && count !== null ? <span className={cn('tabular shrink-0', !pressed && 'text-fg-subtle')}>{count}</span> : null}
    </button>
  );
}
