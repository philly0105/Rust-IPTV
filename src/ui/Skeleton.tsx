import { useTranslation } from 'react-i18next';

import { cn } from './cn';

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
}

/** Poster-grid placeholders. */
export function SkeletonGrid({ count = 12, className, aspect = 2 / 3, minColumnWidth = 150 }: SkeletonGridProps) {
  const { t } = useTranslation('common');
  return (
    <div
      role="status"
      aria-busy="true"
      className={cn('grid gap-4', className)}
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${minColumnWidth}px, 1fr))` }}
    >
      <span className="sr-only">{t('loading')}</span>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <div aria-hidden className="skeleton-surface w-full rounded-md motion-safe:animate-shimmer" style={{ aspectRatio: aspect }} />
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3 w-2/5 opacity-70" />
        </div>
      ))}
    </div>
  );
}
