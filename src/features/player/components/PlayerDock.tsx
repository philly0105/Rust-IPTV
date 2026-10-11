import { GripHorizontal, Maximize2, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useInRouterContext, useNavigate } from 'react-router';

import '../player.css';

import { cn } from '../cn';
import { bindExternalEvents } from '../external';
import { useMediaStore } from '../media';
import { bindRemote } from '../remote';
import { getLastStagePath, setRehome, useStageTarget } from '../stage';
import { flushProgress, reportFullscreen, usePlayerStore } from '../store';
import { usePlaybackShortcuts } from '../usePlaybackShortcuts';
import { bindSettingsEvents, usePlayerSettings } from '../useSettings';
import { PlayerSurface } from './PlayerSurface';

const POS_KEY = 'player.mini.pos';
const MARGIN = 16;

interface MiniPos {
  right: number;
  bottom: number;
}

function readPos(): MiniPos {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<MiniPos>;
      if (typeof p.right === 'number' && typeof p.bottom === 'number') return { right: p.right, bottom: p.bottom };
    }
  } catch {
    // default
  }
  return { right: MARGIN, bottom: MARGIN };
}

function clampPos(p: MiniPos, w: number, h: number): MiniPos {
  const maxRight = Math.max(MARGIN, window.innerWidth - w - MARGIN);
  const maxBottom = Math.max(MARGIN, window.innerHeight - h - MARGIN);
  return { right: Math.min(maxRight, Math.max(MARGIN, p.right)), bottom: Math.min(maxBottom, Math.max(MARGIN, p.bottom)) };
}

function ExpandButton({ label }: { label: string }) {
  const inRouter = useInRouterContext();
  return inRouter ? <RouterExpand label={label} /> : <ExpandBase label={label} onExpand={() => usePlayerStore.getState().toggleFullscreen()} />;
}

function RouterExpand({ label }: { label: string }) {
  const navigate = useNavigate();
  return (
    <ExpandBase
      label={label}
      onExpand={() => {
        const path = getLastStagePath();
        if (path) navigate(path);
        else usePlayerStore.getState().toggleFullscreen();
      }}
    />
  );
}

function ExpandBase({ label, onExpand }: { label: string; onExpand(): void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onExpand}
      onPointerDown={(e) => e.stopPropagation()}
      className="inline-flex size-7 items-center justify-center rounded-full text-fg-muted hover:bg-surface-3 hover:text-fg"
    >
      <Maximize2 className="size-4" />
    </button>
  );
}

/**
 * Rendered once by the shell. Owns one persistent host node for the player and moves it
 * (DOM move, no remount) into the mounted <PlayerStage /> or into the floating mini frame.
 * Also binds playback shortcuts, remote control, external-player events and unload flushes.
 */
export function PlayerDock() {
  const { t } = useTranslation('player');
  const source = usePlayerStore((s) => s.source);
  const mode = usePlayerStore((s) => s.mode);
  const dock = usePlayerStore((s) => s.dock);
  const isFullscreen = usePlayerStore((s) => s.isFullscreen);
  const zapContext = usePlayerStore((s) => s.zapContext);
  const settings = usePlayerSettings();
  const stageTarget = useStageTarget();
  const [host] = useState(() => {
    const el = document.createElement('div');
    el.dataset['playerHost'] = '';
    el.className = 'absolute inset-0 z-10 bg-black';
    return el;
  });
  const miniSlotRef = useRef<HTMLDivElement>(null);
  const miniRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<MiniPos>(readPos);

  const visible = !!source && mode !== 'external';
  const inStage = visible && dock === 'stage' && !!stageTarget;
  const inMini = visible && !inStage && dock !== 'hidden';
  const channelPanelAvailable = !!source?.isLive && (settings?.fullscreenChannelPanel ?? true) && !!(zapContext ?? source?.ref);

  usePlaybackShortcuts({ channelPanelAvailable });

  // One-time global bindings.
  useEffect(() => {
    bindSettingsEvents();
    bindExternalEvents();
    return bindRemote();
  }, []);

  useEffect(() => {
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') flushProgress();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, []);

  // Synchronous move out of a stage that is about to unmount.
  useEffect(() => {
    setRehome((removed, next) => {
      if (host.parentNode !== removed) return;
      const target = next ?? miniSlotRef.current;
      target?.appendChild(host);
    });
    return () => setRehome(null);
  }, [host]);

  // Place the host node.
  useLayoutEffect(() => {
    const target = inStage ? stageTarget : miniSlotRef.current;
    if (target && host.parentNode !== target) target.appendChild(host);
  }, [inStage, stageTarget, host]);

  useEffect(
    () => () => {
      host.remove();
    },
    [host],
  );

  // Store fullscreen flag <-> DOM fullscreen of the host (which outlives engine remounts).
  useEffect(() => {
    if (isFullscreen && document.fullscreenElement !== host) {
      host.requestFullscreen?.().catch(() => reportFullscreen(false));
    } else if (!isFullscreen && document.fullscreenElement === host) {
      void document.exitFullscreen().catch(() => undefined);
    }
  }, [isFullscreen, host]);
  useEffect(() => {
    const on = (): void => {
      const fs = document.fullscreenElement === host;
      reportFullscreen(fs);
      if (!fs) useMediaStore.setState({ channelPanelOpen: false });
    };
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, [host]);

  // Keep the mini frame on screen when the window shrinks.
  useEffect(() => {
    const onResize = (): void => {
      const el = miniRef.current;
      if (!el) return;
      setPos((p) => clampPos(p, el.offsetWidth, el.offsetHeight));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const drag = useRef<{ x: number; y: number; start: MiniPos } | null>(null);
  const onDragStart = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { x: e.clientX, y: e.clientY, start: pos };
    },
    [pos],
  );
  const onDragMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    const el = miniRef.current;
    if (!d || !el) return;
    setPos(
      clampPos({ right: d.start.right - (e.clientX - d.x), bottom: d.start.bottom - (e.clientY - d.y) }, el.offsetWidth, el.offsetHeight),
    );
  };
  const onDragEnd = (): void => {
    if (!drag.current) return;
    drag.current = null;
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(pos));
    } catch {
      // ignore
    }
  };
  const nudge = (dx: number, dy: number): void => {
    const el = miniRef.current;
    if (!el) return;
    const next = clampPos({ right: pos.right - dx, bottom: pos.bottom - dy }, el.offsetWidth, el.offsetHeight);
    setPos(next);
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  };

  const isRadio = mode === 'radio';

  return (
    <>
      {createPortal(<PlayerSurface compact={inMini} channelPanelAvailable={channelPanelAvailable} />, host)}
      <div
        ref={miniRef}
        role="region"
        aria-label={t('nowPlaying')}
        hidden={!inMini}
        className={cn(
          'fixed z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-2',
          isRadio ? 'w-[min(420px,calc(100vw-32px))]' : 'w-[clamp(280px,26vw,440px)]',
          inMini && 'motion-safe:animate-pop-in',
        )}
        style={{ right: pos.right, bottom: pos.bottom }}
      >
        <div
          className="flex h-9 shrink-0 cursor-grab items-center gap-1.5 border-b border-border pr-1 pl-2 active:cursor-grabbing"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
        >
          <button
            type="button"
            aria-label={t('dragToMove')}
            title={t('dragToMove')}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 64 : 16;
              const map: Record<string, [number, number]> = {
                ArrowLeft: [-step, 0],
                ArrowRight: [step, 0],
                ArrowUp: [0, -step],
                ArrowDown: [0, step],
              };
              const d = map[e.key];
              if (!d) return;
              e.preventDefault();
              e.stopPropagation();
              nudge(d[0], d[1]);
            }}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-fg-subtle hover:text-fg"
          >
            <GripHorizontal className="size-4" />
          </button>
          {source?.isLive && <span className="size-1.5 shrink-0 rounded-full bg-live" aria-hidden />}
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg" title={source?.title}>
            {source?.title}
          </span>
          <ExpandButton label={t('expand')} />
          <button
            type="button"
            aria-label={t('close')}
            title={t('close')}
            onClick={() => usePlayerStore.getState().stop()}
            onPointerDown={(e) => e.stopPropagation()}
            className="inline-flex size-7 items-center justify-center rounded-full text-fg-muted hover:bg-surface-3 hover:text-fg"
          >
            <X className="size-4" />
          </button>
        </div>
        <div ref={miniSlotRef} className={cn('relative bg-black', isRadio ? 'h-16' : mode === 'embedded-mpv' ? 'aspect-[16/11]' : 'aspect-video')} />
      </div>
    </>
  );
}
