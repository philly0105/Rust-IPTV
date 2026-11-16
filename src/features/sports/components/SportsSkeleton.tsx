/** Loading state: a section heading and game cards in the page's own shape, so nothing jumps when scores land. */

import { Skeleton, cn } from '../deps';

/**
 * The card grid's columns, shared by the page and this skeleton: as many cards of at least 22rem as
 * the page's width holds (beside the rail, not the window), so a stream row keeps its room.
 */
export const GRID_COLUMNS = 'grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))]';

export function SportsSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="flex flex-col gap-3" data-testid="sports-loading">
      <Skeleton className="h-6 w-40" />
      <div className={cn('grid gap-3', GRID_COLUMNS)}>
        {[0, 1, 2, 3].map((card) => (
          <div key={card} className="flex flex-col gap-1.5 rounded-lg border border-edge p-3.5">
            <Skeleton className="h-4 w-24" />
            {[0, 1].map((team) => (
              <div key={team} className="mt-1 flex items-center gap-3">
                <Skeleton className="size-7 shrink-0 rounded-full" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-5 w-8" />
              </div>
            ))}
            {/* The best stream's row: its logo, name and action. */}
            <div className="mt-2.5 flex items-center gap-3 border-t border-divider pt-3">
              <Skeleton className="size-8 shrink-0 rounded-md" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-8 w-20" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
