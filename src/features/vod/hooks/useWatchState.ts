import { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { sameRef, type ItemRef } from '@/api/types';
import { usePlayerStore } from '@/features/player';
import { playerMenuJustClosed } from '@/features/player/components/Controls';

export interface WatchState {
  /** This item is playing in an in-app surface (inline or embedded mpv): the page is in watch state. */
  active: boolean;
  /** This item is the current player source in any mode (including external). */
  current: boolean;
  episodeId?: string;
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'error';
  error?: string;
  /** Playback reached the end (paused at the duration). */
  ended: boolean;
}

/** Ties a detail page to the player store (C8). */
export function useWatchState(ref: ItemRef): WatchState {
  return usePlayerStore(
    useShallow((s) => {
      const current = !!s.source && sameRef(s.source.ref, ref);
      const inApp = s.mode === 'inline' || s.mode === 'embedded-mpv';
      const dur = s.durationSeconds ?? 0;
      const ended = current && s.status === 'paused' && dur > 0 && s.positionSeconds >= dur - 1;
      const out: WatchState = {
        active: current && inApp && s.status !== 'idle',
        current,
        status: current ? s.status : 'idle',
        ended,
      };
      if (current && s.source?.episodeId) out.episodeId = s.source.episodeId;
      if (current && s.error) out.error = s.error;
      return out;
    }),
  );
}

/**
 * Escape closes the inline player while the page is in watch state (unless a dialog, an input,
 * fullscreen, PiP or the player's own options menu owns the key).
 */
export function useEscapeToClose(active: boolean, onClose: () => void): void {
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      // The player's options menu closes on this Escape (or just did): it must not stop playback too.
      if (t?.closest?.('[data-testid="player-options-menu"]') || playerMenuJustClosed()) return;
      if (document.fullscreenElement) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      // In PiP, Escape belongs to the PiP window (leave PiP), not to "stop playback".
      if (document.querySelector('[data-pip-layer]:not([hidden])')) return;
      e.preventDefault();
      cb.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active]);
}
