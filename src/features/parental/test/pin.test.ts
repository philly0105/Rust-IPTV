import { describe, expect, it } from 'vitest';

import { RpcError } from '@/api/transport';

import { classifyPinError, formatCountdown, isValidPin, isWeakPin, normalizeDigits, retryAfterOf, sanitizePin } from '../pin';
import { formatUntil } from '../time';

describe('PIN rules', () => {
  it('normalizes digits from every keyboard', () => {
    expect(normalizeDigits('12 34')).toBe('1234');
    expect(normalizeDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789'); // Arabic-Indic
    expect(normalizeDigits('۴۵۶')).toBe('456'); // Persian
    expect(normalizeDigits('१२३')).toBe('123'); // Devanagari
    expect(normalizeDigits('０９８')).toBe('098'); // full-width
    expect(normalizeDigits('PIN: 2580!')).toBe('2580');
  });

  it('keeps at most 8 digits', () => {
    expect(sanitizePin('1234567890')).toBe('12345678');
  });

  it('accepts 4 to 8 ASCII digits', () => {
    expect(isValidPin('123')).toBe(false);
    expect(isValidPin('1234')).toBe(true);
    expect(isValidPin('12345678')).toBe(true);
    expect(isValidPin('123456789')).toBe(false);
    expect(isValidPin('12a4')).toBe(false);
    expect(isValidPin('١٢٣٤')).toBe(false);
  });

  it('flags PINs a child guesses first', () => {
    for (const p of ['0000', '1234', '4321', '98765', '12345678']) expect(isWeakPin(p), p).toBe(true);
    for (const p of ['2580', '1357', '1123', '123']) expect(isWeakPin(p), p).toBe(false);
  });
});

describe('PIN errors', () => {
  it('maps the core codes', () => {
    expect(classifyPinError(new RpcError('auth', 'Wrong PIN.'))).toEqual({ kind: 'wrong' });
    expect(classifyPinError(new RpcError('conflict', 'Wait', true, { retryAfterSeconds: 59.2 }))).toEqual({ kind: 'lockout', seconds: 60 });
    expect(classifyPinError(new RpcError('conflict', 'Wait'))).toEqual({ kind: 'lockout', seconds: 30 });
    expect(classifyPinError({ code: 'invalid', message: 'newPin must be 4 to 8 digits.' })).toEqual({ kind: 'invalid' });
    expect(classifyPinError(new RpcError('network', 'offline'))).toEqual({ kind: 'other', code: 'network', message: 'offline' });
  });

  it('reads retryAfterSeconds defensively', () => {
    expect(retryAfterOf(null)).toBeNull();
    expect(retryAfterOf({ retryAfterSeconds: 'x' })).toBeNull();
    expect(retryAfterOf({ retryAfterSeconds: -1 })).toBeNull();
    expect(retryAfterOf({ retryAfterSeconds: 120 })).toBe(120);
  });
});

describe('formatting', () => {
  it('formats a countdown', () => {
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(9.2)).toBe('0:10');
    expect(formatCountdown(75)).toBe('1:15');
    expect(formatCountdown(300)).toBe('5:00');
    expect(formatCountdown(3725)).toBe('1:02:05');
    expect(formatCountdown(-5)).toBe('0:00');
  });

  it('formats "unlocked until" with the weekday only on another day', () => {
    const now = Date.parse('2026-10-13T10:00:00');
    expect(formatUntil(new Date('2026-10-13T10:15:00').toISOString(), 'en', now)).toMatch(/10:15/);
    expect(formatUntil(new Date('2026-10-14T02:00:00').toISOString(), 'en', now)).toMatch(/Wed/);
    expect(formatUntil('nope', 'en', now)).toBe('');
  });
});
