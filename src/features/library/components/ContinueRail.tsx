/** Continue-watching rail from `positions.continueWatching`. */

import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { PlaybackPosition } from '@/api/types';
import { snapshotTitle } from '@/lib/title';

import { CARD_ART, CARD_ROOT } from '@/ui/card';
import { cn } from '@/ui/cn';

import { IconButton, Poster, ProgressBar, useEdgeFades } from '../deps';
import { formatClock } from '../lib/format';
import { watchedFraction } from '../lib/recent';

/** Moves focus to the neighbouring card (next, else previous) so it is not lost when this one goes away. */
function focusNeighbour(from: HTMLElement): void {
  const li = from.closest('li');
  const next = (li?.nextElementSibling ?? li?.previousElementSibling)?.querySelector<HTMLElement>('[data-continue-open]');
  next?.focus();
}

/**
 * Arrow keys walk the rail in reading order (mirrored in RTL); Home and End
 * jump to its ends. `selector` picks the rail's cards. Returns false for keys
 * it does not handle.
 */
export function moveInRail(from: HTMLElement, key: string, selector = '[data-continue-open]'): boolean {
  const cards = [...(from.closest('ul')?.querySelectorAll<HTMLElement>(selector) ?? [])];
  const at = cards.indexOf(from);
  if (at < 0) return false;
  const rtl = getComputedStyle(from).direction === 'rtl';
  let to: number;
  if (key === 'Home') to = 0;
  else if (key === 'End') to = cards.length - 1;
  else if (key === 'ArrowRight') to = at + (rtl ? -1 : 1);
  else if (key === 'ArrowLeft') to = at + (rtl ? 1 : -1);
  else return false;
  const target = cards[Math.max(0, Math.min(cards.length - 1, to))];
  target?.focus();
  target?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  return true;
}

/** The rail's height before VirtualRows measures it (150 px posters, two caption lines, the heading). */
export const CONTINUE_RAIL_HEIGHT = 340;

export function ContinueRail({
  positions,
  onOpen,
  onRemove,
}: {
  positions: readonly PlaybackPosition[];
  onOpen: (p: PlaybackPosition) => void;
  onRemove: (p: PlaybackPosition) => void;
}) {
  const { t } = useTranslation('library');
  // The rail is cut by the list's reading width: the hidden end fades out, as the VOD rails and
  // the cast row do, instead of clipping a poster hard at the edge.
  const fades = useEdgeFades(String(positions.length));
  return (
    // pb-2: with the day heading's own top space, the gap above it matches the one between day groups.
    <section aria-labelledby="continue-heading" className="flex flex-col gap-3 px-2 pb-2">
      <h2 id="continue-heading" className="text-title-sm text-fg">
        {t('continueWatching')}
      </h2>
      {/* scroll-px-1 matches px-1: snap-start then aligns the first card with the heading, not the padding edge. */}
      <ul
        ref={fades.ref}
        style={fades.style}
        className="-mx-1 flex min-h-0 flex-1 snap-x scroll-px-1 gap-4 overflow-x-auto px-1 pb-2 scrollbar-none"
        data-testid="continue-rail"
      >
        {positions.map((p) => {
          // Older snapshots hold the provider's raw name ("EN - Heat (1995)"); show what the VOD cards show.
          const title = p.snapshot?.title ? snapshotTitle(p.ref, p.snapshot.title).title : p.ref.itemId;
          const fraction = watchedFraction(p);
          const left = p.durationSeconds ? Math.max(0, p.durationSeconds - p.positionSeconds) : undefined;
          return (
            // The VOD rails' card at the medium cover size (150 px at 100 %), in rem so it follows the UI scale.
            <li key={`${p.ref.sourceId}|${p.ref.contentType}|${p.ref.itemId}|${p.episodeId ?? ''}`} className="group relative w-[10rem] shrink-0 snap-start max-sm:w-[7.2rem]">
              <button
                type="button"
                onClick={() => onOpen(p)}
                onKeyDown={(e) => {
                  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
                  if (moveInRail(e.currentTarget, e.key)) {
                    e.preventDefault();
                    return;
                  }
                  if (e.key !== 'Delete') return;
                  e.preventDefault();
                  focusNeighbour(e.currentTarget);
                  onRemove(p);
                }}
                data-continue-open=""
                className={cn(CARD_ROOT, 'flex w-full flex-col gap-2 text-start')}
                aria-label={t('continueTitle', { title, time: formatClock(p.positionSeconds) })}
              >
                <div className={cn(CARD_ART, 'relative')}>
                  <Poster src={p.snapshot?.posterUrl} sourceId={p.ref.sourceId} alt="" label={title} aspect="poster" />
                  {/* On the artwork, as the VOD rails draw it: a glass track along the bottom edge. */}
                  {fraction !== undefined && (
                    <ProgressBar
                      value={fraction * 100}
                      max={100}
                      size="xs"
                      tone="glass"
                      className="absolute inset-x-2 bottom-2 w-auto"
                      label={t('watchedPercent', { percent: Math.round(fraction * 100) })}
                    />
                  )}
                </div>
                {/* dir="auto": a Latin title in an RTL UI truncates at its end and keeps its brackets (cards.tsx). */}
                <span className="flex flex-col">
                  <span dir="auto" className="truncate text-match-parent text-body-sm font-medium text-fg" title={title}>
                    {title}
                  </span>
                  <span dir="auto" className="truncate text-match-parent text-caption text-fg-muted">
                    {p.snapshot?.subtitle ?? (left !== undefined ? t('minutesLeft', { count: Math.max(1, Math.round(left / 60)) }) : formatClock(p.positionSeconds))}
                  </span>
                </span>
              </button>
              <IconButton
                size="sm"
                variant="secondary"
                tooltipTone="glass"
                label={t('removeContinue', { title })}
                icon={<X size={14} aria-hidden />}
                onClick={(e) => {
                  focusNeighbour(e.currentTarget);
                  onRemove(p);
                }}
                className="absolute end-1.5 top-1.5 h-7 w-7 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
