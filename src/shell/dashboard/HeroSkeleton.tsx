import { Skeleton, cn } from '@/ui';

/**
 * The hero's outer frame: full-bleed across the content column, straight under the header, on
 * the dark glass (C8 tokens, dark in every theme). Shared with the skeleton so nothing jumps, and
 * so a light theme never loads the hero as a white card that then turns dark (L3-visual-8). No
 * border and no inset: the boxed card with a 1px edge read as a widget, not a stage.
 */
export const HERO_FRAME = 'relative isolate overflow-hidden bg-glass-strong';
/**
 * The hero's content box. Tall enough to be the page's opening shot (about half the window),
 * capped by the width so a short, wide window still shows the rails under it; taller on phones,
 * where the artwork takes the top and the copy the bottom. The copy starts on the page gutter,
 * on the header title's line.
 */
export const HERO_BODY =
  'relative flex min-h-[clamp(26rem,70vh,34rem)] items-end px-(--page-gutter) pt-20 pb-8 sm:min-h-[clamp(22rem,min(56vh,44vw),38rem)] sm:pb-12';

/**
 * The fade from the hero into the page under it. In the dark themes the stage melts into the
 * page; the light page is no colour the dark stage can fade to, so there it simply ends.
 */
export const HERO_PAGE_FADE = 'pointer-events-none absolute inset-x-0 bottom-0 z-[2] hidden h-24 bg-gradient-to-t from-bg to-transparent dark:block';

/**
 * The skeleton's placeholders on glass: the surface tokens the skeleton and its shimmer band
 * read, re-pointed at faint tints of the glass text colour for this subtree only.
 */
const ON_GLASS_SKELETON =
  '[--color-surface-2:color-mix(in_srgb,var(--color-on-glass)_9%,transparent)] [--color-surface-3:color-mix(in_srgb,var(--color-on-glass)_16%,transparent)]';

/** Placeholder with the hero's geometry. Shared by the dashboard's loading states, so nothing jumps between them. */
export function HeroSkeleton() {
  return (
    <div className={cn(HERO_FRAME, ON_GLASS_SKELETON)} aria-hidden data-testid="hero-skeleton">
      <div className={HERO_BODY}>
        <div className="flex w-full max-w-[36rem] flex-col gap-3">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-12 w-4/5" />
          <Skeleton className="h-4 w-1/2" />
          <div className="mt-3 flex gap-3">
            <Skeleton className="h-12 w-36 rounded-md" />
            <Skeleton className="h-12 w-12 rounded-md sm:w-32" />
          </div>
        </div>
      </div>
      <div className={HERO_PAGE_FADE} />
    </div>
  );
}
