import { useTranslation } from 'react-i18next';

import { cn } from './cn';
import { useScaledPx } from './scale';

export interface SkeletonProps {
  className?: string;
}

/** Shimmering placeholder block. Size it with className (e.g. `h-4 w-32`). */
export function Skeleton({ className }: SkeletonProps) {
  return <div aria-hidden className={cn('skeleton-surface rounded-sm motion-safe:animate-shimmer', className)} />;
}

export interface SkeletonListProps {
  rows?: number;
  className?: string;
  /** Show a leading square (logo) per row. Default true. */
  withMedia?: boolean;
}

/** List-row placeholders shaped like channel rows. */
export function SkeletonList({ rows = 8, className, withMedia = true }: SkeletonListProps) {
  const { t } = useTranslation('common');
  return (
    <div role="status" aria-busy="true" className={cn('flex flex-col gap-1', className)}>
      <span className="sr-only">{t('loading')}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-14 items-center gap-3 rounded-md px-3">
          {withMedia && <Skeleton className="h-9 w-9 shrink-0 rounded-sm" />}
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-3.5" />
            <Skeleton className="h-3 w-2/5 opacity-70" />
          </div>
        </div>
      ))}
    </div>
  );
}

export interface SkeletonGridProps {
  count?: number;
  className?: string;
  /** Card aspect (width / height). Default poster 2/3. */
  aspect?: number;
  minColumnWidth?: number;
  /**
   * The VirtualGrid's `captionHeight` (px at 100 %, the gap under the art included): each card's
   * caption takes that height and the rows its 16 px gap, so the rows sit where the grid's will
   * and do not move when the posters arrive. Without it the caption is as tall as its two lines.
   */
  captionHeight?: number;
}

/** Poster-grid placeholders. */
export function SkeletonGrid({ count = 12, className, aspect = 2 / 3, minColumnWidth = 150, captionHeight }: SkeletonGridProps) {
  const { t } = useTranslation('common');
  // Same scale and density as the VirtualGrid it stands in for (its caption holds text, which density does not shrink).
  const column = useScaledPx(minColumnWidth, true);
  const caption = useScaledPx(captionHeight ?? 0);
  const gap = useScaledPx(16, true);
  return (
    <div
      role="status"
      aria-busy="true"
      className={cn('grid gap-4', className)}
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(${column}px, 100%), 1fr))`, ...(captionHeight ? { gap } : {}) }}
    >
      <span className="sr-only">{t('loading')}</span>
      {Array.from({ length: count }, (_, i) =>
        captionHeight ? (
          <div key={i} className="flex flex-col">
            <div aria-hidden className="skeleton-surface w-full rounded-lg motion-safe:animate-shimmer" style={{ aspectRatio: aspect }} />
            <div className="flex flex-col gap-2 pt-2" style={{ height: caption }}>
              <Skeleton className="h-3.5 w-4/5" />
              <Skeleton className="h-3 w-2/5 opacity-70" />
            </div>
          </div>
        ) : (
          <div key={i} className="flex flex-col gap-2">
            <div aria-hidden className="skeleton-surface w-full rounded-lg motion-safe:animate-shimmer" style={{ aspectRatio: aspect }} />
            <Skeleton className="h-3.5 w-4/5" />
            <Skeleton className="h-3 w-2/5 opacity-70" />
          </div>
        ),
      )}
    </div>
  );
}
