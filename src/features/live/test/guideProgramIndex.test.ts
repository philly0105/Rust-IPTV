import { describe, expect, it, vi } from 'vitest';

import type { EpgProgram } from '@/api/types';

import { HOUR, MINUTE, ms } from '../lib/epgTime';
import { hasProgramInRange, programsInRange } from '../lib/guideProgramIndex';

const T = Date.UTC(2026, 9, 25, 12);
const program = (title: string, start: number, end: number): EpgProgram => ({
  channelId: 'test', title, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
});

describe('programsInRange', () => {
  it('includes programmes crossing either edge, with exclusive end/start boundaries', () => {
    const list = [
      program('before', T - 2 * HOUR, T),
      program('crosses start', T - HOUR, T + MINUTE),
      program('inside', T + MINUTE, T + 30 * MINUTE),
      program('crosses end', T + 30 * MINUTE, T + 2 * HOUR),
      program('after', T + HOUR, T + 2 * HOUR),
    ];
    expect(programsInRange(list, T, T + HOUR)).toEqual(list.slice(1, 4));
  });

  it('retains long overlapping programmes and the provider order of unsorted/duplicate starts', () => {
    const list = Object.freeze([
      program('later first', T + 30 * MINUTE, T + HOUR),
      program('long', T - 20 * HOUR, T + 20 * HOUR),
      program('duplicate start', T + 30 * MINUTE, T + 2 * HOUR),
      program('ended', T - HOUR, T),
    ]);
    const selected = programsInRange(list, T + 45 * MINUTE, T + HOUR);
    expect(selected).toEqual(list.slice(0, 3));
    expect(selected[0]).toBe(list[0]);
    expect(selected[1]).toBe(list[1]);
  });

  it('uses raw answer times for offset windows and supports XMLTV compact dates', () => {
    const list = [{ ...program('compact', T, T + HOUR), start: '20261025120000 +0000', end: '20261025130000 +0000' }];
    const offset = 90 * MINUTE;
    const displayStart = T + offset;
    expect(programsInRange(list, displayStart - offset, displayStart + HOUR - offset)).toEqual(list);
    expect(programsInRange(list, displayStart, displayStart + HOUR)).toEqual([]);
  });

  it('matches overlapping selections across irregular provider history without changing its order', () => {
    const list = Array.from({ length: 200 }, (_, i) => {
      const start = T + ((i * 73) % 200 - 100) * 7 * MINUTE;
      return program(String(i), start, start + (i % 13 + 1) * HOUR);
    });
    for (let hour = -12; hour <= 30; hour++) {
      const from = T + hour * HOUR;
      const to = from + 3 * HOUR;
      const expected = list.filter((p) => ms(p.end) > from && ms(p.start) < to);
      expect(programsInRange(list, from, to)).toEqual(expected);
      expect(hasProgramInRange(list, from, to)).toBe(expected.length > 0);
    }
  });

  it('does not parse the complete archive again when the requested window moves', () => {
    const list = Array.from({ length: 28 * 96 }, (_, i) => program(String(i), T + i * 15 * MINUTE, T + (i + 1) * 15 * MINUTE));
    const parse = vi.spyOn(Date, 'parse');
    try {
      const first = programsInRange(list, T + 24 * HOUR, T + 48 * HOUR);
      expect(first).toHaveLength(96);
      expect(parse).toHaveBeenCalled();
      parse.mockClear();
      expect(programsInRange(list, T + 30 * HOUR, T + 54 * HOUR)).toHaveLength(96);
      expect(hasProgramInRange(list, T + 27 * 24 * HOUR, T + 28 * 24 * HOUR)).toBe(true);
      expect(hasProgramInRange(list, T + 28 * 24 * HOUR, T + 29 * 24 * HOUR)).toBe(false);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it('keeps selected array identity when the window or the selected programmes are unchanged', () => {
    const list = [program('long', T, T + 3 * HOUR)];
    const first = programsInRange(list, T + HOUR, T + 2 * HOUR);
    expect(programsInRange(list, T + HOUR, T + 2 * HOUR)).toBe(first);
    expect(programsInRange(list, T + HOUR + MINUTE, T + 2 * HOUR + MINUTE)).toBe(first);
    expect(programsInRange([...list], T + HOUR, T + 2 * HOUR)).toEqual(first);
  });

  it('handles empty and invalid windows without loading any programme times', () => {
    const list = [program('one', T, T + HOUR)];
    expect(programsInRange([], T, T + HOUR)).toEqual([]);
    expect(programsInRange(list, T, T)).toEqual([]);
    expect(programsInRange(list, T + HOUR, T)).toEqual([]);
    expect(programsInRange(list, Number.NaN, T)).toEqual([]);
    expect(hasProgramInRange(list, T, T)).toBe(false);
    expect(hasProgramInRange(list, Number.NaN, T)).toBe(false);
  });

  it('retains the existing overlap predicate for malformed provider rows before merge validation', () => {
    const list = [
      { ...program('invalid start', T, T + HOUR), start: 'not a timestamp' },
      { ...program('invalid end', T, T + HOUR), end: 'not a timestamp' },
      program('backwards', T + HOUR, T),
      program('zero', T, T),
    ];
    const from = T - MINUTE;
    const to = T + 2 * HOUR;
    expect(programsInRange(list, from, to)).toEqual(list.filter((p) => ms(p.end) > from && ms(p.start) < to));
    expect(hasProgramInRange(list, from, to)).toBe(true);
  });
});
