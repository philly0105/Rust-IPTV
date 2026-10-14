import { Skeleton, cn } from '@/ui';

/** The hero's outer frame: gutters, radius and edge. Shared with the skeleton so nothing jumps. */
export const HERO_FRAME = 'relative mx-4 overflow-hidden rounded-lg border border-divider bg-surface sm:mx-8';
/** The hero's content box: a fixed minimum height, so slides with and without a plot line up. */
export const HERO_BODY = 'relative flex min-h-[clamp(17rem,30vw,24rem)] items-end gap-8 p-5 sm:p-8';

/** Placeholder with the hero card's geometry. Shared by the dashboard and the startup redirect, so nothing jumps between them. */
export function HeroSkeleton() {
  return (
    <div className={HERO_FRAME} aria-hidden data-testid="hero-skeleton">
      <div className={cn(HERO_BODY)}>
        <Skeleton className="hidden aspect-[2/3] w-[10rem] shrink-0 rounded-md md:block" />
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
