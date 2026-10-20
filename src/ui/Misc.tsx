import i18next from 'i18next';
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
}

export function Kbd({ combo, children, className }: KbdProps) {
  const { t } = useTranslation('common');
  const keyClass =
    'inline-flex h-6 min-w-6 items-center justify-center rounded-xs border border-edge border-b-2 bg-surface-2 px-1.5 font-sans text-xs font-medium text-fg-muted';
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

/** Red LIVE pill with a slow pulse dot (pulse only under motion-safe, and only while on screen). */
export function LiveBadge({ className }: { className?: string }) {
  const { t } = useTranslation('common');
  return (
    <Badge variant="live" className={className}>
      <span ref={pauseWhenOffscreen} aria-hidden className="h-1.5 w-1.5 rounded-full bg-white motion-safe:animate-live-pulse" />
      {t('live')}
    </Badge>
  );
}

export interface ProgressBarProps {
  value: number;
  max?: number;
  /** Accessible name. */
  label?: string;
  className?: string;
  /** Unknown progress: animated stripe. */
  indeterminate?: boolean;
  /** `glass`: for bars drawn on glass over artwork or video (C8): a light track and the bright glass accent. */
  tone?: 'accent' | 'success' | 'danger' | 'fg' | 'glass';
  size?: 'xs' | 'sm' | 'md';
}

export function ProgressBar({
  value,
  max = 100,
  label,
  className,
  indeterminate,
  tone = 'accent',
  size = 'sm',
}: ProgressBarProps) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const toneClass = { accent: 'bg-accent', success: 'bg-success', danger: 'bg-danger', fg: 'bg-fg', glass: 'bg-glass-accent' }[tone];
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={indeterminate ? undefined : max}
      aria-valuenow={indeterminate ? undefined : Math.round(Math.min(value, max))}
      className={cn(
        'relative w-full overflow-hidden rounded-full',
        tone === 'glass' ? 'bg-on-glass/20' : 'bg-surface-3',
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
