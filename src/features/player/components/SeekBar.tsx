import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../cn';
import { formatTime, positionReadout, SEEK_STEP, SEEK_STEP_LARGE } from '../format';
import type { TimeRange } from '../media';

export interface SeekBarProps {
  /** Window start (0 for VOD, seekable start for live DVR). */
  min: number;
  max: number;
  value: number;
  buffered: TimeRange[];
  /** Live streams mark the live edge at `max`. */
  live?: boolean;
  /** Seconds behind the live edge that still read as "Live" (see `LIVE_EDGE_SLACK`). */
  edgeSlack?: number;
  onSeek(seconds: number): void;
  className?: string;
}

/** Half the width of the widest preview label ("1:02:03"), in px. */
const TIP_HALF = 28;

/** Centre of the preview label: under the pointer, but never past either end of the bar. */
export function clampTip(x: number, width: number): number {
  if (width <= TIP_HALF * 2) return width / 2;
  return Math.min(width - TIP_HALF, Math.max(TIP_HALF, x));
}

/**
 * The tuner dial: a thin track with buffered segments, an amber played fill and a
 * needle thumb. Scrubbing previews locally and commits one seek on release.
 */
export function SeekBar({ min, max, value, buffered, live, edgeSlack, onSeek, className }: SeekBarProps) {
  const { t } = useTranslation('player');
  const trackRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [hover, setHover] = useState<{ x: number; time: number } | null>(null);
  const span = Math.max(0.001, max - min);
  const shown = preview ?? value;
  const pct = (v: number): number => Math.min(100, Math.max(0, ((v - min) / span) * 100));

  const timeAt = useCallback(
    (clientX: number): { time: number; x: number } => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return { time: min, x: 0 };
      const x = Math.min(rect.width, Math.max(0, clientX - rect.left));
      return { time: min + (x / rect.width) * span, x };
    },
    [min, span],
  );

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const at = timeAt(e.clientX);
    // Touch has no hover: the press itself shows the preview time.
    setHover(at);
    setPreview(at.time);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const at = timeAt(e.clientX);
    setHover(at);
    if (preview !== null) setPreview(at.time);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    if (preview === null) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const target = timeAt(e.clientX).time;
    setPreview(null);
    if (e.pointerType === 'touch') setHover(null);
    if (Number.isFinite(target)) onSeek(target);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? SEEK_STEP_LARGE : SEEK_STEP;
    let next: number | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = value - step;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = value + step;
    else if (e.key === 'PageDown') next = value - 60;
    else if (e.key === 'PageUp') next = value + 60;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    onSeek(Math.min(max, Math.max(min, next)));
  };

  const valueText = positionReadout(t, { position: shown, duration: max, liveEnd: live ? max : undefined, edgeSlack });

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label={t('seek')}
      aria-valuemin={Math.floor(min)}
      aria-valuemax={Math.floor(max)}
      aria-valuenow={Math.floor(shown)}
      aria-valuetext={valueText}
      className={cn('group/seek relative flex h-5 cursor-pointer touch-none items-center select-none', className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setPreview(null)}
      onPointerLeave={() => setHover(null)}
      onKeyDown={onKeyDown}
    >
      <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/20 motion-safe:transition-[height] group-hover/seek:h-1.5 group-focus-visible/seek:h-1.5">
        {live && buffered.length === 0 && (
          // Live rewind without buffered ranges (mpv's cache): everything up to the edge is cached.
          <div
            data-testid="rewind-cached"
            className="absolute inset-y-0 bg-white/30"
            style={{ left: `${pct(shown)}%`, width: `${Math.max(0, 100 - pct(shown))}%` }}
          />
        )}
        {buffered.map((r) => (
          <div
            key={`${r.start}-${r.end}`}
            className="absolute inset-y-0 bg-white/30"
            style={{ left: `${pct(r.start)}%`, width: `${Math.max(0, pct(r.end) - pct(r.start))}%` }}
          />
        ))}
        <div className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${pct(shown)}%` }} />
      </div>
      {/* The needle */}
      <div
        aria-hidden
        className="pointer-events-none absolute top-1/2 h-3.5 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-hover shadow-[0_0_10px_var(--color-accent)] opacity-0 motion-safe:transition-opacity group-hover/seek:opacity-100 group-focus-visible/seek:opacity-100"
        style={{ left: `${pct(shown)}%`, opacity: preview !== null ? 1 : undefined }}
      />
      {live && (
        <>
          <div
            aria-hidden
            className="pointer-events-none absolute top-1/2 right-0 size-2 -translate-y-1/2 rounded-full bg-live"
          />
          {/* How far back the rewind window reaches, at its start (shown with the needle). */}
          <div
            aria-hidden
            data-testid="rewind-depth"
            className="player-glass-strong player-on-glass-muted pointer-events-none absolute bottom-6 left-0 rounded-sm border px-1.5 py-0.5 font-display text-xs tabular-nums opacity-0 motion-safe:transition-opacity group-hover/seek:opacity-100 group-focus-visible/seek:opacity-100"
            style={{ opacity: hover && hover.x < 64 ? 0 : undefined }}
          >
            -{formatTime(span)}
          </div>
        </>
      )}
      {hover && (
        <div
          aria-hidden
          data-testid="seek-preview"
          className="player-glass-strong pointer-events-none absolute bottom-6 -translate-x-1/2 rounded-sm border px-1.5 py-0.5 font-display text-xs tabular-nums"
          // Kept inside the bar so the ends never clip at the player's edge.
          style={{ left: clampTip(hover.x, trackRef.current?.getBoundingClientRect().width ?? 0) }}
        >
          {live ? `-${formatTime(Math.max(0, max - hover.time))}` : formatTime(hover.time)}
        </div>
      )}
    </div>
  );
}
