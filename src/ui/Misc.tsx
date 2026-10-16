import { Children, type ComponentPropsWithRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from './cn';
import { pauseWhenOffscreen } from './offscreen';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

const KEY_LABELS: Record<string, string> = {
  mod: IS_MAC ? '⌘' : 'Ctrl',
  ctrl: 'Ctrl',
  meta: IS_MAC ? '⌘' : 'Win',
  alt: IS_MAC ? '⌥' : 'Alt',
  shift: 'Shift',
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  space: 'Space',
  escape: 'Esc',
  enter: 'Enter',
  digit: '0-9',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  backspace: 'Backspace',
  tab: 'Tab',
  home: 'Home',
  end: 'End',
  delete: 'Del',
  contextmenu: 'Menu',
};

/** Human labels for a combo string like `mod+shift+k`. */
export function comboKeys(combo: string): string[] {
  return combo
    .split('+')
    .filter(Boolean)
    .map((k) => {
      const key = k.trim().toLowerCase();
      return KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key[0]!.toUpperCase() + key.slice(1));
    });
}

export interface KbdProps {
  /** A combo (`mod+k`) rendered as separate keys, or arbitrary children. */
  combo?: string;
  children?: ReactNode;
  className?: string;
}

export function Kbd({ combo, children, className }: KbdProps) {
  const keyClass =
    'inline-flex h-6 min-w-6 items-center justify-center rounded-sm border border-border border-b-2 bg-surface-2 px-1.5 font-mono text-xs text-fg-muted';
  if (combo) {
    const keys = comboKeys(combo);
    return (
      // A plain span cannot carry aria-label (prohibited on the generic role), so the
      // spoken form is visually hidden text and the key caps are hidden from AT.
      <span className={cn('inline-flex items-center gap-1', className)}>
        <span className="sr-only">{keys.join(' + ')}</span>
        {keys.map((k, i) => (
          <kbd key={`${k}-${i}`} className={keyClass} aria-hidden>
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
  accent: 'bg-accent text-accent-fg',
  live: 'bg-live text-bg',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-danger/15 text-danger',
  outline: 'border border-border text-fg-muted',
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
      <span ref={pauseWhenOffscreen} aria-hidden className="h-1.5 w-1.5 rounded-full bg-bg motion-safe:animate-live-pulse" />
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
