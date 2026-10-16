import { describe, expect, it } from 'vitest';

import type { Channel } from '@/api/types';

import { locateChannel, MAX_LOCATE_PROBES } from './channelPanelLocate';

const ch = (id: string, number?: number): Channel => ({
  ref: { sourceId: 's1', contentType: 'live', itemId: id },
  name: id,
  categoryId: 'g',
  categoryName: 'G',
  isRadio: false,
  ...(number !== undefined ? { number } : {}),
});

/** A catalog sorted as `sort: 'number'` sorts: by number, numberless last. */
function catalog(rows: Channel[], size: number) {
  const asked: number[] = [];
  const fetchPage = async (p: number) => {
    asked.push(p);
    return { items: rows.slice(p * size, (p + 1) * size), total: rows.length };
  };
  return { fetchPage, asked };
}

describe('locateChannel (L3-player-6)', () => {
  it('finds a channel of a 1, 2, 3 numbered source with one page', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ch(`c${i}`, i + 1));
    const { fetchPage, asked } = catalog(rows, 100);
    const found = await locateChannel(fetchPage, rows[734]!.ref, 735, 100);
    expect(found).toMatchObject({ index: 734, page: 7, total: 1000 });
    expect(found?.items[34]?.ref.itemId).toBe('c734');
    expect(asked).toEqual([7]);
  });

  it('binary-searches numbers with gaps (a category) in a few pages', async () => {
    // 2000 channels numbered 10, 20, 30...: the guess is past the end.
    const rows = Array.from({ length: 2000 }, (_, i) => ch(`c${i}`, (i + 1) * 10));
    const { fetchPage, asked } = catalog(rows, 100);
    const found = await locateChannel(fetchPage, rows[1234]!.ref, 12350, 100);
    expect(found?.index).toBe(1234);
    expect(asked.length).toBeLessThanOrEqual(MAX_LOCATE_PROBES);
  });

  it('finds a channel whose number spills over a page edge', async () => {
    // Fifteen channels share number 5, across pages 0 and 1 (of 10).
    const rows = [...Array.from({ length: 4 }, (_, i) => ch(`a${i}`, i + 1)), ...Array.from({ length: 15 }, (_, i) => ch(`five${i}`, 5)), ch('z', 6)];
    const { fetchPage } = catalog(rows, 10);
    expect((await locateChannel(fetchPage, rows[16]!.ref, 5, 10))?.index).toBe(16);
    expect((await locateChannel(fetchPage, rows[5]!.ref, 5, 10))?.index).toBe(5);
  });

  it('says null for a channel not in the list, or without a number off the first page', async () => {
    const rows = [...Array.from({ length: 150 }, (_, i) => ch(`c${i}`, i + 1)), ch('bare1'), ch('bare2')];
    const { fetchPage } = catalog(rows, 100);
    expect(await locateChannel(fetchPage, ch('elsewhere').ref, 42, 100)).toBeNull();
    expect(await locateChannel(fetchPage, ch('bare2').ref, undefined, 100)).toBeNull();
    // A numberless channel on the first page is still found there.
    const short = catalog([ch('x'), ch('y')], 100);
    expect((await locateChannel(short.fetchPage, ch('y').ref, undefined, 100))?.index).toBe(1);
  });
});
