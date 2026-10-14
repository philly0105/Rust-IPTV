/** Loading state: the page's own shape (headline, bars, two lists), so nothing jumps when data lands. */

import { Skeleton } from '../deps';

const BAR_HEIGHTS = ['h-[38%]', 'h-[62%]', 'h-[24%]', 'h-[80%]', 'h-[46%]', 'h-[70%]', 'h-[54%]'];

export function StatsSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="flex flex-col gap-8" data-testid="stats-loading">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-[min(26rem,90%)]" />
        <Skeleton className="h-4 w-56" />
      </div>
      <div className="ms-12 flex h-44 items-end gap-1 sm:h-56">
        {BAR_HEIGHTS.map((h) => (
          <div key={h} className="flex h-full flex-1 items-end justify-center">
            <Skeleton className={`w-full max-w-10 rounded-b-none ${h}`} />
          </div>
        ))}
      </div>
      <div className="grid gap-8 md:grid-cols-2">
        {[0, 1].map((col) => (
          <div key={col} className="flex flex-col gap-3 border-t border-divider pt-4">
            <Skeleton className="h-5 w-32" />
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="flex items-center gap-3">
                <Skeleton className="size-10 shrink-0" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
