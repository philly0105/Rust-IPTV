import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { ErrorState, Skeleton, cn } from '@/ui';

import { readRailEmpty, writeRailEmpty } from './railEmpty';

/** Arrow scrolls jump instantly under prefers-reduced-motion, like the CSS animations. */
export function railScrollBehavior(): ScrollBehavior {
  const reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return reduced ? 'auto' : 'smooth';
}

/**
 * Which step buttons a rail shows. `scrollLeft` runs 0..max in LTR and
 * 0..-max in RTL, so `|scrollLeft|` is the distance from the inline start in
 * both directions: Back needs room behind the start, Forward room before the end.
 * The buttons sit at `start-0`/`end-0` and `scrollBy` maps Back/Forward to the
 * inline direction, so no RTL special case belongs here.
 */
export function dashRailButtons(scrollLeft: number, scrollWidth: number, clientWidth: number): { canPrev: boolean; canNext: boolean } {
  const pos = Math.abs(scrollLeft);
  const max = scrollWidth - clientWidth - 2;
  return { canPrev: pos > 2, canNext: pos < max };
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
  /**
   * The rail's own query succeeded. Only then does an empty rail flag itself to skip its
   * skeleton next time; a failed, hidden-error or shared-error rail has no items but
   * proves nothing about emptiness.
   */
  loaded?: boolean;
  /** Next-step hint for `error`, when the rail knows its data is local. */
  errorHint?: string;
  onRetry?: () => void;
  seeAll?: { to: string; label?: string };
  /** Rendered next to the title (counts, badges). */
  meta?: ReactNode;
}

/** One placeholder card: poster or tile at the rail's aspect, plus two text lines. */
function SkeletonCard({ width, aspect }: { width: number; aspect: number }) {
  return (
    <div className="flex shrink-0 flex-col gap-2" style={{ width }}>
      <div className="skeleton-surface w-full rounded-md motion-safe:animate-shimmer" style={{ aspectRatio: aspect }} />
      <Skeleton className="h-3.5 w-4/5" />
      <Skeleton className="h-3 w-1/2 opacity-70" />
    </div>
  );
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
  loaded = false,
  errorHint,
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
  // Whether the track sat at its inline start before the last render.
  const atStartRef = useRef(true);
  const orderKey = items?.map(getKey).join('\u0000') ?? '';

  // Scroll snapping keeps the previously snapped card snapped across layout
  // changes; when the items reorder (e.g. sources ranked once recents load) the
  // first card moves and the browser follows it to the end. A rail that was at
  // its start stays at its start.
  useLayoutEffect(() => {
    const el = trackRef.current;
    if (el && atStartRef.current && el.scrollLeft !== 0) el.scrollLeft = 0;
  }, [orderKey]);

  useEffect(() => {
    if (focusIndex >= count && count > 0) setFocusIndex(count - 1);
  }, [count, focusIndex]);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const measure = () => {
      const edges = dashRailButtons(el.scrollLeft, el.scrollWidth, el.clientWidth);
      atStartRef.current = !edges.canPrev;
      setCanPrev(edges.canPrev);
      setCanNext(edges.canNext);
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

  // A rail that came back empty last time skips its skeleton (it would most likely
  // just collapse again), so slow empty favorites don't flash and shift the page.
  const [wasEmpty] = useState(() => readRailEmpty(id));
  useEffect(() => {
    if (count > 0) writeRailEmpty(id, false);
    else if (loaded) writeRailEmpty(id, true);
  }, [id, loaded, count]);

  if (!error && count === 0 && (!loading || wasEmpty)) return null;

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
          <Link to={seeAll.to} className="shrink-0 rounded-sm text-sm font-medium text-fg-muted hover:text-accent active:text-accent-pressed">
            {seeAll.label ?? t('seeAll')}
          </Link>
        )}
      </div>

      {error ? (
        // One grid cell holds an invisible skeleton card and the error, so the error box is
        // at least as tall as the skeleton it replaces; the row layout keeps it from being taller.
        <div className="mx-8 grid rounded-lg border border-divider bg-surface" data-testid="dashboard-rail-error">
          {/* -my-px: the box's 1px border plus this cell equal the bare skeleton row. */}
          <div aria-hidden className="invisible col-start-1 row-start-1 -my-px" data-rail-error-spacer="">
            <SkeletonCard width={cardWidth} aspect={skeletonAspect} />
          </div>
          <ErrorState
            error={error}
            hint={errorHint}
            onRetry={onRetry}
            size="inline"
            className="col-start-1 row-start-1 flex-row flex-wrap justify-start gap-x-4 gap-y-2 px-5 py-4 text-start sm:flex-nowrap"
          />
        </div>
      ) : loading && count === 0 ? (
        <div className="flex gap-4 overflow-hidden px-8" aria-busy="true" aria-label={t('loadingRail', { title })}>
          {Array.from({ length: 8 }, (_, i) => (
            <SkeletonCard key={i} width={cardWidth} aspect={skeletonAspect} />
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
                'absolute top-0 bottom-3 start-0 hidden w-12 items-center justify-center bg-gradient-to-r rtl:bg-gradient-to-l from-bg to-transparent text-fg active:text-accent-pressed motion-safe:active:translate-x-px',
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
                'absolute top-0 end-0 bottom-3 hidden w-12 items-center justify-center bg-gradient-to-l rtl:bg-gradient-to-r from-bg to-transparent text-fg active:text-accent-pressed motion-safe:active:-translate-x-px',
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
