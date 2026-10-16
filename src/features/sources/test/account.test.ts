import { afterEach, describe, expect, it } from 'vitest';

import type { AccountStatus } from '@/api/rpc';

import {
  DISMISSED_STORAGE_KEY,
  alertKey,
  connections,
  connectionsFull,
  daysUntil,
  expiryAlerts,
  expiryState,
  loadDismissed,
  saveDismissed,
} from '../lib/account';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const DAY = 24 * 3600 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

function status(over: Partial<AccountStatus> = {}): AccountStatus {
  return { sourceId: 'a', kind: 'xtream', status: 'Active', isTrial: false, checkedAt: iso(NOW), ...over };
}

describe('expiryState', () => {
  it('is unknown without a status', () => {
    expect(expiryState(null, 7, NOW)).toEqual({ kind: 'unknown' });
    expect(expiryState(status({ status: undefined }), 7, NOW)).toEqual({ kind: 'unknown' });
  });

  it('is ok without an expiry date (unlimited)', () => {
    expect(expiryState(status(), 7, NOW)).toEqual({ kind: 'ok' });
  });

  it('warns inside the window, counting whole days up', () => {
    const exp = iso(NOW + 2.5 * DAY);
    expect(expiryState(status({ expDate: exp }), 7, NOW)).toEqual({ kind: 'expiring', expDate: exp, days: 3 });
    expect(expiryState(status({ expDate: iso(NOW + 7 * DAY) }), 7, NOW).kind).toBe('expiring');
    expect(expiryState(status({ expDate: iso(NOW + 8 * DAY) }), 7, NOW)).toMatchObject({ kind: 'ok', days: 8 });
  });

  it('0 warn days turns the expiring warning off but not expired', () => {
    expect(expiryState(status({ expDate: iso(NOW + DAY) }), 0, NOW).kind).toBe('ok');
    expect(expiryState(status({ expDate: iso(NOW - DAY) }), 0, NOW).kind).toBe('expired');
  });

  it('is expired after the date or when the provider says so', () => {
    expect(expiryState(status({ expDate: iso(NOW - 1000) }), 7, NOW).kind).toBe('expired');
    expect(expiryState(status({ status: 'Expired' }), 7, NOW)).toEqual({ kind: 'expired' });
  });

  it('daysUntil rounds up and rejects junk', () => {
    expect(daysUntil(iso(NOW + 1), NOW)).toBe(1);
    expect(daysUntil(iso(NOW - 2 * DAY), NOW)).toBe(-2);
    expect(daysUntil('soon', NOW)).toBeUndefined();
  });
});

describe('connections', () => {
  it('needs a positive limit', () => {
    expect(connections(status())).toBeNull();
    expect(connections(status({ maxConnections: 0, activeCons: 3 }))).toBeNull();
    expect(connections(status({ maxConnections: 2 }))).toEqual({ active: 0, max: 2 });
  });

  it('is full when every connection is in use', () => {
    expect(connectionsFull(connections(status({ activeCons: 2, maxConnections: 2 })))).toBe(true);
    expect(connectionsFull(connections(status({ activeCons: 1, maxConnections: 2 })))).toBe(false);
    expect(connectionsFull(null)).toBe(false);
  });

  it('hides the counts of a failed check (they are from an older one)', () => {
    expect(connections(status({ activeCons: 1, maxConnections: 1, error: 'panel down' }))).toBeNull();
  });
});

describe('expiryAlerts', () => {
  const expired = status({ sourceId: 'x', expDate: iso(NOW - DAY) });
  const soon = status({ sourceId: 's', expDate: iso(NOW + 2 * DAY) });
  const later = status({ sourceId: 'l', expDate: iso(NOW + 5 * DAY) });
  const fine = status({ sourceId: 'f', expDate: iso(NOW + 60 * DAY) });

  it('lists expired first, then soonest, and skips healthy accounts', () => {
    const alerts = expiryAlerts([later, fine, soon, expired], { warnDays: 7, dismissed: new Set(), now: NOW });
    expect(alerts.map((a) => a.sourceId)).toEqual(['x', 's', 'l']);
  });

  it('is empty when warnings are off', () => {
    expect(expiryAlerts([expired, soon], { warnDays: 0, dismissed: new Set(), now: NOW })).toEqual([]);
  });

  it('hides a dismissed alert only for that expiry date', () => {
    const dismissed = new Set([alertKey('s', soon.expDate)]);
    expect(expiryAlerts([soon], { warnDays: 7, dismissed, now: NOW })).toEqual([]);
    const renewed = { ...soon, expDate: iso(NOW + 3 * DAY) };
    expect(expiryAlerts([renewed], { warnDays: 7, dismissed, now: NOW })).toHaveLength(1);
  });

  it('skips sources that are gone', () => {
    expect(expiryAlerts([soon], { warnDays: 7, dismissed: new Set(), now: NOW, sourceIds: new Set(['other']) })).toEqual([]);
  });
});

describe('dismissal storage', () => {
  afterEach(() => localStorage.clear());

  it('round-trips and survives junk', () => {
    saveDismissed(new Set(['a|1', 'b|2']));
    expect(loadDismissed()).toEqual(new Set(['a|1', 'b|2']));
    localStorage.setItem(DISMISSED_STORAGE_KEY, '{nope');
    expect(loadDismissed()).toEqual(new Set());
    localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(['ok', 3]));
    expect(loadDismissed()).toEqual(new Set(['ok']));
  });

  it('keeps the newest 100 keys', () => {
    saveDismissed(new Set(Array.from({ length: 120 }, (_, i) => `k${i}`)));
    const kept = loadDismissed();
    expect(kept.size).toBe(100);
    expect(kept.has('k119')).toBe(true);
    expect(kept.has('k0')).toBe(false);
  });
});
