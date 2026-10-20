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

/** The preview labels over the bar: the glass tooltip's look. */
const SEEK_LABEL =
  'pointer-events-none absolute bottom-7 rounded-sm border border-glass-border bg-glass-strong px-2 py-0.5 font-numeric text-caption text-on-glass tabular-nums shadow-2 pointer-coarse:bottom-10';

/**
 * The seek bar (PL-BAR-HIERARCHY): a 4 px track that thickens under the pointer, the buffered
 * ranges, a lighter fill up to the time under the pointer with that time over it, the accent
 * played fill and a round thumb that shows on hover, focus and while scrubbing. Scrubbing previews
 * locally and commits one seek on release. Under a coarse pointer the hit area grows to 36 px
 * around the same track and the thumb to 16 px (PL-TOUCH-ERGONOMICS).
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

  const scrubbing = preview !== null;
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
      data-scrubbing={scrubbing ? '' : undefined}
      className={cn('group/seek relative flex h-6 cursor-pointer touch-none items-center select-none pointer-coarse:h-9', className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setPreview(null)}
      onPointerLeave={() => setHover(null)}
      onKeyDown={onKeyDown}
    >
      <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/25 group-hover/seek:h-1.5 group-focus-visible/seek:h-1.5 group-data-[scrubbing]/seek:h-1.5 motion-safe:transition-[height] motion-safe:duration-(--duration-fast)">
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
        {/* Up to the time under the pointer, lighter, so the preview reads against the played part. */}
        {hover && !scrubbing && (
          <div aria-hidden data-testid="seek-hover-fill" className="absolute inset-y-0 left-0 bg-white/25" style={{ width: `${pct(hover.time)}%` }} />
        )}
        <div className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${pct(shown)}%` }} />
      </div>
      {/* The thumb: on hover, focus and while scrubbing. */}
      <div
        aria-hidden
        data-testid="seek-thumb"
        className="pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 scale-0 rounded-full bg-accent shadow-[0_0_0_3px_rgb(0_0_0/0.25)] group-hover/seek:scale-100 group-focus-visible/seek:scale-100 group-data-[scrubbing]/seek:scale-100 motion-safe:transition-transform motion-safe:duration-(--duration-fast) pointer-coarse:size-4"
        style={{ left: `${pct(shown)}%` }}
      />
      {live && (
        <>
          <div aria-hidden className="pointer-events-none absolute top-1/2 right-0 size-2 -translate-y-1/2 rounded-full bg-live" />
          {/* How far back the rewind window reaches, at its start (shown with the thumb). */}
          <div
            aria-hidden
            data-testid="rewind-depth"
            className={cn(SEEK_LABEL, 'left-0 text-on-glass-muted opacity-0 group-hover/seek:opacity-100 group-focus-visible/seek:opacity-100 motion-safe:transition-opacity')}
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
          className={cn(SEEK_LABEL, '-translate-x-1/2')}
          // Kept inside the bar so the ends never clip at the player's edge.
          style={{ left: clampTip(hover.x, trackRef.current?.getBoundingClientRect().width ?? 0) }}
        >
          {live ? `-${formatTime(Math.max(0, max - hover.time))}` : formatTime(hover.time)}
        </div>
      )}
    </div>
  );
}
