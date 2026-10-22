// sportsRead: the Sports page's reads share one limit of PAGE_READS in flight, wait in the order asked, free
// their slot when they fail, and are never sent when their signal aborts while they wait.
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Sent {
  cmd: string;
  args: unknown;
  open: boolean;
  answer: (value: unknown) => void;
  fail: (error: unknown) => void;
}
const sent = vi.hoisted(() => [] as Sent[]);
vi.mock('@/api/transport', () => ({
  rpcRaw: (cmd: string, args: unknown) =>
    new Promise((resolve, reject) => {
      const c: Sent = {
        cmd,
        args,
        open: true,
        answer: (value) => {
          c.open = false;
          resolve(value);
        },
        fail: (error) => {
          c.open = false;
          reject(error);
        },
      };
      sent.push(c);
    }),
}));

const { sportsRead, PAGE_READS } = await import('../hooks/sportsRead');

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Answers every call sent so far with its args, and the ones that go out next, until none is left. */
async function finishAll(): Promise<void> {
  while (sent.some((c) => c.open)) {
    for (const c of sent) if (c.open) c.answer(c.args);
    await tick();
  }
}

afterEach(async () => {
  await finishAll();
  sent.length = 0;
});

describe('sportsRead', () => {
  it(`sends at most ${PAGE_READS} at once and the rest in the order asked`, async () => {
    const reads = Array.from({ length: 12 }, (_, i) => sportsRead('epg.grid', i));
    await tick();
    expect(sent.map((c) => c.args)).toEqual([0, 1, 2, 3, 4]);
    sent[2]!.answer(2);
    sent[0]!.answer(0);
    await tick();
    expect(sent.map((c) => c.args)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    await finishAll();
    expect(await Promise.all(reads)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(sent.map((c) => c.args)).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  it('frees the slot of a read that failed', async () => {
    const reads = Array.from({ length: PAGE_READS + 1 }, (_, i) => sportsRead('catalog.search', i));
    await tick();
    expect(sent).toHaveLength(PAGE_READS);
    sent[0]!.fail(new Error('db'));
    await expect(reads[0]).rejects.toThrow('db');
    await tick();
    expect(sent).toHaveLength(PAGE_READS + 1);
    await finishAll();
    await Promise.all(reads.slice(1));
  });

  it('never sends a read whose signal aborted while it waited, and moves the line on', async () => {
    const busy = Array.from({ length: PAGE_READS }, (_, i) => sportsRead('epg.grid', i));
    const ctrl = new AbortController();
    const dropped = sportsRead('epg.grid', 'dropped', ctrl.signal);
    const after = sportsRead('epg.grid', 'after');
    await tick();
    ctrl.abort();
    await expect(dropped).rejects.toHaveProperty('name', 'AbortError');
    sent[0]!.answer(0);
    await tick();
    // The aborted read gave up its place: the next in line went out in the freed slot.
    expect(sent.map((c) => c.args)).toEqual([0, 1, 2, 3, 4, 'after']);
    await finishAll();
    await Promise.all([...busy, after]);
    expect(sent.map((c) => c.args)).not.toContain('dropped');
  });

  it('sends nothing for a signal that already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(sportsRead('catalog.channels', {}, ctrl.signal)).rejects.toHaveProperty('name', 'AbortError');
    expect(sent).toEqual([]);
  });
});
