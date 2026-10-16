/**
 * Series rule helpers (Run 2 C5): the core's title key, matching a programme to its rule,
 * which channels can have one, and the Scheduled page's order.
 */
import { describe, expect, it } from 'vitest';

import type { ItemRef, Recording, RecordingRule } from '@/api/types';

import { buildRuleIndex, canHaveRule, ruleFor, ruleKey, scheduledByRule, sortRules, titleKey } from '../lib/rules';

const ref: ItemRef = { sourceId: 's1', contentType: 'live', itemId: '7' };
const other: ItemRef = { sourceId: 's1', contentType: 'live', itemId: '8' };

function rule(over: Partial<RecordingRule> = {}): RecordingRule {
  return { id: 'r1', ref, channelName: 'Alpha', title: 'News at 10', enabled: true, createdAt: '2026-10-01T00:00:00Z', upcoming: 2, ...over };
}

describe('titleKey', () => {
  it('keeps letters and digits only, lowercased, like the core', () => {
    expect(titleKey('News at 10!')).toBe('newsat10');
    expect(titleKey('NEWS  AT 10')).toBe('newsat10');
    expect(titleKey('  The-Show: Part 2 ')).toBe('theshowpart2');
  });

  it('keeps letters of every script and drops marks and symbols', () => {
    expect(titleKey('Ünïcödé Ñews')).toBe('ünïcödéñews');
    expect(titleKey('Новости 24')).toBe('новости24');
    expect(titleKey('ニュース７')).toBe('ニュース７');
    expect(titleKey('★ ♪ — !!')).toBe('');
  });
});

describe('rule index', () => {
  const index = buildRuleIndex([rule(), rule({ id: 'r2', ref: other, title: 'Weather' }), rule({ id: 'r3', title: '***' })]);

  it('finds the rule of a programme by channel and series title, whatever the punctuation', () => {
    expect(ruleFor(index, ref, 'NEWS AT 10')?.id).toBe('r1');
    expect(ruleFor(index, ref, 'News at 10.')?.id).toBe('r1');
    expect(ruleFor(index, other, 'News at 10')).toBeUndefined();
    expect(ruleFor(index, other, 'weather')?.id).toBe('r2');
    expect(ruleFor(index, undefined, 'News at 10')).toBeUndefined();
  });

  it('a title without letters or digits never matches', () => {
    expect(ruleFor(index, ref, '!!!')).toBeUndefined();
    expect(index.size).toBe(2);
  });

  it('keys on the item key and the title key', () => {
    expect(ruleKey(ref, 'News at 10')).toBe('s1|live|7#newsat10');
  });
});

describe('canHaveRule', () => {
  it('live and radio channels with a real title only', () => {
    expect(canHaveRule(ref, 'News')).toBe(true);
    expect(canHaveRule({ ...ref, contentType: 'radio' }, 'News')).toBe(true);
    expect(canHaveRule({ ...ref, contentType: 'movie' }, 'News')).toBe(false);
    expect(canHaveRule(ref, ' -- ')).toBe(false);
  });
});

describe('scheduledByRule', () => {
  it('counts the rule-made recordings still waiting to start', () => {
    const rec = (over: Partial<Recording>): Recording => ({
      id: 'x',
      ref,
      channelName: 'Alpha',
      title: 'News',
      kind: 'programme',
      start: '2026-10-14T18:00:00Z',
      end: '2026-10-14T19:00:00Z',
      paddingBeforeMinutes: 1,
      paddingAfterMinutes: 5,
      status: 'scheduled',
      fileNames: [],
      bytes: 0,
      ...over,
    });
    const list = [rec({ ruleId: 'r1' }), rec({ ruleId: 'r1', status: 'recording' }), rec({ ruleId: 'r1' }), rec({ ruleId: 'r2' }), rec({})];
    expect(scheduledByRule(list, 'r1')).toBe(2);
    expect(scheduledByRule(undefined, 'r1')).toBe(0);
  });
});

describe('sortRules', () => {
  it('enabled first, then the next airing, then the title', () => {
    const sorted = sortRules([
      rule({ id: 'paused', enabled: false, nextStart: '2026-10-14T08:00:00Z' }),
      rule({ id: 'later', nextStart: '2026-10-16T08:00:00Z' }),
      rule({ id: 'none-b', title: 'B' }),
      rule({ id: 'soon', nextStart: '2026-10-14T09:00:00Z' }),
      rule({ id: 'none-a', title: 'A' }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(['soon', 'later', 'none-a', 'none-b', 'paused']);
  });

  it('does not change its input', () => {
    const input = [rule({ id: 'b', title: 'B' }), rule({ id: 'a', title: 'A' })];
    sortRules(input);
    expect(input.map((r) => r.id)).toEqual(['b', 'a']);
    expect(sortRules(undefined)).toEqual([]);
  });
});
