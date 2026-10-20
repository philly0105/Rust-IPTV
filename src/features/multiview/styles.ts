/**
 * Tile chrome over video uses the glass tokens (C8) through their utilities (bg-glass-strong,
 * text-on-glass, border-glass-border, the glass accent); every theme defines them in tokens.css.
 *
 * Run 3 C5: a backdrop filter re-samples the playing video under it on every frame, four times
 * over on a full wall, so chrome that stays on screen (the label strip, status pills) is solid
 * glass with no blur. Only the panels that come and go (the tools on hover, the error and lock
 * panels) blur, through the shared `.glass-blur` utility.
 *
 * Glass is dark in every theme, so accents drawn on it (the tally, the lit slot plate, swap
 * targets) use `--color-glass-accent`, the bright dial tone, never the theme's accent, which
 * is a dark brown in the light theme.
 */

/** Glass panel over video that stays on screen: strips and pills. Solid, no blur. */
export const GLASS = 'border border-glass-border bg-glass-strong text-on-glass';

/**
 * Frosted panel for short-lived chrome over video: the hover tools, the error and lock panels.
 * On-glass text passes contrast on the glass tint without the blur too (no backdrop-filter
 * support), and under reduced transparency `.glass-blur` turns the tint strong.
 */
export const GLASS_BLUR = 'border border-glass-border bg-glass text-on-glass glass-blur';

/** Solid glass for small marks that must read over any frame (slot numbers, badges). */
export const GLASS_STRONG = 'bg-glass-strong text-on-glass';

/** Secondary text on glass. */
export const ON_GLASS_MUTED = 'text-on-glass-muted';

/** The accent on glass as a fill, with its text colour. */
export const GLASS_ACCENT_FILL = 'bg-glass-accent text-glass-accent-fg';

/** The accent on glass as text or an icon. */
export const GLASS_ACCENT_TEXT = 'text-glass-accent';

/** The accent on glass as a border. */
export const GLASS_ACCENT_BORDER = 'border-glass-accent';

/** Buttons laid on glass: quiet until hovered, with a focus ring that reads over any frame. */
export const GLASS_BUTTON =
  'inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium outline-none ' +
  'text-on-glass hover:bg-glass-border active:bg-glass-border active:ring-1 active:ring-glass-border ' +
  'focus-visible:ring-2 focus-visible:ring-glass-accent ' +
  'motion-safe:transition-colors motion-safe:duration-150 disabled:cursor-not-allowed disabled:opacity-50';
