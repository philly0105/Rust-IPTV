/** Number formatting for the library pages. Locale-aware, never throws. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** `1536` -> `1.5 KB`. Binary multiples, one decimal above KB, none below. */
export function formatBytes(bytes: number | undefined | null, locale?: string): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : 1;
  const n = new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
  return `${n} ${UNITS[unit]}`;
}

/** `2_500_000` -> `2.4 MB/s`. Empty for zero or unknown. */
export function formatSpeed(bytesPerSecond: number | undefined | null, locale?: string): string {
  if (bytesPerSecond == null || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '';
  return `${formatBytes(bytesPerSecond, locale)}/s`;
}

/** Seconds remaining, or undefined when the total or speed is unknown. */
export function etaSeconds(bytesDownloaded: number, totalBytes: number | undefined, bytesPerSecond: number | undefined): number | undefined {
  if (!totalBytes || !bytesPerSecond || bytesPerSecond <= 0) return undefined;
  const remaining = totalBytes - bytesDownloaded;
  if (remaining <= 0) return 0;
  return Math.ceil(remaining / bytesPerSecond);
}

/** Compact duration: `45s`, `3m 05s`, `1h 02m`, `2d 4h`. */
export function formatDuration(seconds: number | undefined | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Media clock for resume points: `4:05`, `1:02:09`. */
export function formatClock(seconds: number | undefined | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Whole percentage clamped to 0..100, or undefined when the total is unknown. */
export function percentOf(done: number, total: number | undefined): number | undefined {
  if (!total || total <= 0) return undefined;
  return Math.max(0, Math.min(100, Math.floor((done / total) * 100)));
}
