import { ArrowLeftRight, CircleSlash, LoaderCircle, Lock, Replace, RotateCw, ShieldAlert, TriangleAlert, Volume2, VolumeX, X } from 'lucide-react';
import { memo, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { ParentalMode } from '@/api/types';

import { cn, Tooltip } from '../deps';
import { classifyTileFault, retriesWhenOnline, tileFaultCopy } from '../errors';
import { GLASS, GLASS_ACCENT_BORDER, GLASS_ACCENT_FILL, GLASS_ACCENT_TEXT, GLASS_BLUR, GLASS_BUTTON, GLASS_STRONG, ON_GLASS_MUTED } from '../styles';
import type { MultiviewTile } from '../types';
import { useRetryWhenOnline } from '../useRetryWhenOnline';
import { TILE_START_STAGGER_MS, useTilePlayback } from '../useTilePlayback';
import type { LockGate } from '../useWallData';
import { ChannelMark } from './ChannelMark';

/** Drag payload type: a tile key, only meaningful inside this wall. */
export const TILE_DRAG_TYPE = 'application/x-tsrust-multiview-tile';

export interface TileProps {
  tile: MultiviewTile;
  /** 0-based slot; the number shown (and its key) is slot + 1. */
  slot: number;
  /** This tile holds the wall's sound (the tally). */
  hasSound: boolean;
  /** Sound actually plays: it holds the sound, the wall is not muted, the main player is quiet. */
  audible: boolean;
  volume: number;
  lock: LockGate;
  /** How a locked tile unlocks (copy only). */
  parentalMode: ParentalMode;
  /** The tile's source is gone (removed since the wall was saved). */
  sourceMissing: boolean;
  /** The tile's account has more tiles on the wall than connections. */
  overLimit: boolean;
  /** Programme on air now (guide data). */
  programme?: string | undefined;
  /** Key of the tile being moved, while the wall is in swap mode. */
  swapFrom: string | null;
  className?: string;
  onListen(key: string): void;
  onClose(key: string): void;
  onReplace(key: string): void;
  onSwapStart(key: string): void;
  onSwapTarget(key: string): void;
  onSwapCancel(): void;
  onUnlock(tile: MultiviewTile): void;
  onRecheck(): void;
  onDropTile(from: string, to: string): void;
}

/** A small spinner; its rotation is decoration, so it stops under reduced motion. */
function Spinner({ className }: { className?: string }) {
  return <LoaderCircle aria-hidden className={cn('motion-safe:animate-spin', className)} />;
}

/**
 * A centred glass panel for a tile that is not playing: icon, headline, one line of help, actions.
 *
 * Every slot is 16:9, so the tile's width also sets its height, and the panel grows with
 * the width: in a small tile (the 1+3 side slots, a short window) the icon sits beside the
 * headline and the help is left out; from 20rem the icon stands above the headline; from
 * 26rem the help shows too. Each step fits above the label strip (see `Tile`).
 */
function TilePanel({
  icon,
  title,
  hint,
  children,
  testId,
  role,
  errorClass,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  children: ReactNode;
  testId: string;
  role?: 'alert';
  errorClass?: string;
}) {
  return (
    <div
      role={role}
      data-testid={testId}
      data-error-class={errorClass}
      className={cn(
        GLASS_BLUR,
        'pointer-events-auto flex max-w-[24rem] flex-col items-center gap-1 rounded-md px-3 py-1.5 text-center motion-safe:animate-fade-in',
        '@[20rem]/tile:gap-1.5 @[20rem]/tile:px-4 @[20rem]/tile:py-2.5 @[26rem]/tile:py-3',
      )}
    >
      <div data-testid="multiview-panel-head" className="flex items-center justify-center gap-1.5 @[20rem]/tile:flex-col">
        <span className="flex shrink-0">{icon}</span>
        <p className="line-clamp-2 text-sm font-semibold text-balance">{title}</p>
      </div>
      <p className={cn('hidden text-xs text-pretty @[26rem]/tile:block', ON_GLASS_MUTED)}>{hint}</p>
      <div className="flex flex-wrap items-center justify-center gap-1.5 @[20rem]/tile:mt-1">{children}</div>
    </div>
  );
}

const PANEL_BUTTON = cn(GLASS_BUTTON, 'border border-[color:var(--color-glass-border,rgb(255_255_255/0.14))]');

/**
 * One channel on the wall: its own <video> and engine (useTilePlayback), and the chrome a
 * broadcast multiviewer gives a monitor. The label strip along the bottom (the UMD) names
 * the slot, the channel and what is on; the tile with sound carries the tally, an accent
 * edge, and its slot plate lights up. Tools for the tile sit at the top end and show on
 * hover and focus (always on touch screens).
 *
 * The whole tile is a button that gives it the sound (`data-tile-main`), drawn under the
 * chrome so the tool buttons are its siblings, never nested controls.
 */
export const Tile = memo(function Tile({
  tile,
  slot,
  hasSound,
  audible,
  volume,
  lock,
  parentalMode,
  sourceMissing,
  overLimit,
  programme,
  swapFrom,
  className,
  onListen,
  onClose,
  onReplace,
  onSwapStart,
  onSwapTarget,
  onSwapCancel,
  onUnlock,
  onRecheck,
  onDropTile,
}: TileProps) {
  const { t } = useTranslation(['multiview', 'common']);
  const blocked = lock !== 'open' || sourceMissing;
  const playback = useTilePlayback(tile, { audible, volume, locked: blocked, startDelayMs: slot * TILE_START_STAGGER_MS });
  const { phase, fault, buffering, soundBlocked, videoRef, retry, unblockSound } = playback;
  const [dropTarget, setDropTarget] = useState(false);
  const number = slot + 1;
  const name = tile.title;
  const errorClass = !blocked && phase === 'error' && fault ? classifyTileFault(fault, overLimit) : null;
  useRetryWhenOnline(errorClass !== null && retriesWhenOnline(errorClass), retry);

  const swapping = swapFrom !== null;
  const isSwapSource = swapFrom === tile.key;
  const isSwapTarget = swapping && !isSwapSource;

  const listen = () => {
    // The click is a gesture: sound the browser held back may start now.
    unblockSound();
    onListen(tile.key);
  };

  const onMainClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (isSwapTarget) {
      onSwapTarget(tile.key);
      return;
    }
    if (isSwapSource) {
      onSwapCancel();
      return;
    }
    listen();
    e.currentTarget.focus();
  };

  const onDragStart = (e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData(TILE_DRAG_TYPE, tile.key);
    e.dataTransfer.effectAllowed = 'move';
  };
  const accepts = (e: DragEvent) => e.dataTransfer.types.includes(TILE_DRAG_TYPE);
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!dropTarget) setDropTarget(true);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setDropTarget(false);
    if (!accepts(e)) return;
    e.preventDefault();
    const from = e.dataTransfer.getData(TILE_DRAG_TYPE);
    if (from && from !== tile.key) onDropTile(from, tile.key);
  };

  const mainLabel = isSwapTarget
    ? t('swapHereLabel', { name, slot: number })
    : isSwapSource
      ? t('swapCancel')
      : hasSound
        ? t('hasSound', { name })
        : t('listen', { name });

  // Centre: what the tile is doing when it is not simply playing.
  let centre: ReactNode = null;
  // A panel with actions sits above the label strip, never under it (see the centre layer).
  const panel = sourceMissing || lock === 'locked' || lock === 'error' || errorClass !== null;
  if (sourceMissing) {
    centre = (
      <TilePanel
        testId="multiview-tile-missing"
        role="alert"
        icon={<CircleSlash aria-hidden className="size-5" />}
        title={t('sourceMissingTitle')}
        hint={t('sourceMissing')}
      >
        <button type="button" className={PANEL_BUTTON} onClick={() => onReplace(tile.key)}>
          {t('replace')}
        </button>
        <button type="button" className={GLASS_BUTTON} onClick={() => onClose(tile.key)}>
          {t('common:close')}
        </button>
      </TilePanel>
    );
  } else if (lock === 'locked') {
    centre = (
      <TilePanel
        testId="multiview-tile-locked"
        icon={<Lock aria-hidden className="size-5" />}
        title={t(parentalMode === 'hide' ? 'hiddenTitle' : 'lockedTitle')}
        hint={t(parentalMode === 'hide' ? 'hiddenBody' : 'lockedBody')}
      >
        <button type="button" className={PANEL_BUTTON} onClick={() => onUnlock(tile)}>
          {t('unlock')}
        </button>
        <button type="button" className={GLASS_BUTTON} onClick={() => onClose(tile.key)}>
          {t('common:close')}
        </button>
      </TilePanel>
    );
  } else if (lock === 'error') {
    centre = (
      <TilePanel
        testId="multiview-tile-lock-error"
        role="alert"
        icon={<ShieldAlert aria-hidden className="size-5" />}
        title={t('lockCheckFailedTitle')}
        hint={t('lockCheckFailed')}
      >
        <button type="button" className={PANEL_BUTTON} onClick={onRecheck}>
          <RotateCw aria-hidden className="size-3.5" />
          {t('common:retry')}
        </button>
      </TilePanel>
    );
  } else if (lock === 'pending') {
    centre = (
      <div className={cn(GLASS, 'flex items-center gap-2 rounded-full px-3 py-1.5 text-xs')} role="status">
        <Spinner className="size-4" />
        <span>{t('checkingLock')}</span>
      </div>
    );
  } else if (errorClass) {
    const copy = tileFaultCopy(errorClass);
    centre = (
      <TilePanel
        testId="multiview-tile-error"
        role="alert"
        errorClass={errorClass}
        icon={<TriangleAlert aria-hidden className="size-5 text-[color:var(--color-glass-accent,#f5b544)]" />}
        title={t(copy.title)}
        hint={t(copy.hint)}
      >
        <button type="button" data-testid="multiview-tile-retry" className={PANEL_BUTTON} onClick={retry}>
          <RotateCw aria-hidden className="size-3.5" />
          {t('common:retry')}
        </button>
        <button type="button" className={GLASS_BUTTON} onClick={() => onReplace(tile.key)}>
          {t('replace')}
        </button>
      </TilePanel>
    );
  } else if (phase === 'resolving' || phase === 'loading') {
    centre = (
      <div className="flex flex-col items-center gap-2" role="status" data-testid="multiview-tile-tuning">
        <ChannelMark src={tile.logo} sourceId={tile.ref.sourceId} name={name} className="size-12 rounded-md text-sm @[20rem]/tile:size-16" />
        <span className={cn(GLASS, 'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs')}>
          <Spinner className="size-3.5" />
          {t('tuning')}
        </span>
      </div>
    );
  } else if (buffering) {
    centre = (
      <span className={cn(GLASS, 'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs')} role="status">
        <Spinner className="size-3.5" />
        {t('buffering')}
      </span>
    );
  }

  return (
    <div
      role="group"
      aria-label={t('tileLabel', { slot: number, name })}
      data-testid="multiview-tile"
      data-tile-key={tile.key}
      data-slot={number}
      data-phase={blocked ? 'blocked' : phase}
      data-sound={hasSound ? 'true' : 'false'}
      draggable={!swapping}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={() => setDropTarget(false)}
      onDragEnd={() => setDropTarget(false)}
      onDrop={onDrop}
      className={cn('group/tile @container/tile relative isolate overflow-hidden rounded-sm bg-black', className)}
    >
      <video
        ref={videoRef}
        muted
        playsInline
        disablePictureInPicture
        disableRemotePlayback
        aria-hidden
        tabIndex={-1}
        data-testid="multiview-video"
        className="pointer-events-none absolute inset-0 size-full object-contain"
      />

      {/* The tile itself: click or Enter gives it the sound; in swap mode it is the target. */}
      <button
        type="button"
        data-tile-main=""
        data-slot-focus={slot}
        data-testid="multiview-tile-main"
        aria-pressed={isSwapTarget || isSwapSource ? undefined : hasSound}
        aria-label={mainLabel}
        aria-keyshortcuts={String(number)}
        onClick={onMainClick}
        className={cn(
          'absolute inset-0 cursor-pointer rounded-sm outline-none',
          'focus-visible:shadow-[inset_0_0_0_3px_var(--color-bg,#0c1320),inset_0_0_0_5px_var(--color-focus,#ffc865)]',
        )}
      />

      {/* A panel is centred in the band above the label strip (bottom-2 plus its 2rem, or about
          2.7rem once the programme line shows), so the strip, drawn over everything, never covers
          its buttons; a status pill uses the whole tile. */}
      {centre ? (
        <div
          data-testid="multiview-tile-centre"
          className={cn(
            'pointer-events-none absolute z-10 flex items-center justify-center',
            panel ? cn('inset-x-0 top-0 bottom-11 px-2 pt-2', programme && '@[18rem]/tile:bottom-14') : 'inset-0 p-3',
          )}
        >
          {centre}
        </div>
      ) : null}

      {/* The browser held back sound until the first click or key on the page. */}
      {soundBlocked && phase === 'playing' && !blocked ? (
        <button
          type="button"
          onClick={listen}
          className={cn(GLASS, 'absolute inset-x-0 top-1/2 z-20 mx-auto flex w-max -translate-y-1/2 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-glass-accent,#f5b544)]')}
        >
          <VolumeX aria-hidden className="size-4" />
          {t('soundBlocked')}
        </button>
      ) : null}

      {/* Swap mode: every other tile becomes a target; this one says how to back out. */}
      {isSwapTarget ? (
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-1.5 z-20 flex items-center justify-center rounded-sm border-2 border-dashed bg-[color:var(--color-glass,rgb(12_19_32/0.72))]',
            GLASS_ACCENT_BORDER,
          )}
        >
          <span className="flex items-center gap-1.5 px-2 text-center text-sm font-semibold text-[color:var(--color-on-glass,#f4f6fa)]">
            <ArrowLeftRight className={cn('size-4 shrink-0', GLASS_ACCENT_TEXT)} />
            {t('swapHere')}
          </span>
        </div>
      ) : null}
      {isSwapSource ? (
        <div aria-hidden className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-[color:var(--color-glass,rgb(12_19_32/0.72))]">
          <span className="px-3 text-center text-sm font-semibold text-balance text-[color:var(--color-on-glass,#f4f6fa)]">{t('swapping')}</span>
        </div>
      ) : null}
      {dropTarget ? <div aria-hidden className={cn('pointer-events-none absolute inset-0 z-20 rounded-sm border-2', GLASS_ACCENT_BORDER)} /> : null}

      {/* Tools: top end; shown on hover and focus, always where there is no hover. */}
      <div
        className={cn(
          GLASS_BLUR,
          'absolute end-2 top-2 z-30 flex items-center gap-0.5 rounded-lg p-0.5',
          'opacity-0 group-focus-within/tile:opacity-100 group-hover/tile:opacity-100 [@media(hover:none)]:opacity-100',
          'motion-safe:transition-opacity motion-safe:duration-150',
          swapping && 'hidden',
        )}
      >
        <Tooltip content={hasSound ? t('hasSound', { name }) : t('listen', { name })} tone="glass" describe={false}>
          <button
            type="button"
            className={cn(GLASS_BUTTON, 'px-0', hasSound && GLASS_ACCENT_TEXT)}
            aria-label={hasSound ? t('hasSound', { name }) : t('listen', { name })}
            aria-pressed={hasSound}
            data-testid="multiview-tile-listen"
            onClick={listen}
          >
            {hasSound ? <Volume2 aria-hidden className="size-4" /> : <VolumeX aria-hidden className="size-4" />}
          </button>
        </Tooltip>
        <Tooltip content={t('swapLabel', { name })} shortcut="s" tone="glass" describe={false}>
          <button
            type="button"
            className={cn(GLASS_BUTTON, 'px-0')}
            aria-label={t('swapLabel', { name })}
            aria-keyshortcuts="S"
            data-testid="multiview-tile-swap"
            onClick={() => onSwapStart(tile.key)}
          >
            <ArrowLeftRight aria-hidden className="size-4" />
          </button>
        </Tooltip>
        <Tooltip content={t('replaceLabel', { slot: number, name })} shortcut="r" tone="glass" describe={false}>
          <button
            type="button"
            className={cn(GLASS_BUTTON, 'px-0')}
            aria-label={t('replaceLabel', { slot: number, name })}
            aria-keyshortcuts="R"
            data-testid="multiview-tile-replace"
            onClick={() => onReplace(tile.key)}
          >
            <Replace aria-hidden className="size-4" />
          </button>
        </Tooltip>
        <Tooltip content={t('closeLabel', { name })} shortcut="delete" tone="glass" describe={false}>
          <button
            type="button"
            className={cn(GLASS_BUTTON, 'px-0')}
            aria-label={t('closeLabel', { name })}
            aria-keyshortcuts="Delete"
            data-testid="multiview-tile-close"
            onClick={() => onClose(tile.key)}
          >
            <X aria-hidden className="size-4" />
          </button>
        </Tooltip>
      </div>

      {/* The label strip (UMD): slot plate, logo, name, programme. */}
      <div className="pointer-events-none absolute inset-x-2 bottom-2 z-30 flex min-w-0 justify-start">
        <div data-testid="multiview-tile-strip" className={cn(GLASS, 'flex min-w-0 max-w-full items-center gap-2 rounded-md py-1 ps-1 pe-2.5')}>
          <span
            aria-hidden
            data-testid="multiview-slot-plate"
            className={cn(
              'flex h-6 min-w-6 shrink-0 items-center justify-center gap-1 rounded-sm px-1 font-numeric text-sm font-semibold tabular-nums',
              hasSound ? GLASS_ACCENT_FILL : GLASS_STRONG,
            )}
          >
            {hasSound && audible ? <Volume2 className="size-3.5" /> : null}
            {number}
          </span>
          <ChannelMark src={tile.logo} sourceId={tile.ref.sourceId} name={name} className="hidden size-6 @[14rem]/tile:inline-flex" />
          <span className="flex min-w-0 flex-col leading-tight">
            {/* text-match-parent: with dir="auto" a Latin name in an RTL UI keeps to the parent's start edge. */}
            <span dir="auto" className="truncate text-match-parent text-sm font-medium">
              {tile.number !== undefined ? <span className="me-1.5 font-numeric tabular-nums opacity-80">{tile.number}</span> : null}
              {name}
            </span>
            {programme ? (
              <span dir="auto" className={cn('hidden truncate text-match-parent text-xs @[18rem]/tile:block', ON_GLASS_MUTED)}>
                {programme}
              </span>
            ) : null}
          </span>
        </div>
      </div>

      {/* The tally: an accent edge on the tile with sound. */}
      {hasSound ? (
        <div
          aria-hidden
          data-testid="multiview-tally"
          className="pointer-events-none absolute inset-0 z-40 rounded-sm shadow-[inset_0_0_0_2px_var(--color-glass-accent,var(--color-accent,#f5b544)),inset_0_0_28px_var(--color-glow,rgb(245_181_68/0.28))]"
        />
      ) : null}
    </div>
  );
});
