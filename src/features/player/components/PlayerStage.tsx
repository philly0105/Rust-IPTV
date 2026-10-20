import { useLayoutEffect, useRef, type ReactNode } from 'react';

import { cn } from '../cn';
import { pushStageTarget } from '../stage';
import { registerStage, usePlayerStore } from '../store';
import { ExternalStage } from './ExternalStage';

export interface PlayerStageProps {
  className?: string;
  /** Shown while nothing plays (an empty state, a poster). The player covers it when active. */
  children?: ReactNode;
  /**
   * The player's own title bar over the picture. A page that already heads the stage with the
   * title (a VOD detail page's watch bar) turns it off, so the name is not shown twice
   * (PL-DUPLICATE-CHROME); fullscreen still shows it, since the page's heading is gone there.
   */
  showTitle?: boolean;
}

/**
 * A slot for the player inside a page layout (live view, detail pages). While mounted,
 * the dock moves the running player here (dock 'stage'); on unmount it falls back to the mini player.
 * The slot is black and letterboxes; size it from the parent (e.g. `aspect-video` or a fixed height).
 */
export function PlayerStage({ className, children, showTitle = true }: PlayerStageProps) {
  const ref = useRef<HTMLDivElement>(null);
  const active = usePlayerStore((s) => !!s.source && s.mode !== 'external');
  const external = usePlayerStore((s) => !!s.source && s.mode === 'external');
  // Layout effect: the cleanup must run before React detaches this div (see stage.ts setRehome).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const unTarget = pushStageTarget(el);
    const unStage = registerStage();
    return () => {
      unStage();
      unTarget();
    };
  }, []);
  return (
    <div
      ref={ref}
      data-player-stage=""
      data-stage-title={showTitle ? undefined : 'off'}
      className={cn('relative isolate min-h-0 overflow-hidden bg-black', className)}
    >
      {external ? <ExternalStage /> : !active && children}
    </div>
  );
}
