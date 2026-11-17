/**
 * The Downloads header's total speed: the summed live speed of every running transfer as a figure,
 * and its last minute as a small line beside it. Shown only while something moved in that minute.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/ui/cn';

import { useMediaQuery } from '../deps';
import { formatBytes, formatSpeed } from '../lib/format';
import { progressStore } from '../lib/progress';
import { SAMPLE_MS, SpeedHistory, hasActivity, sparklinePaths, type SpeedSample } from '../lib/speedHistory';

/** One history for the app, so leaving the page and coming back keeps the last minute. */
export const speedHistory = new SpeedHistory((now) => progressStore.totalSpeed(now));

/** With reduced motion the line is redrawn this often instead of sliding along every second. */
export const REDUCED_REDRAW_MS = 5_000;

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

/** The OS setting or the app's own (Settings > Appearance sets `data-reduced-motion` on the root). */
function useReducedMotion(): boolean {
  const system = useMediaQuery(REDUCED_QUERY, false);
  return system || document.documentElement.dataset['reducedMotion'] === 'true';
}

interface Snapshot {
  samples: readonly SpeedSample[];
  /** The newest sample's speed: the figure beside the line. */
  total: number;
  at: number;
}

/**
 * Samples the summed speed once a second while mounted. It also listens to the progress store, so
 * its upstream event subscription stays open even with no row on screen. With reduced motion the
 * drawn line updates every few seconds; the figure still follows each sample.
 */
export function useSpeedHistory(reduced: boolean): Snapshot & { drawn: readonly SpeedSample[]; drawnAt: number } {
  const [snap, setSnap] = useState<Snapshot>(() => {
    const now = Date.now();
    return { samples: [...speedHistory.list(now)], total: progressStore.totalSpeed(now), at: now };
  });
  const [drawn, setDrawn] = useState<{ samples: readonly SpeedSample[]; at: number }>(() => ({ samples: snap.samples, at: snap.at }));

  useEffect(() => progressStore.subscribe(() => undefined), []);

  useEffect(() => {
    let lastDraw = 0;
    const tick = () => {
      const now = Date.now();
      const samples = [...speedHistory.sample(now)];
      setSnap({ samples, total: samples.at(-1)?.bytesPerSecond ?? 0, at: now });
      if (!reduced || now - lastDraw >= REDUCED_REDRAW_MS) {
        lastDraw = now;
        setDrawn({ samples, at: now });
      }
    };
    tick();
    const timer = setInterval(tick, SAMPLE_MS);
    return () => clearInterval(timer);
  }, [reduced]);

  return { ...snap, drawn: drawn.samples, drawnAt: drawn.at };
}

const WIDTH = 64;
const HEIGHT = 20;

export function SpeedSparkline({ className }: { className?: string }) {
  const { t, i18n } = useTranslation('library');
  const lang = i18n.language;
  const reduced = useReducedMotion();
  const { samples, total, drawn, drawnAt } = useSpeedHistory(reduced);
  if (!hasActivity(samples)) return null;

  const speed = total > 0 ? formatSpeed(total, lang) : `${formatBytes(0, lang)}/s`;
  const { line, area } = sparklinePaths(drawn, WIDTH, HEIGHT, drawnAt);
  const label = t('speedTotalAria', { speed });
  return (
    <div
      role="img"
      aria-label={label}
      className={cn('flex shrink-0 items-center gap-2 text-caption text-fg-muted', className)}
      data-testid="downloads-sparkline"
      data-total={Math.round(total)}
    >
      {/* SVG coordinates never mirror, so time runs left to right in every language. */}
      <svg
        aria-hidden
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-5 w-16 overflow-visible text-accent-mark max-sm:w-12"
      >
        <line x1={0} x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} className="stroke-divider" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <path d={area} className="fill-current opacity-15" />
        <path
          d={line}
          className="fill-none stroke-current"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          data-testid="downloads-sparkline-line"
        />
      </svg>
      <span className="min-w-[7ch] text-end font-medium tabular-nums text-fg" data-testid="downloads-sparkline-total">
        {speed}
      </span>
    </div>
  );
}
