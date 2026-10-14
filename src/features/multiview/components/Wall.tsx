import { Plus } from 'lucide-react';
import { forwardRef, memo, type KeyboardEventHandler } from 'react';
import { useTranslation } from 'react-i18next';

import { itemKey, type ItemKey, type ParentalMode } from '@/api/types';

import { cn } from '../deps';
import { capacityOf, slotClass, WALL_CLASSES } from '../layout';
import type { MultiviewLayout, MultiviewTile } from '../types';
import { useTileLock } from '../useWallData';
import { Tile, type TileProps } from './Tile';

type TileHandlers = Pick<
  TileProps,
  'onListen' | 'onClose' | 'onReplace' | 'onSwapStart' | 'onSwapTarget' | 'onSwapCancel' | 'onUnlock' | 'onDropTile'
>;

export interface WallProps extends TileHandlers {
  tiles: readonly MultiviewTile[];
  layout: MultiviewLayout;
  audioKey: string | null;
  /** Every tile silent (the wall's mute, or the main player is playing). */
  silent: boolean;
  volume: number;
  /** Parental controls on and locked: tiles ask `parental.check` first (undefined = not known yet). */
  parentalActive: boolean | undefined;
  parentalMode: ParentalMode;
  /** Source ids whose tiles outnumber the account's connections. */
  overLimitSources: ReadonlySet<string>;
  /** Source ids no longer in the sources list (removed since the wall was saved). */
  missingSources: ReadonlySet<string>;
  programmes: ReadonlyMap<ItemKey, string>;
  swapFrom: string | null;
  onAdd(slot: number): void;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
}

type LockedTileProps = Omit<TileProps, 'lock' | 'onRecheck'> & { parentalActive: boolean | undefined };

/** A tile with its parental lock asked on its own, so a new tile never holds up the others. */
const LockedTile = memo(function LockedTile({ parentalActive, ...props }: LockedTileProps) {
  const { gate, recheck } = useTileLock(props.tile, parentalActive);
  return <Tile {...props} lock={gate} onRecheck={recheck} />;
});

/** A free slot: the frame of a monitor waiting for a channel. */
function EmptySlot({ slot, className, disabled, onAdd }: { slot: number; className: string; disabled: boolean; onAdd(slot: number): void }) {
  const { t } = useTranslation('multiview');
  const number = slot + 1;
  return (
    <button
      type="button"
      data-slot-focus={slot}
      data-testid="multiview-empty-slot"
      data-slot={number}
      disabled={disabled}
      aria-label={t('slotEmptyLabel', { slot: number })}
      onClick={() => onAdd(slot)}
      className={cn(
        'group/slot relative flex min-h-0 flex-col items-center justify-center gap-2 rounded-sm border-2 border-dashed border-divider bg-surface/50 p-2 text-fg-muted outline-none',
        'hover:border-accent hover:bg-surface hover:text-fg active:bg-surface-2',
        'focus-visible:border-solid focus-visible:border-focus focus-visible:text-fg',
        'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-divider disabled:hover:bg-surface/50',
        'motion-safe:transition-colors motion-safe:duration-150',
        className,
      )}
    >
      <span aria-hidden className="absolute start-2 top-2 flex size-6 items-center justify-center rounded-sm bg-surface-3 font-display text-sm font-semibold tabular-nums text-fg-muted">
        {number}
      </span>
      <span aria-hidden className="flex size-10 items-center justify-center rounded-full border border-border bg-surface-2 group-hover/slot:border-accent group-hover/slot:text-accent">
        <Plus className="size-5" />
      </span>
      <span className="text-center text-sm font-medium">{t('addChannel')}</span>
    </button>
  );
}

/**
 * The monitor wall: one slot per place in the layout, tiles in slot order, the rest free.
 * Geometry is in layout.ts; the host around it is a size container.
 */
export const Wall = forwardRef<HTMLDivElement, WallProps>(function Wall(
  {
    tiles,
    layout,
    audioKey,
    silent,
    volume,
    parentalActive,
    parentalMode,
    overLimitSources,
    missingSources,
    programmes,
    swapFrom,
    onAdd,
    onKeyDown,
    ...handlers
  },
  ref,
) {
  const { t } = useTranslation('multiview');
  const slots = capacityOf(layout);
  return (
    <div
      ref={ref}
      role="region"
      aria-label={t('wallLabel')}
      aria-describedby="multiview-wall-keys"
      data-testid="multiview-wall"
      data-layout={layout}
      onKeyDown={onKeyDown}
      className={cn('grid w-full gap-1 @2xl:mx-auto @2xl:my-auto', WALL_CLASSES[layout])}
    >
      <p id="multiview-wall-keys" className="sr-only">
        {t('wallKeysHint')}
      </p>
      {Array.from({ length: slots }, (_, slot) => {
        const tile = tiles[slot];
        const className = slotClass(layout, slot);
        if (!tile) return <EmptySlot key={`free-${slot}`} slot={slot} className={className} disabled={swapFrom !== null} onAdd={onAdd} />;
        const hasSound = tile.key === audioKey;
        return (
          <LockedTile
            key={tile.key}
            tile={tile}
            slot={slot}
            className={className}
            hasSound={hasSound}
            audible={hasSound && !silent}
            volume={volume}
            parentalActive={parentalActive}
            parentalMode={parentalMode}
            sourceMissing={missingSources.has(tile.ref.sourceId)}
            overLimit={overLimitSources.has(tile.ref.sourceId)}
            programme={programmes.get(itemKey(tile.ref))}
            swapFrom={swapFrom}
            {...handlers}
          />
        );
      })}
    </div>
  );
});
