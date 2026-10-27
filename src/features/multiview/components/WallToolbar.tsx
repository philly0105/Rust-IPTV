import { Eraser, Maximize2, Minimize2, Plus, Volume1, Volume2, VolumeX } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { cn, SegmentedControl, Tooltip } from '../deps';
import { layoutFits, LAYOUTS, MAX_TILES } from '../layout';
import { GLASS_BUTTON } from '../styles';
import type { MultiviewLayout } from '../types';
import { LayoutGlyph } from './LayoutGlyph';

/** i18n key of each layout's name. */
export const LAYOUT_LABEL_KEYS: Record<MultiviewLayout, string> = {
  '1x2': 'layout1x2',
  '2x2': 'layout2x2',
  '1+3': 'layout1p3',
};

export interface WallToolbarProps {
  layout: MultiviewLayout;
  count: number;
  /** Slot of the tile with sound, for the layout glyph's tally (-1 when none). */
  soundSlot: number;
  muted: boolean;
  volume: number;
  fullscreen: boolean;
  fullscreenSupported: boolean;
  /** Drawn over the wall in full screen: glass instead of the page surface. */
  overlay: boolean;
  onLayout(l: MultiviewLayout): void;
  onAdd(): void;
  onToggleMute(): void;
  onVolume(v: number): void;
  onToggleFullscreen(): void;
  onClear(): void;
}

const toolButton = (overlay: boolean, extra?: string) =>
  overlay
    ? cn(GLASS_BUTTON, 'h-9 min-w-9 px-2.5 text-sm', extra)
    : cn(
        'inline-flex h-9 min-w-9 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-fg-muted outline-none',
        'hover:bg-hover hover:text-fg active:bg-active focus-visible:ring-2 focus-visible:ring-focus',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
        'motion-safe:transition-colors motion-safe:duration-150',
        extra,
      );

/**
 * The wall's controls: layout, add, the wall's sound, full screen, clear. Wraps onto two
 * rows on narrow screens; labels collapse to icons first.
 */
export function WallToolbar({
  layout,
  count,
  soundSlot,
  muted,
  volume,
  fullscreen,
  fullscreenSupported,
  overlay,
  onLayout,
  onAdd,
  onToggleMute,
  onVolume,
  onToggleFullscreen,
  onClear,
}: WallToolbarProps) {
  const { t } = useTranslation('multiview');
  const volumeId = useId();
  const full = count >= MAX_TILES;
  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const percent = Math.round(volume * 100);

  return (
    <div
      role="toolbar"
      aria-label={t('toolbarLabel')}
      data-testid="multiview-toolbar"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2',
        overlay
          ? 'glass rounded-lg border border-[color:var(--color-glass-border,rgb(255_255_255/0.14))] px-2 py-1.5'
          : 'border-b border-divider bg-surface px-(--page-gutter) py-2',
      )}
    >
      {/* Layout: the kit segmented control, each segment drawn as its monitor wall. A layout that
          cannot hold the tiles stays focusable and hoverable, so its tooltip can say why. On a
          stacked wall (under 42rem, which the stage passes at 45rem with its gutters) every layout
          is the same column of tiles, so the choice waits for a wider window; L still cycles. */}
      <div className="hidden @[45rem]/stage:flex">
        <SegmentedControl<MultiviewLayout>
          size="sm"
          tone={overlay ? 'glass' : 'default'}
          label={t('layoutLabel')}
          value={layout}
          onChange={onLayout}
          options={LAYOUTS.map((l) => ({
            value: l,
            label: t(LAYOUT_LABEL_KEYS[l]),
            content: (
              <>
                <LayoutGlyph layout={l} tally={l === layout && soundSlot >= 0 ? soundSlot : undefined} onGlass={overlay} className="h-4 w-7 shrink-0" />
                {/* Named only where the whole toolbar still fits one row with the names (a 64rem
                    stage); narrower, the glyphs keep their names in tooltips. */}
                <span data-testid="multiview-layout-name" className="hidden @[64rem]/stage:inline">
                  {t(LAYOUT_LABEL_KEYS[l])}
                </span>
              </>
            ),
            disabledReason: layoutFits(l, count) ? undefined : t('layout1x2Disabled'),
            testId: `multiview-layout-${l}`,
          }))}
        />
      </div>

      <button type="button" className={toolButton(overlay)} onClick={onAdd} disabled={full} data-testid="multiview-add">
        <Plus aria-hidden className="size-4" />
        <span>{full ? t('wallFull') : t('addChannel')}</span>
      </button>

      {/* Sound, full screen and clear act on tiles: an empty wall leaves them out. */}
      {count > 0 ? (
        <div className="ms-auto flex items-center gap-1">
          <Tooltip content={muted ? t('unmuteAll') : t('muteAll')} tone={overlay ? 'glass' : 'default'} describe={false}>
            <button
              type="button"
              className={toolButton(overlay, 'px-0')}
              aria-label={muted ? t('unmuteAll') : t('muteAll')}
              aria-pressed={muted}
              onClick={onToggleMute}
              data-testid="multiview-mute"
            >
              <VolumeIcon aria-hidden className="size-4" />
            </button>
          </Tooltip>
          <label htmlFor={volumeId} className="sr-only">
            {t('volume')}
          </label>
          <input
            id={volumeId}
            type="range"
            min={0}
            max={100}
            step={5}
            value={muted ? 0 : percent}
            aria-valuetext={`${muted ? 0 : percent}%`}
            onChange={(e) => onVolume(Number(e.currentTarget.value) / 100)}
            className={cn(
              'h-9 w-20 cursor-pointer rounded-sm outline-none focus-visible:ring-2 sm:w-28',
              overlay
                ? 'accent-[color:var(--color-glass-accent,var(--color-accent,#f5b544))] focus-visible:ring-[color:var(--color-glass-accent,var(--color-focus,#ffc865))]'
                : // A neutral fill: amber marks the sound tally on the layout glyph, not a setting's level.
                  'accent-[color:var(--color-fg-muted,#c8cfdc)] focus-visible:ring-focus',
            )}
            data-testid="multiview-volume"
          />
          <Tooltip content={fullscreenSupported ? (fullscreen ? t('exitFullscreen') : t('fullscreen')) : t('fullscreenUnavailable')} tone={overlay ? 'glass' : 'default'} describe={!fullscreenSupported}>
            <button
              type="button"
              className={toolButton(overlay, 'px-0')}
              aria-label={fullscreen ? t('exitFullscreen') : t('fullscreen')}
              // A disabled button gets no pointer events in every browser, so its reason stays a native title.
              title={fullscreenSupported ? undefined : t('fullscreenUnavailable')}
              aria-pressed={fullscreen}
              disabled={!fullscreenSupported}
              onClick={onToggleFullscreen}
              data-testid="multiview-fullscreen"
            >
              {fullscreen ? <Minimize2 aria-hidden className="size-4" /> : <Maximize2 aria-hidden className="size-4" />}
            </button>
          </Tooltip>
          {!overlay ? (
            <button type="button" className={toolButton(false)} onClick={onClear} data-testid="multiview-clear">
              <Eraser aria-hidden className="size-4" />
              <span className="hidden sm:inline">{t('clearWall')}</span>
              <span className="sr-only sm:hidden">{t('clearWall')}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
