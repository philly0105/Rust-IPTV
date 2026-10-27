import { Skeleton, cn } from '@/ui';

/**
 * The hero's outer frame: full-bleed across the content column, straight under the header, on
 * the dark glass (C8 tokens, dark in every theme). Shared with the skeleton so nothing jumps, and
 * so a light theme never loads the hero as a white card that then turns dark (L3-visual-8). No
 * border: the boxed card with a 1px edge read as a widget, not a stage. In the dark themes the
 * stage melts into the page (HERO_PAGE_FADE). The light page is no colour it can fade to, and a
 * full-width dark band with a hard foot was the heaviest thing on it, so there the hero is a
 * rounded card inset by the page gutter with a raised shadow, a picture placed on the page like
 * every other card in the light theme.
 */
export const HERO_FRAME =
  'relative isolate overflow-hidden bg-glass-strong light:mx-(--page-gutter) light:mt-6 light:rounded-xl light:shadow-2';
/**
 * The hero's content box: about two fifths of the window from sm up, capped by the width, so the
 * first rail starts in the top half of a 900 px window rather than at its foot (at half the
 * window a 1440 x 900 Home showed one rail under a stage that was mostly empty colour). The
 * copy sets the height where it needs more. On a phone the copy sets it: at 56vh the hero took
 * 58% of the space between the header and the tab bar, mostly an empty field above the title,
 * and On now started below the first screen. A band of artwork stays above the copy, and room
 * under the buttons for the slide dots (HeroCarousel). From sm to lg the slide controls sit in
 * the top corner, so the copy starts lower; from lg they sit beside the buttons. The copy starts
 * on the page gutter, on the header title's line.
 */
export const HERO_BODY =
  'relative flex min-h-[clamp(16rem,38vh,20rem)] items-end px-(--page-gutter) pt-12 pb-14 sm:min-h-[clamp(18rem,min(40vh,32vw),30rem)] sm:pt-20 sm:pb-12 lg:pt-12';

/**
 * The fade from the hero into the page under it. In the dark themes the stage melts into the
 * page; the light page is no colour the dark stage can fade to, so there the hero is a card (HERO_FRAME).
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
