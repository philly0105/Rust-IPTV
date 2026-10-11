import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { ErrorState, Skeleton, cn } from '@/ui';

/** Arrow scrolls jump instantly under prefers-reduced-motion, like the CSS animations. */
export function railScrollBehavior(): ScrollBehavior {
  const reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return reduced ? 'auto' : 'smooth';
}

export interface RailCardProps {
  tabIndex: number;
  'data-rail-card': '';
}

export interface DashboardRailProps<T> {
  id: string;
  title: string;
  items: readonly T[] | undefined;
  getKey: (item: T) => string;
  renderCard: (item: T, props: RailCardProps) => ReactNode;
  /** Card width in px (the rail scrolls horizontally). */
  cardWidth: number;
  /** Placeholder card aspect while loading (width / height). */
  skeletonAspect: number;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  seeAll?: { to: string; label?: string };
  /** Rendered next to the title (counts, badges). */
  meta?: ReactNode;
}

/** Moves focus to the card at `index` in the rail before/after `from` (ArrowUp/Down between rails). */
function focusAdjacentRail(from: HTMLElement, dir: 1 | -1, index: number): boolean {
  const rails = Array.from(document.querySelectorAll<HTMLElement>('[data-dash-rail]'));
  const i = rails.indexOf(from);
  for (let j = i + dir; j >= 0 && j < rails.length; j += dir) {
    const cards = rails[j]!.querySelectorAll<HTMLElement>('[data-rail-card]');
    if (cards.length === 0) continue;
    cards[Math.min(index, cards.length - 1)]!.focus();
    return true;
  }
  return false;
}

/**
 * Horizontal, snap-scrolling rail of cards. One tab stop per rail (roving
 * tabindex); ArrowLeft/Right/Home/End move within it, ArrowUp/Down jump to
 * the same position in the neighbouring rail. Empty rails render nothing.
 */
export function DashboardRail<T>({
  id,
  title,
  items,
  getKey,
  renderCard,
  cardWidth,
  skeletonAspect,
  loading,
  error,
  onRetry,
  seeAll,
  meta,
}: DashboardRailProps<T>) {
  const { t } = useTranslation('shell');
  const sectionRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLUListElement>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);
  const count = items?.length ?? 0;

  useEffect(() => {
    if (focusIndex >= count && count > 0) setFocusIndex(count - 1);
  }, [count, focusIndex]);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const measure = () => {
      const rtl = getComputedStyle(el).direction === 'rtl';
      const pos = Math.abs(el.scrollLeft);
      const max = el.scrollWidth - el.clientWidth - 2;
      setCanPrev(rtl ? pos < max && max > 0 : pos > 2);
      setCanNext(rtl ? pos > 2 : pos < max);
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      ro?.disconnect();
    };
  }, [count]);

  if (!loading && !error && count === 0) return null;

  const scrollBy = (dir: 1 | -1) => {
    const el = trackRef.current;
    if (!el) return;
    const rtl = getComputedStyle(el).direction === 'rtl';
    el.scrollBy({ left: dir * (rtl ? -1 : 1) * el.clientWidth * 0.85, behavior: railScrollBehavior() });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const cards = Array.from(trackRef.current?.querySelectorAll<HTMLElement>('[data-rail-card]') ?? []);
    const cur = cards.indexOf(document.activeElement as HTMLElement);
    if (cur < 0) return;
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    let next = -1;
    switch (e.key) {
      case 'ArrowRight':
        next = rtl ? cur - 1 : cur + 1;
        break;
      case 'ArrowLeft':
        next = rtl ? cur + 1 : cur - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = cards.length - 1;
        break;
      case 'ArrowDown':
      case 'ArrowUp':
        if (sectionRef.current && focusAdjacentRail(sectionRef.current, e.key === 'ArrowDown' ? 1 : -1, cur)) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    const target = cards[Math.max(0, Math.min(cards.length - 1, next))];
    target?.focus();
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  const headingId = `rail-${id}-title`;

  return (
    <section
      ref={sectionRef}
      aria-labelledby={headingId}
      data-dash-rail={id}
      data-testid={`dashboard-rail-${id}`}
      className="group/rail relative flex flex-col gap-3"
    >
      <div className="flex items-baseline justify-between gap-4 px-8">
        <div className="flex min-w-0 items-baseline gap-3">
          <h2 id={headingId} className="truncate text-lg">
            {title}
          </h2>
          {meta}
        </div>
        {seeAll && (
          <Link to={seeAll.to} className="shrink-0 rounded-sm text-sm font-medium text-fg-muted hover:text-accent">
            {seeAll.label ?? t('seeAll')}
          </Link>
        )}
      </div>

      {error ? (
        <div className="mx-8 rounded-lg border border-border bg-surface">
          <ErrorState error={error} onRetry={onRetry} size="inline" />
        </div>
      ) : loading && count === 0 ? (
        <div className="flex gap-4 overflow-hidden px-8" aria-busy="true" aria-label={t('loadingRail', { title })}>
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="flex shrink-0 flex-col gap-2" style={{ width: cardWidth }}>
              <div
                className="skeleton-surface w-full rounded-md motion-safe:animate-shimmer"
                style={{ aspectRatio: skeletonAspect }}
              />
              <Skeleton className="h-3.5 w-4/5" />
              <Skeleton className="h-3 w-1/2 opacity-70" />
            </div>
          ))}
        </div>
      ) : (
        <div className="relative">
          <ul
            ref={trackRef}
            onKeyDown={onKeyDown}
            onFocus={(e) => {
              const cards = Array.from(trackRef.current?.querySelectorAll<HTMLElement>('[data-rail-card]') ?? []);
              const i = cards.indexOf(e.target as HTMLElement);
              if (i >= 0 && i !== focusIndex) setFocusIndex(i);
            }}
            aria-labelledby={headingId}
            className="flex snap-x snap-mandatory scroll-px-8 gap-4 overflow-x-auto overflow-y-visible px-8 pt-1 pb-3 scrollbar-none motion-safe:scroll-smooth"
          >
            {items!.map((item, i) => (
              <li key={getKey(item)} className="shrink-0 snap-start" style={{ width: cardWidth }}>
                {renderCard(item, { tabIndex: i === focusIndex ? 0 : -1, 'data-rail-card': '' })}
              </li>
            ))}
          </ul>
          {canPrev && (
            <button
              type="button"
              tabIndex={-1}
              aria-label={t('scrollBack')}
              onClick={() => scrollBy(-1)}
              className={cn(
                'absolute top-0 bottom-3 left-0 hidden w-12 items-center justify-center bg-gradient-to-r from-bg to-transparent text-fg',
                'opacity-0 group-hover/rail:opacity-100 motion-safe:transition-opacity [@media(hover:hover)]:flex',
              )}
            >
              <ChevronLeft aria-hidden size={28} className="rtl:rotate-180" />
            </button>
          )}
          {canNext && (
            <button
              type="button"
              tabIndex={-1}
              aria-label={t('scrollForward')}
              onClick={() => scrollBy(1)}
              className={cn(
                'absolute top-0 right-0 bottom-3 hidden w-12 items-center justify-center bg-gradient-to-l from-bg to-transparent text-fg',
                'opacity-0 group-hover/rail:opacity-100 motion-safe:transition-opacity [@media(hover:hover)]:flex',
              )}
            >
              <ChevronRight aria-hidden size={28} className="rtl:rotate-180" />
            </button>
          )}
        </div>
      )}
    </section>
  );
}
