/**
 * Tile chrome over video uses the glass tokens (C8). Each value carries its fallback so the
 * wall reads the same where a theme does not define them yet. Where backdrop-filter is not
 * supported the stronger glass stands alone and keeps the text readable.
 *
 * Glass is dark in every theme, so accents drawn on it (the tally, the lit slot plate, swap
 * targets) use `--color-glass-accent`, the bright dial tone, never the theme's accent, which
 * is a dark brown in the light theme.
 */

/** Frosted panel over video: strips, pills, the error and lock panels. */
export const GLASS =
  'border border-[color:var(--color-glass-border,rgb(255_255_255/0.14))] ' +
  'bg-[color:var(--color-glass-strong,rgb(12_19_32/0.88))] text-[color:var(--color-on-glass,#f4f6fa)] ' +
  'supports-[backdrop-filter:blur(1px)]:bg-[color:var(--color-glass,rgb(12_19_32/0.72))] ' +
  'supports-[backdrop-filter:blur(1px)]:backdrop-blur-[var(--blur-glass,14px)]';

/** Solid glass for small marks that must read over any frame (slot numbers, badges). */
export const GLASS_STRONG =
  'bg-[color:var(--color-glass-strong,rgb(12_19_32/0.88))] text-[color:var(--color-on-glass,#f4f6fa)]';

/** Secondary text on glass. */
export const ON_GLASS_MUTED = 'text-[color:var(--color-on-glass-muted,#c8cfdc)]';

/** The accent on glass as a fill, with its text colour. */
export const GLASS_ACCENT_FILL =
  'bg-[color:var(--color-glass-accent,var(--color-accent,#f5b544))] text-[color:var(--color-glass-accent-fg,var(--color-accent-fg,#1b1204))]';

/** The accent on glass as text or an icon. */
export const GLASS_ACCENT_TEXT = 'text-[color:var(--color-glass-accent,var(--color-accent,#f5b544))]';

/** The accent on glass as a border. */
export const GLASS_ACCENT_BORDER = 'border-[color:var(--color-glass-accent,var(--color-accent,#f5b544))]';

/** Buttons laid on glass: quiet until hovered, with a focus ring that reads over any frame. */
export const GLASS_BUTTON =
  'inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium outline-none ' +
  'text-[color:var(--color-on-glass,#f4f6fa)] hover:bg-[color:var(--color-glass-border,rgb(255_255_255/0.14))] ' +
  'active:bg-[color:var(--color-glass-border,rgb(255_255_255/0.14))] active:ring-1 active:ring-[color:var(--color-glass-border,rgb(255_255_255/0.14))] ' +
  'focus-visible:ring-2 focus-visible:ring-[color:var(--color-glass-accent,var(--color-focus,#ffc865))] ' +
  'motion-safe:transition-colors motion-safe:duration-150 disabled:cursor-not-allowed disabled:opacity-50';
