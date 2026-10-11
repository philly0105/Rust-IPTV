import { Play, SkipForward, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Episode, PlaybackPosition } from '@/api/types';

import { useFormatRuntime } from '../../hooks/useFormatRuntime';
import { episodeCode, progressFraction } from '../../lib/format';
import { Button, IconButton, Poster, ProgressBar, cn } from '@/ui';

/** How many upcoming episodes the watch-state rail shows. */
export const UP_NEXT_LIMIT = 12;

/** The episodes after `currentId` in play order (capped), for the watch-state rail. */
export function upcoming(order: Episode[], currentId: string | undefined, limit = UP_NEXT_LIMIT): Episode[] {
  const i = currentId ? order.findIndex((e) => e.id === currentId) : -1;
  return order.slice(i + 1, i + 1 + limit);
}

/**
 * Up-next rail docked beside the player (a column at xl, a strip under the
 * player below that). Short by design: the full list stays on the page.
 */
export function UpNextRail({
  episodes,
  positions,
  onPlay,
}: {
  episodes: Episode[];
  positions: Map<string, PlaybackPosition>;
  onPlay: (ep: Episode) => void;
}) {
  const { t } = useTranslation('vod');
  const formatRuntime = useFormatRuntime();
  if (episodes.length === 0) return null;
  return (
    <aside aria-label={t('upNext')} className="flex min-w-0 flex-col gap-2 xl:w-[340px] xl:shrink-0">
      <h2 className="text-sm text-fg-muted">{t('upNext')}</h2>
      <ol className="flex gap-3 overflow-x-auto pb-2 scrollbar-none xl:max-h-[calc(72vh-2rem)] xl:flex-col xl:overflow-x-hidden xl:overflow-y-auto">
        {episodes.map((ep) => {
          const fraction = progressFraction(positions.get(ep.id));
          const runtime = formatRuntime(ep.durationSeconds);
          return (
            <li key={ep.id} className="w-56 shrink-0 xl:w-auto">
              <button
                type="button"
                onClick={() => onPlay(ep)}
                className="group flex w-full items-center gap-3 rounded-md p-1.5 text-start outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus"
              >
                <div className="relative w-28 shrink-0">
                  <Poster src={ep.posterUrl} alt={ep.title} aspect="wide" rounded="sm" />
                  {fraction > 0 && (
                    <div className="pointer-events-none absolute inset-x-1 bottom-1">
                      <ProgressBar value={fraction} max={1} size="xs" />
                    </div>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="font-display tabular text-xs text-fg-subtle">
                    {episodeCode(ep.season, ep.episode)}
                    {runtime && <span className="ms-2">{runtime}</span>}
                  </div>
                  <div dir="auto" className="line-clamp-2 text-sm text-fg text-match-parent">{ep.title}</div>
                </div>
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

export const AUTOPLAY_SECONDS = 8;

/**
 * Shown when an episode ends and a next one exists. Counts down and plays it,
 * unless autoplay is off (then it only offers the button) or the user cancels.
 */
export function NextEpisodeCard({
  next,
  autoplay,
  onPlay,
  onDismiss,
}: {
  next: Episode;
  autoplay: boolean;
  onPlay: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation('vod');
  const [left, setLeft] = useState(AUTOPLAY_SECONDS);
  const play = useRef(onPlay);
  play.current = onPlay;

  useEffect(() => {
    if (!autoplay) return;
    if (left <= 0) {
      play.current();
      return;
    }
    const h = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(h);
  }, [autoplay, left]);

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn('flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-2 px-4 py-3 shadow-1')}
    >
      <SkipForward aria-hidden size={18} className="text-accent" />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-fg-muted">
          {autoplay ? t('nextEpisodeIn', { seconds: left }) : t('nextEpisode')}
        </div>
        <div className="truncate text-[15px] text-fg">
          <span className="font-display tabular me-2 text-fg-subtle">{episodeCode(next.season, next.episode)}</span>
          {next.title}
        </div>
      </div>
      <Button size="sm" variant="primary" icon={<Play aria-hidden size={14} />} onClick={onPlay}>
        {t('playNow')}
      </Button>
      <IconButton size="sm" label={t('cancelAutoplay')} icon={<X aria-hidden size={16} />} onClick={onDismiss} />
    </div>
  );
}
