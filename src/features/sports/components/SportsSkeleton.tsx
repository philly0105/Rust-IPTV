/** Loading state: a section heading and game cards in the page's own shape, so nothing jumps when scores land. */

import { Skeleton } from '../deps';

export function SportsSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="flex flex-col gap-3" data-testid="sports-loading">
      <Skeleton className="h-6 w-40" />
      <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
        {[0, 1, 2, 3].map((card) => (
          <div key={card} className="flex flex-col gap-3 rounded-lg border border-edge p-4">
            <Skeleton className="h-4 w-24" />
            {[0, 1].map((team) => (
              <div key={team} className="flex items-center gap-3">
                <Skeleton className="size-8 shrink-0 rounded-full" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-5 w-8" />
              </div>
            ))}
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  );
}
