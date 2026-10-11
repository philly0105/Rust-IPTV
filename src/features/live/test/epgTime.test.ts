import { describe, expect, it } from 'vitest';

import { HOUR, MINUTE, canCatchUp, layoutBlocks, lookbackMs, programIndexAt, programProgress, programWhen } from '../lib/epgTime';

const p = (title: string, s: number, e: number) => ({ channelId: 'c', title, start: new Date(s).toISOString(), end: new Date(e).toISOString() });
const NOW = Date.UTC(2026, 9, 11, 12, 0);

describe('epgTime', () => {
  it('classifies and measures programmes', () => {
    const cur = p('now', NOW - 30 * MINUTE, NOW + 30 * MINUTE);
    expect(programWhen(cur, NOW)).toBe('now');
    expect(programWhen(p('past', NOW - HOUR, NOW - 1), NOW)).toBe('past');
    expect(programWhen(p('next', NOW + 1, NOW + HOUR), NOW)).toBe('future');
    expect(programProgress(cur, NOW)).toBeCloseTo(0.5);
  });

  it('gates catch-up by source kind, archive flag and window', () => {
    const ended = p('x', NOW - 3 * HOUR, NOW - 2 * HOUR);
    const archive = { archive: { enabled: true, durationHours: 24 } };
    expect(canCatchUp(ended, archive, 'xtream', NOW)).toBe(true);
    expect(canCatchUp(ended, archive, 'stalker', NOW)).toBe(true);
    expect(canCatchUp(ended, archive, 'm3u', NOW)).toBe(false);
    expect(canCatchUp(ended, {}, 'xtream', NOW)).toBe(false);
    expect(canCatchUp(p('old', NOW - 30 * HOUR, NOW - 29 * HOUR), archive, 'xtream', NOW)).toBe(false);
    expect(canCatchUp(p('later', NOW + HOUR, NOW + 2 * HOUR), archive, 'xtream', NOW)).toBe(false);
    expect(lookbackMs({ archive: { enabled: true, durationHours: 168 } })).toBe(72 * HOUR);
    expect(lookbackMs(undefined)).toBe(3 * HOUR);
  });

  it('lays out blocks clipped to the window without overlaps', () => {
    const from = NOW - HOUR;
    const to = NOW + HOUR;
    const blocks = layoutBlocks(
      [p('b', NOW - 20 * MINUTE, NOW + 20 * MINUTE), p('a', NOW - 2 * HOUR, NOW - 10 * MINUTE), p('c', NOW + 2 * HOUR, NOW + 3 * HOUR)],
      from,
      to,
      2,
      NOW,
    );
    expect(blocks.map((b) => b.program.title)).toEqual(['a', 'b']);
    expect(blocks[0]).toMatchObject({ left: 0, clipStart: true, width: 100 });
    // b overlaps a: trimmed to start where a ends
    expect(blocks[1]!.left).toBe(100);
    expect(programIndexAt([p('a', NOW - HOUR, NOW), p('b', NOW, NOW + HOUR)], NOW + 1)).toBe(1);
  });
});
