import { Skeleton } from '@/ui';

/** Placeholder with the hero card's geometry. Shared by the dashboard and the startup redirect, so nothing jumps between them. */
export function HeroSkeleton() {
  return (
    <div className="mx-8 flex items-end gap-8 rounded-lg border border-divider bg-surface p-8" aria-hidden data-testid="hero-skeleton">
      <Skeleton className="hidden aspect-[2/3] w-[150px] rounded-md md:block" />
      <div className="flex flex-1 flex-col gap-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="mt-3 h-12 w-40 rounded-md" />
      </div>
    </div>
  );
}
