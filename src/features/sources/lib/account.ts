/**
 * Subscription status as the UI reads it: the cached `account.status` turned
 * into one expiry state plus a connection count, the dashboard's expiry
 * alerts, and their remembered dismissals. Pure apart from localStorage.
 */

import type { AccountStatus } from '@/api/rpc';

const DAY_MS = 24 * 3600 * 1000;

/** Where the subscription stands. `days` counts whole days left, rounded up (0 = expires today). */
export type ExpiryState =
  | { kind: 'expired'; expDate?: string }
  | { kind: 'expiring'; expDate: string; days: number }
  | { kind: 'ok'; expDate?: string; days?: number }
  | { kind: 'unknown' };

/** Whole days until `iso`, rounded up; negative once it has passed. Undefined for unreadable dates. */
export function daysUntil(iso: string, now: number): number | undefined {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return undefined;
  return Math.ceil((at - now) / DAY_MS);
}

/**
 * The expiry state of a cached status. A status text of "Expired" counts even
 * without a date; `warnDays` 0 turns the "expiring soon" warning off.
 */
export function expiryState(status: AccountStatus | null | undefined, warnDays: number, now: number = Date.now()): ExpiryState {
  if (!status) return { kind: 'unknown' };
  const exp = status.expDate;
  const at = exp ? Date.parse(exp) : Number.NaN;
  const passed = !Number.isNaN(at) && at <= now;
  if (passed || status.status?.trim().toLowerCase() === 'expired') return exp ? { kind: 'expired', expDate: exp } : { kind: 'expired' };
  if (!exp || Number.isNaN(at)) return status.status ? { kind: 'ok' } : { kind: 'unknown' };
  const days = Math.max(0, Math.ceil((at - now) / DAY_MS));
  if (warnDays > 0 && days <= warnDays) return { kind: 'expiring', expDate: exp, days };
  return { kind: 'ok', expDate: exp, days };
}

export interface Connections {
  active: number;
  max: number;
}

/**
 * Connections in use and the limit; null when the provider reports no limit or the last check
 * failed (the cached counts are then from an older check and may be long out of date).
 */
export function connections(status: AccountStatus | null | undefined): Connections | null {
  if (status?.error) return null;
  const max = status?.maxConnections;
  if (typeof max !== 'number' || max <= 0) return null;
  const active = status?.activeCons;
  return { active: typeof active === 'number' && active > 0 ? active : 0, max };
}

/** Every connection is in use. */
export function connectionsFull(c: Connections | null): boolean {
  return c !== null && c.active >= c.max;
}

/** One dashboard expiry alert. */
export interface ExpiryAlert {
  sourceId: string;
  state: Extract<ExpiryState, { kind: 'expired' | 'expiring' }>;
  /** Dismissal key: a renewed subscription (new date) warns again. */
  key: string;
}

export function alertKey(sourceId: string, expDate: string | undefined): string {
  return `${sourceId}|${expDate ?? 'expired'}`;
}

/**
 * Sources whose subscription expired or expires within `warnDays`, expired
 * first then soonest first, minus dismissed ones. Nothing when `warnDays` is 0.
 */
export function expiryAlerts(
  statuses: readonly AccountStatus[],
  { warnDays, dismissed, now = Date.now(), sourceIds }: { warnDays: number; dismissed: ReadonlySet<string>; now?: number; sourceIds?: ReadonlySet<string> },
): ExpiryAlert[] {
  if (warnDays <= 0) return [];
  const out: ExpiryAlert[] = [];
  for (const s of statuses) {
    if (sourceIds && !sourceIds.has(s.sourceId)) continue;
    const state = expiryState(s, warnDays, now);
    if (state.kind !== 'expired' && state.kind !== 'expiring') continue;
    const key = alertKey(s.sourceId, state.expDate);
    if (!dismissed.has(key)) out.push({ sourceId: s.sourceId, state, key });
  }
  const rank = (a: ExpiryAlert) => (a.state.kind === 'expired' ? -1 : a.state.days);
  return out.sort((a, b) => rank(a) - rank(b));
}

export const DISMISSED_STORAGE_KEY = 'tsrust.accountAlerts.dismissed';
/** Keeps the stored list bounded: old keys belong to past expiry dates. */
const MAX_DISMISSED = 100;

export function loadDismissed(): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(DISMISSED_STORAGE_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveDismissed(keys: ReadonlySet<string>): void {
  try {
    localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify([...keys].slice(-MAX_DISMISSED)));
  } catch {
    // Storage full or blocked: the alert comes back next launch, which is harmless.
  }
}
