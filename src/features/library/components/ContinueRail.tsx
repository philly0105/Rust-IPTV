/** Continue-watching rail from `positions.continueWatching`. */

import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { PlaybackPosition } from '@/api/types';

import { IconButton, Poster, ProgressBar } from '../deps';
import { formatClock } from '../lib/format';
import { watchedFraction } from '../lib/recent';

/** Moves focus to the neighbouring card (next, else previous) so it is not lost when this one goes away. */
function focusNeighbour(from: HTMLElement): void {
  const li = from.closest('li');
  const next = (li?.nextElementSibling ?? li?.previousElementSibling)?.querySelector<HTMLElement>('[data-continue-open]');
  next?.focus();
}

export const CONTINUE_RAIL_HEIGHT = 300;

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
  return (
    <section aria-labelledby="continue-heading" className="flex flex-col gap-3 pb-4" style={{ height: CONTINUE_RAIL_HEIGHT }}>
      <h2 id="continue-heading" className="font-display text-[15px] font-semibold text-fg">
        {t('continueWatching')}
      </h2>
      <ul className="-mx-1 flex min-h-0 flex-1 snap-x gap-4 overflow-x-auto px-1 pb-2" data-testid="continue-rail">
        {positions.map((p) => {
          const title = p.snapshot?.title ?? p.ref.itemId;
          const fraction = watchedFraction(p);
          const left = p.durationSeconds ? Math.max(0, p.durationSeconds - p.positionSeconds) : undefined;
          return (
            <li key={`${p.ref.sourceId}|${p.ref.contentType}|${p.ref.itemId}|${p.episodeId ?? ''}`} className="group relative w-32 shrink-0 snap-start">
              <button
                type="button"
                onClick={() => onOpen(p)}
                onKeyDown={(e) => {
                  if (e.key !== 'Delete') return;
                  e.preventDefault();
                  focusNeighbour(e.currentTarget);
                  onRemove(p);
                }}
                data-continue-open=""
                className="flex w-full flex-col gap-2 rounded-lg text-start"
                aria-label={t('continueTitle', { title, time: formatClock(p.positionSeconds) })}
              >
                <div className="overflow-hidden rounded-lg ring-1 ring-border group-hover:ring-accent/60">
                  <Poster src={p.snapshot?.posterUrl} alt="" label={title} aspect="poster" />
                </div>
                {fraction !== undefined && <ProgressBar value={fraction * 100} max={100} size="xs" label={t('watchedPercent', { percent: Math.round(fraction * 100) })} />}
                <span className="flex flex-col">
                  <span className="truncate text-[13px] font-medium text-fg">{title}</span>
                  <span className="truncate text-xs text-fg-muted">
                    {p.snapshot?.subtitle ?? (left !== undefined ? t('minutesLeft', { count: Math.max(1, Math.round(left / 60)) }) : formatClock(p.positionSeconds))}
                  </span>
                </span>
              </button>
              <IconButton
                size="sm"
                variant="secondary"
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
