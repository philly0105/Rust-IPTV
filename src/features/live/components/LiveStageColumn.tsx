import type { ComponentType, ReactNode } from 'react';

import { PlayerStage } from '@/features/player';
import { cn } from '@/ui/cn';

export interface LiveStageColumnProps {
  /** The section's accessible name ("Player"). */
  label: string;
  /** Something plays (or an external player holds the stage). */
  busy: boolean;
  /** What the stage shows while nothing plays: the shared {@link StageIdle}. */
  idle: ReactNode;
  /** Drawn over the stage (the number readout). */
  overlay?: ReactNode;
  /** The guide ribbon (EpgRibbon with `details`). */
  ribbon: ReactNode;
  /** A phone shows the ribbon (playing, with something to say); otherwise the list starts near the top. */
  ribbonOnPhone: boolean;
  /** A phone shows no stage at all (nothing playing and nothing to pick). */
  hiddenOnPhone?: boolean;
  stageTestId: string;
  sectionTestId?: string;
  ribbonTestId?: string;
  /** The player slot; the lists slice passes the one from its own seam (deps.ts). */
  Stage?: ComponentType<{ className?: string; children?: ReactNode }>;
}

/**
 * The stage column of Live and of a custom list (LG-07): one layout, so a fix lands in both.
 *
 * Beside the list (md up) the stage is a 16:9 screen with the guide ribbon under it, and the
 * ribbon's Now card and Up next fill the rest of the column instead of a blank panel (LG-02,
 * L3-player-4). When the column is too short, Up next goes first, then the screen gives way and
 * the ribbon keeps its height. The column keeps about 300 px for the player's controls; the list
 * gives way first, down to 240 px (XB2-16).
 *
 * On a phone the stage is on top, as wide as the screen. Nothing playing is a slim bar above the
 * list, not a black 16:9 box (L2-visual-13); the ribbon comes with playback (L3-visual-4).
 */
export function LiveStageColumn(props: LiveStageColumnProps) {
  const { busy, Stage = PlayerStage } = props;
  return (
    <section
      aria-label={props.label}
      data-testid={props.sectionTestId}
      className={cn(
        'order-first flex min-w-0 shrink-0 flex-col md:order-none md:min-w-[min(300px,40%)] md:flex-1',
        !busy && props.hiddenOnPhone && 'max-md:hidden',
      )}
    >
      <div
        data-testid={props.stageTestId}
        data-idle={busy ? undefined : ''}
        className={cn(
          'relative min-h-0 bg-black md:aspect-video md:shrink',
          busy ? 'aspect-video' : 'max-md:h-14 max-md:border-b max-md:border-divider max-md:bg-surface-2',
        )}
      >
        <Stage className={busy ? 'h-full w-full' : 'h-full w-full max-md:bg-transparent'}>{props.idle}</Stage>
        {props.overlay}
      </div>
      {/* Beside the list the ribbon's surface runs on to the bottom of the column. */}
      <div
        data-testid={props.ribbonTestId}
        className={cn(props.ribbonOnPhone ? 'max-md:contents' : 'max-md:hidden', 'md:flex md:min-h-0 md:shrink-0 md:grow md:flex-col md:bg-surface')}
      >
        {props.ribbon}
      </div>
    </section>
  );
}
