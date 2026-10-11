import { Star } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { formatRating } from '../lib/format';
import { Poster, ProgressBar, Skeleton, cn } from '../_shim';

export interface PosterCardProps {
  title: string;
  href: string;
  posterUrl?: string;
  year?: number;
  rating?: number;
  /** 0..1 watched fraction; shows a thin bar over the poster when > 0. */
  progress?: number;
  /** Small overlay in the top-left corner (source badge, "New"). */
  badge?: ReactNode;
  /** Secondary line under the title (overrides year). */
  meta?: ReactNode;
  index?: number;
  onClick?: () => void;
  className?: string;
  /** Hold focus by keyboard without being in the tab order (roving). */
  tabIndex?: number;
  /** Keyboard cursor of a listbox grid (aria-activedescendant) rests here. */
  active?: boolean;
}

/**
 * Poster tile used by grids and rails. The poster carries the identity; the
 * caption is quiet. Focus draws the amber ring around the artwork only.
 */
export function PosterCard({
  title,
  href,
  posterUrl,
  year,
  rating,
  progress,
  badge,
  meta,
  index,
  onClick,
  className,
  tabIndex,
  active,
}: PosterCardProps) {
  const r = formatRating(rating);
  return (
    <Link
      to={href}
      onClick={onClick}
      data-grid-index={index}
      tabIndex={tabIndex}
      className={cn('group flex min-w-0 flex-col gap-2 rounded-md outline-none', className)}
      title={title}
    >
      <div
        className={cn(
          'relative overflow-hidden rounded-md shadow-1 ring-1 ring-border/60',
          'group-hover:ring-fg-subtle group-focus-visible:ring-2 group-focus-visible:ring-focus',
          active && 'ring-2 ring-focus',
          'motion-safe:transition-[box-shadow,transform] motion-safe:duration-150 motion-safe:group-hover:-translate-y-0.5',
        )}
      >
        <Poster src={posterUrl} alt="" aspect="poster" />
        {badge && <div className="pointer-events-none absolute top-1.5 left-1.5 flex gap-1">{badge}</div>}
        {r && (
          <div className="tabular pointer-events-none absolute top-1.5 right-1.5 inline-flex items-center gap-1 rounded-sm bg-scrim px-1.5 py-0.5 text-[11px] font-semibold text-white">
            <Star aria-hidden size={11} className="fill-current text-accent" />
            {r}
          </div>
        )}
        {progress !== undefined && progress > 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-scrim/60 px-1.5 pb-1.5 pt-1">
            <ProgressBar value={progress} max={1} />
          </div>
        )}
      </div>
      <div className="min-w-0 px-0.5">
        <div className="line-clamp-2 text-[13px] leading-snug font-medium text-fg group-hover:text-fg">{title}</div>
        <div className="tabular truncate text-xs text-fg-subtle">{meta ?? year ?? ' '}</div>
      </div>
    </Link>
  );
}

/** Placeholder with the same footprint as `PosterCard`. */
export function PosterCardSkeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn('flex min-w-0 flex-col gap-2', className)}>
      <div className="skeleton-surface w-full rounded-md motion-safe:animate-shimmer" style={{ aspectRatio: 2 / 3 }} />
      <Skeleton className="h-3.5 w-4/5" />
      <Skeleton className="h-3 w-2/5 opacity-70" />
    </div>
  );
}
