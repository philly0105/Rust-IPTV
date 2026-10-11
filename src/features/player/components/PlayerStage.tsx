import { useLayoutEffect, useRef, type ReactNode } from 'react';

import { cn } from '../cn';
import { pushStageTarget } from '../stage';
import { registerStage, usePlayerStore } from '../store';

export interface PlayerStageProps {
  className?: string;
  /** Shown while nothing plays (an empty state, a poster). The player covers it when active. */
  children?: ReactNode;
}

/**
 * A slot for the player inside a page layout (live view, detail pages). While mounted,
 * the dock moves the running player here (dock 'stage'); on unmount it falls back to the mini player.
 * The slot is black and letterboxes; size it from the parent (e.g. `aspect-video` or a fixed height).
 */
export function PlayerStage({ className, children }: PlayerStageProps) {
  const ref = useRef<HTMLDivElement>(null);
  const active = usePlayerStore((s) => !!s.source && s.mode !== 'external');
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
    <div ref={ref} data-player-stage="" className={cn('relative isolate min-h-0 overflow-hidden bg-black', className)}>
      {!active && children}
    </div>
  );
}
