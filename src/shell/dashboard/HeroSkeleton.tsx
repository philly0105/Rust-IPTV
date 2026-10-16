import { Skeleton, cn } from '@/ui';

/**
 * The hero's outer frame: gutters, radius, edge and its dark glass (C8 tokens, dark in every
 * theme). Shared with the skeleton so nothing jumps, and so a light theme no longer loads the
 * hero as a white card that then turns dark (L3-visual-8).
 */
export const HERO_FRAME = 'relative mx-4 overflow-hidden rounded-lg border border-glass-border bg-glass-strong sm:mx-8';
/** The hero's content box: a fixed minimum height, so slides with and without a plot line up. */
export const HERO_BODY = 'relative flex min-h-[clamp(17rem,30vw,24rem)] items-end gap-8 p-5 sm:p-8';

/**
 * The skeleton's placeholders on glass: the surface tokens the skeleton and its shimmer band
 * read, re-pointed at faint tints of the glass text colour for this subtree only.
 */
const ON_GLASS_SKELETON =
  '[--color-surface-2:color-mix(in_srgb,var(--color-on-glass)_9%,transparent)] [--color-surface-3:color-mix(in_srgb,var(--color-on-glass)_16%,transparent)]';

/** Placeholder with the hero card's geometry. Shared by the dashboard and the startup redirect, so nothing jumps between them. */
export function HeroSkeleton() {
  return (
    <div className={cn(HERO_FRAME, ON_GLASS_SKELETON)} aria-hidden data-testid="hero-skeleton">
      <div className={cn(HERO_BODY)}>
        {/* lg, like the slide's poster column: a poster placeholder that vanished at md was a jump. */}
        <Skeleton className="hidden aspect-[2/3] w-[10rem] shrink-0 rounded-md lg:block" />
        <div className="flex flex-1 flex-col gap-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="mt-3 h-12 w-40 rounded-md" />
        </div>
      </div>
    </div>
  );
}
