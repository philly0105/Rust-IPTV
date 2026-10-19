import { useEffect, useState } from 'react';
import { intlLocale } from '@/lib/intl';

/** `Date.now()`, re-read every `intervalMs` while `intervalMs` is set. */
export function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * Wall-clock time of `iso` for "unlocked until": hours and minutes, with the
 * weekday when it is not today (a 12-hour unlock can run past midnight).
 */
export function formatUntil(iso: string, language: string, now = Date.now()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const sameDay = at.toDateString() === new Date(now).toDateString();
  const opts: Intl.DateTimeFormatOptions = sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { weekday: 'short', hour: 'numeric', minute: '2-digit' };
  try {
    return new Intl.DateTimeFormat(intlLocale(language), opts).format(at);
  } catch {
    return new Intl.DateTimeFormat(undefined, opts).format(at);
  }
}

/** Short date for "locked on". */
export function formatDay(iso: string, language: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(intlLocale(language), { dateStyle: 'medium' }).format(at);
  } catch {
    return at.toLocaleDateString();
  }
}

/** True unless the OS or the app's own switch asks for reduced motion. */
export function motionAllowed(): boolean {
  if (typeof window === 'undefined') return false;
  if (document.documentElement.dataset['reducedMotion'] === 'true') return false;
  return !(typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}
