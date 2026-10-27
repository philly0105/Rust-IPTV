import { CircleCheck, HardDriveDownload, Play } from 'lucide-react';
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import type { Download, Episode, PlaybackPosition, Season } from '@/api/types';

import { useScrollMargin } from '../../hooks/useContainerColumns';
import { useFormatRuntime } from '../../hooks/useFormatRuntime';
import { episodeCode, isResumable, isWatched, progressFraction } from '../../lib/format';
import { handleGridKeyDown } from '../../lib/gridNav';
import { useMediaQuery } from '@/shell/useMediaQuery';
import { IconButton, MetaLine, Poster, PosterCellWidthContext, ProgressBar, Tabs, WatchedChip, cn, useListVirtualizer, usePosterWidthBox, useScaledPx } from '@/ui';
import { DownloadButton } from './actions';

const ROW_H = 112;
/**
 * A phone's row at 100 % scale: the thumbnail, the text and the two actions on one line. The
 * actions on a line of their own under the text made each row 112 px with the space under the
 * thumbnail empty, so about two and a half episodes fit on a screen.
 */
const ROW_H_PHONE = 84;
/** The thumbnail's box, `w-28 sm:w-40`: 28 or 40 spacing steps of 3.75 px at 100 % scale. */
const THUMB_PX = 105;
const THUMB_SM_PX = 150;
/** Tailwind's `sm` breakpoint. */
const SM_QUERY = '(min-width: 40rem)';

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

/** A finished download of the episode whose file is on disk: the row plays it instead of streaming (VL-offline-play). */
export function offlineDownload(d: Download | undefined): Download | undefined {
  return d?.status === 'completed' && d.fileAvailable !== false ? d : undefined;
}

/**
 * Episodes of one season, virtualized. Each row plays on Enter/click (from the downloaded file when
 * there is one); arrows move between rows. A row is one surface: it lights on hover, and its facts
 * (code, runtime, watched or progress, downloaded) read as one line above the title.
 */
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
  // P2-POSTERS-2: the thumbnails' width is known, so they do not read their frames as they mount, a
  // forced layout per row between the rows' DOM writes.
  const sm = useMediaQuery(SM_QUERY);
  const thumbWidth = usePosterWidthBox(useScaledPx(sm ? THUMB_SM_PX : THUMB_PX, true));
  // The phone row holds two lines of title beside the thumbnail, so it grows with the UI scale.
  const phoneRowH = useScaledPx(ROW_H_PHONE);
  const rowH = sm ? ROW_H : phoneRowH;
  const v = useListVirtualizer({
    count: episodes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 6,
    scrollMargin: margin,
  });
  // A window crossing sm (a tablet turned) or a new scale: drop the cached sizes so every row takes the new height.
  const measuredH = useRef(rowH);
  useLayoutEffect(() => {
    if (measuredH.current === rowH) return;
    measuredH.current = rowH;
    v.measure();
  }, [rowH, v]);

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
        const offline = offlineDownload(downloads.get(ep.id));
        return (
          <div
            key={ep.id}
            role="listitem"
            // The divider sits on the square list item; the row inside rounds its hover fill, so the
            // rule never curls into the corners.
            className="absolute start-0 w-full border-b border-divider py-1"
            style={{ top: row.start - margin, height: rowH }}
          >
            {/* One line at every width: thumbnail, text, actions. On a phone the narrower thumbnail and
                a two-line title leave the title room to read (L3-visual-7) with the actions at the
                line's end, so a row is 84 px instead of 112 with an empty strip under the thumbnail. */}
            <div
              className={cn(
                '-mx-2 group flex h-full items-center gap-3 rounded-lg px-2 sm:gap-4',
                'hover:bg-hover motion-safe:transition-colors',
                playing && 'tuning-tick bg-selected ps-3 hover:bg-selected',
              )}
              data-testid="episode-row"
            >
              <button
                type="button"
                data-grid-index={row.index}
                onClick={() => onPlay(ep)}
                aria-label={`${resumable ? t('resume') : t('play')} ${code} ${ep.title}${watched ? `, ${t('watched')}` : ''}${offline ? `, ${t('downloaded')}` : ''}`}
                aria-current={playing ? 'true' : undefined}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-start outline-none focus-visible:ring-2 focus-visible:ring-focus sm:gap-4"
              >
                <div className="relative w-28 shrink-0 sm:w-40" data-testid="episode-thumb">
                  <PosterCellWidthContext.Provider value={thumbWidth}>
                    <Poster src={ep.posterUrl} sourceId={ep.seriesRef.sourceId} alt="" label={ep.title.trim() || code} aspect="wide" rounded="sm">
                      <span
                        aria-hidden
                        className="pointer-events-none absolute inset-0 flex items-center justify-center bg-scrim/0 text-white opacity-0 group-hover:bg-scrim/50 group-hover:opacity-100 motion-safe:transition-opacity"
                      >
                        <Play size={22} className="fill-current" />
                      </span>
                    </Poster>
                  </PosterCellWidthContext.Provider>
                  {/* On the thumbnail the bar is glass, and drawn only (the row says how far). A watched
                      episode shows the watched tick instead, as a poster does. */}
                  {watched ? (
                    <WatchedChip className="pointer-events-none absolute end-1.5 top-1.5" />
                  ) : fraction > 0 ? (
                    <div className="pointer-events-none absolute inset-x-1.5 bottom-1.5">
                      <ProgressBar value={fraction} max={1} size="xs" tone="glass" decorative />
                    </div>
                  ) : null}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  {/* One line of facts, one separator between them; the runtime no longer floats to the
                      far end, where it sat on another line from the actions beside it. */}
                  <MetaLine
                    as="span"
                    className="min-w-0 text-caption text-fg-subtle"
                    items={[
                      <span key="code" className="tabular text-fg-muted">
                        {code}
                      </span>,
                      runtime && (
                        <span key="runtime" className="tabular">
                          {runtime}
                        </span>
                      ),
                      watched && (
                        <span key="watched" className="inline-flex items-center gap-1 text-success" data-testid="episode-watched">
                          <CircleCheck aria-hidden size={12} className="shrink-0" />
                          {t('watched')}
                        </span>
                      ),
                      playing && (
                        <span key="playing" className="text-accent">
                          {t('nowPlaying')}
                        </span>
                      ),
                      !playing && resumable && pos && (
                        <span key="progress" className="tabular">
                          {t('percentWatched', { percent: Math.round(fraction * 100) })}
                        </span>
                      ),
                      offline && (
                        <span key="offline" className="inline-flex items-center gap-1" data-testid="episode-offline">
                          <HardDriveDownload aria-hidden size={12} className="shrink-0" />
                          {t('downloaded')}
                        </span>
                      ),
                    ]}
                  />
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
                  {ep.plot && <p dir="auto" className="line-clamp-2 text-body-sm text-fg-muted text-match-parent max-sm:hidden">{ep.plot}</p>}
                </div>
              </button>
              {hasActions && (
                <div className="flex shrink-0 items-center gap-1 sm:gap-2" data-testid="episode-actions">
                  {/* One press marks the episode, as the hero's round button does for the title: a menu
                      with this one item cost a second press for the only thing in it. The tick is green
                      while watched, and the name says what a press does. */}
                  {onToggleWatched && (
                    <IconButton
                      size="sm"
                      label={t(watched ? 'markEpisodeUnwatched' : 'markEpisodeWatched', { code })}
                      icon={<CircleCheck aria-hidden size={16} className={cn(watched && 'text-success')} />}
                      onClick={() => onToggleWatched(ep)}
                      data-testid="episode-watched-toggle"
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
