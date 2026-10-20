import { cn } from '../cn';

/**
 * Buttons laid over the picture (the error overlay and the mpv error strip, Up next, the external
 * player's stage, the sleep prompt): the kit Button's shapes on glass, which stays dark in every
 * theme. `primary` is the solid accent (the light theme's bright glass accent inside the player,
 * player.css), one per surface; `secondary` a see-through fill with a hairline; `ghost` text only.
 * The state layers are white ones: inside `.player-chrome` and glass `--color-white` is the glass
 * text colour (player.css). Under a coarse pointer every size grows to the 44 px touch floor.
 */
export type GlassButtonVariant = 'primary' | 'secondary' | 'ghost';
/** `xs` for the mini player and the strips, `sm` for a short player, `md` everywhere else. */
export type GlassButtonSize = 'xs' | 'sm' | 'md';

const BASE =
  'inline-flex shrink-0 items-center justify-center rounded-md font-medium whitespace-nowrap select-none ' +
  'disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-progress aria-disabled:opacity-70 ' +
  'motion-safe:transition-colors motion-safe:duration-(--duration-fast) pointer-coarse:min-h-[calc(44rem/15)]';

export const GLASS_BUTTON_VARIANTS: Record<GlassButtonVariant, string> = {
  primary: 'bg-accent-solid text-accent-solid-fg hover:bg-accent-solid-hover active:bg-accent-solid-pressed',
  secondary: 'bg-white/10 text-on-glass ring-1 ring-white/20 ring-inset hover:bg-white/16 active:bg-white/22',
  ghost: 'text-on-glass-muted hover:bg-white/10 hover:text-on-glass active:bg-white/16',
};

const SIZES: Record<GlassButtonSize, string> = {
  xs: 'h-7 gap-1.5 px-2.5 text-caption [&_svg]:size-3.5',
  sm: 'h-8 gap-1.5 px-3 text-body-sm [&_svg]:size-4',
  md: 'h-10 gap-2 px-4 text-body-sm [&_svg]:size-4',
};

export function glassButton(variant: GlassButtonVariant, size: GlassButtonSize = 'md', className?: string): string {
  return cn(BASE, GLASS_BUTTON_VARIANTS[variant], SIZES[size], className);
}
