import { forwardRef, memo, type KeyboardEventHandler } from 'react';
import { useTranslation } from 'react-i18next';

import { itemKey, type ItemKey, type ParentalMode } from '@/api/types';

import { cn } from '../deps';
import { capacityOf, slotClass, WALL_BASE, WALL_CLASSES } from '../layout';
import type { MultiviewLayout, MultiviewTile } from '../types';
import type { QuickPick } from '../quickPicks';
import { useTileLock } from '../useWallData';
import { FreeSlot } from './FreeSlot';
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
  /** Recent and favorite live channels not on the wall, offered in the next free slot. */
  picks: readonly QuickPick[];
  picksLoading: boolean;
  /** Key of the quick pick being put up. */
  pendingPick: string | null;
  onAdd(slot: number): void;
  onPick(p: QuickPick, slot: number): void;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
}

type LockedTileProps = Omit<TileProps, 'lock' | 'onRecheck'> & { parentalActive: boolean | undefined };

/** A tile with its parental lock asked on its own, so a new tile never holds up the others. */
const LockedTile = memo(function LockedTile({ parentalActive, ...props }: LockedTileProps) {
  const { gate, recheck } = useTileLock(props.tile, parentalActive);
  return <Tile {...props} lock={gate} onRecheck={recheck} />;
});

/**
 * The monitor wall: one slot per place in the layout, tiles in slot order, the rest free (FreeSlot).
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
    picks,
    picksLoading,
    pendingPick,
    onAdd,
    onPick,
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
      className={cn(WALL_BASE, WALL_CLASSES[layout])}
    >
      <p id="multiview-wall-keys" className="sr-only">
        {t('wallKeysHint')}
      </p>
      {Array.from({ length: slots }, (_, slot) => {
        const tile = tiles[slot];
        const className = slotClass(layout, slot);
        if (!tile) {
          return (
            <FreeSlot
              key={`free-${slot}`}
              slot={slot}
              className={className}
              disabled={swapFrom !== null}
              next={slot === tiles.length}
              picks={picks}
              picksLoading={picksLoading}
              pending={pendingPick}
              onAdd={onAdd}
              onPick={onPick}
            />
          );
        }
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
