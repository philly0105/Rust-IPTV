import { CircleCheck, CircleDashed, Play } from 'lucide-react';
import { useRef, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import type { Download, Episode, PlaybackPosition, Season } from '@/api/types';

import { useScrollMargin } from '../../hooks/useContainerColumns';
import { useFormatRuntime } from '../../hooks/useFormatRuntime';
import { episodeCode, isResumable, isWatched, progressFraction } from '../../lib/format';
import { handleGridKeyDown } from '../../lib/gridNav';
import { Menu, Poster, ProgressBar, Tabs, cn, useListVirtualizer } from '@/ui';
import { DownloadButton } from './actions';

const ROW_H = 112;

/** Tab label for a season: provider name when meaningful, else "Season N" / "Specials". */
export function useSeasonLabel(): (s: Pick<Season, 'number' | 'name'>) => string {
  const { t } = useTranslation('vod');
  return (s) => {
    const name = s.name?.trim();
    if (name && !/^season\s*\d+$/i.test(name)) return name;
    return s.number <= 0 ? t('specials') : t('seasonNumber', { number: s.number });
  };
}

export function SeasonTabs({ seasons, value, onChange }: { seasons: Season[]; value: number; onChange: (n: number) => void }) {
  const { t } = useTranslation('vod');
  const label = useSeasonLabel();
  return (
    <Tabs
      label={t('seasons')}
      value={String(value)}
      onChange={(id) => onChange(Number(id))}
      items={seasons.map((s) => ({
        id: String(s.number),
        label: label(s),
        badge: <span className="tabular">{s.episodes.length}</span>,
      }))}
      className="overflow-x-auto scrollbar-none"
    />
  );
}

export interface EpisodeListProps {
  episodes: Episode[];
  positions: Map<string, PlaybackPosition>;
  downloads: Map<string, Download>;
  playingEpisodeId?: string;
  onPlay: (ep: Episode) => void;
  canDownload: boolean;
  pendingDownload: string | null;
  onDownload: (ep: Episode) => void;
  /** Row menu action: mark the episode watched or unwatched. */
  onToggleWatched?: (ep: Episode) => void;
  /** Page scroll container (rows are virtualized against it). */
  scrollRef: RefObject<HTMLElement | null>;
  /** Changes when the list above moves (season switch), so the scroll margin is remeasured. */
  layoutKey?: unknown;
}

/** Episodes of one season, virtualized. Each row plays on Enter/click; arrows move between rows. */
export function EpisodeList({
  episodes,
  positions,
  downloads,
  playingEpisodeId,
  onPlay,
  canDownload,
  pendingDownload,
  onDownload,
  onToggleWatched,
  scrollRef,
  layoutKey,
}: EpisodeListProps) {
  const { t } = useTranslation('vod');
  const formatRuntime = useFormatRuntime();
  const listRef = useRef<HTMLDivElement>(null);
  const margin = useScrollMargin(listRef, scrollRef, [layoutKey, episodes.length]);
  const v = useListVirtualizer({
    count: episodes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 6,
    scrollMargin: margin,
  });

  return (
    <div
      ref={listRef}
      role="list"
      aria-label={t('episodes')}
      onKeyDown={(e) => handleGridKeyDown(e, { count: episodes.length })}
      style={{ height: v.getTotalSize(), position: 'relative' }}
    >
      {v.getVirtualItems().map((row) => {
        const ep = episodes[row.index];
        if (!ep) return null;
        const pos = positions.get(ep.id);
        const fraction = progressFraction(pos);
        const resumable = isResumable(pos);
        const watched = isWatched(pos);
        const playing = ep.id === playingEpisodeId;
        const runtime = formatRuntime(ep.durationSeconds ?? pos?.durationSeconds);
        const code = episodeCode(ep.season, ep.episode);
        const hasActions = !!onToggleWatched || canDownload;
        return (
          <div
            key={ep.id}
            role="listitem"
            className="absolute start-0 w-full"
            style={{ top: row.start - margin, height: ROW_H }}
          >
            {/* Below sm (a phone) the episode takes the row's width and its actions wrap onto a line of
                their own under the text, so the title keeps room to read (L3-visual-7). */}
            <div
              className={cn(
                'group flex h-full flex-wrap content-center items-center gap-x-3 gap-y-1 border-b border-divider py-1.5 sm:flex-nowrap sm:gap-4 sm:py-2',
                playing && 'tuning-tick ps-3',
              )}
              data-testid="episode-row"
            >
              <button
                type="button"
                data-grid-index={row.index}
                onClick={() => onPlay(ep)}
                aria-label={`${resumable ? t('resume') : t('play')} ${code} ${ep.title}${watched ? `, ${t('watched')}` : ''}`}
                aria-current={playing ? 'true' : undefined}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-start outline-none focus-visible:ring-2 focus-visible:ring-focus max-sm:basis-full sm:gap-4"
              >
                <div className="relative w-28 shrink-0 sm:w-40" data-testid="episode-thumb">
                  <Poster src={ep.posterUrl} sourceId={ep.seriesRef.sourceId} alt="" label={ep.title.trim() || code} aspect="wide" rounded="sm">
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-0 flex items-center justify-center bg-scrim/0 text-white opacity-0 group-hover:bg-scrim/50 group-hover:opacity-100 motion-safe:transition-opacity"
                    >
                      <Play size={22} className="fill-current" />
                    </span>
                  </Poster>
                  {fraction > 0 && (
                    <div className="pointer-events-none absolute inset-x-1.5 bottom-1.5">
                      <ProgressBar value={fraction} max={1} size="xs" />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-baseline gap-2 sm:gap-3">
                    <span className="shrink-0 font-display tabular text-sm text-fg-subtle">{code}</span>
                    {watched && (
                      <span className="inline-flex min-w-0 items-center gap-1 self-center text-xs text-success" data-testid="episode-watched">
                        <CircleCheck aria-hidden size={14} className="shrink-0" />
                        <span className="truncate">{t('watched')}</span>
                      </span>
                    )}
                    {playing && <span className="min-w-0 truncate text-xs text-accent">{t('nowPlaying')}</span>}
                    {!playing && resumable && pos && (
                      <span className="tabular min-w-0 truncate text-xs text-fg-subtle">{t('percentWatched', { percent: Math.round(fraction * 100) })}</span>
                    )}
                    {runtime && <span className="tabular ms-auto shrink-0 text-xs text-fg-subtle">{runtime}</span>}
                  </div>
                  {/* Two lines on a phone, where the plot gives way; one beside the plot from sm up. The tooltip
                      carries the whole title wherever it is clamped. */}
                  <div
                    dir="auto"
                    title={ep.title}
                    className="line-clamp-2 text-[calc(15rem/15)] leading-5 font-medium [overflow-wrap:anywhere] text-fg text-match-parent sm:line-clamp-1"
                    data-testid="episode-title"
                  >
                    {ep.title}
                  </div>
                  {ep.plot && <p dir="auto" className="line-clamp-2 text-sm text-fg-muted text-match-parent max-sm:hidden">{ep.plot}</p>}
                </div>
              </button>
              {hasActions && (
                <div className="flex shrink-0 items-center gap-1 max-sm:ms-auto sm:gap-4" data-testid="episode-actions">
                  {onToggleWatched && (
                    <Menu
                      label={t('episodeActions', { code })}
                      items={[
                        {
                          id: 'watched',
                          label: t(watched ? 'markEpisodeUnwatched' : 'markEpisodeWatched', { code }),
                          icon: watched ? <CircleDashed aria-hidden size={16} /> : <CircleCheck aria-hidden size={16} />,
                          onSelect: () => onToggleWatched(ep),
                        },
                      ]}
                    />
                  )}
                  {canDownload && (
                    <DownloadButton
                      compact
                      label={`${code} ${ep.title}`}
                      download={downloads.get(ep.id)}
                      pending={pendingDownload === ep.id}
                      onStart={() => onDownload(ep)}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
