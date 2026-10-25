import { describe, expect, it, vi } from 'vitest';

import { createGuideHydrator, type HydrationTicket } from '../hydration';

function harness() {
  let id = 0;
  let time = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const hydrator = createGuideHydrator({
    requestFrame(callback) {
      frames.set(++id, callback);
      return id;
    },
    cancelFrame(handle) { frames.delete(handle); },
  });
  hydrator.setViewport({ left: 100, right: 200, firstRow: 10, lastRow: 15 });
  const frame = () => {
    const current = [...frames.values()];
    frames.clear();
    time += 16;
    for (const callback of current) callback(time);
  };
  return { hydrator, frames, frame };
}

describe('guide offscreen hydration', () => {
  it('activates visible programmes immediately, including long programmes starting outside the viewport', () => {
    const { hydrator, frames } = harness();
    const visible = vi.fn();
    const long = vi.fn();
    const offscreen = vi.fn();
    hydrator.enqueue({ left: 120, right: 180, row: 10 }, visible);
    hydrator.enqueue({ left: 0, right: 150, row: 15 }, long);
    hydrator.enqueue({ left: 100, right: 200, row: 16 }, offscreen);
    expect(visible).toHaveBeenCalledOnce();
    expect(long).toHaveBeenCalledOnce();
    expect(offscreen).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
  });

  it('does not defer an initial guide before the viewport is measured', () => {
    const requestFrame = vi.fn();
    const hydrator = createGuideHydrator({ requestFrame });
    const ready = vi.fn();
    expect(hydrator.isVisible({ left: 1000, right: 1200, row: 100 })).toBe(true);
    const ticket = hydrator.enqueue({ left: 1000, right: 1200, row: 100 }, ready);
    expect(ready).toHaveBeenCalledWith(ticket);
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('grants only one background group per frame and waits for its actual commit', () => {
    const { hydrator, frames, frame } = harness();
    const calls: string[] = [];
    let first: HydrationTicket | undefined;
    hydrator.enqueue({ left: 220, right: 240, row: 10 }, (ticket) => { first = ticket; calls.push('first'); });
    hydrator.enqueue({ left: 240, right: 260, row: 10 }, () => { calls.push('second'); });
    expect(calls).toEqual([]);
    frame();
    expect(calls).toEqual(['first']);
    expect(frames.size).toBe(0);
    frame();
    expect(calls).toEqual(['first']);
    first!.committed();
    expect(frames.size).toBe(1);
    expect(calls).toEqual(['first']);
    frame();
    expect(calls).toEqual(['first', 'second']);
  });

  it('also keeps synchronous commit acknowledgements to one offscreen group per frame', () => {
    const { hydrator, frame } = harness();
    const calls: number[] = [];
    for (let row = 10; row < 13; row++) {
      hydrator.enqueue({ left: 220, right: 240, row }, (ticket) => { calls.push(row); ticket.committed(); });
    }
    frame();
    expect(calls).toEqual([10]);
    frame();
    expect(calls).toEqual([10, 11]);
    frame();
    expect(calls).toEqual([10, 11, 12]);
  });

  it('immediately promotes new visible rows and times while another group is still committing', () => {
    const { hydrator, frame } = harness();
    const calls: string[] = [];
    hydrator.enqueue({ left: 220, right: 240, row: 10 }, () => { calls.push('background'); });
    hydrator.enqueue({ left: 300, right: 350, row: 20 }, () => { calls.push('new viewport'); });
    frame();
    expect(calls).toEqual(['background']);
    hydrator.setViewport({ left: 310, right: 400, firstRow: 19, lastRow: 22 });
    expect(calls).toEqual(['background', 'new viewport']);
  });

  it('reprioritizes queued work using the latest native viewport', () => {
    const { hydrator, frame } = harness();
    const calls: string[] = [];
    hydrator.enqueue({ left: 0, right: 50, row: 10 }, (ticket) => { calls.push('left'); ticket.committed(); });
    hydrator.enqueue({ left: 250, right: 300, row: 10 }, (ticket) => { calls.push('right'); ticket.committed(); });
    hydrator.setViewport({ left: 190, right: 240, firstRow: 10, lastRow: 15 });
    frame();
    expect(calls).toEqual(['right']);
    frame();
    expect(calls).toEqual(['right', 'left']);
  });

  it('warms visible channels before vertically overscanned channels', () => {
    const { hydrator, frame } = harness();
    const calls: string[] = [];
    hydrator.enqueue({ left: 100, right: 200, row: 16 }, (ticket) => { calls.push('overscan'); ticket.committed(); });
    hydrator.enqueue({ left: 250, right: 300, row: 10 }, (ticket) => { calls.push('visible channel'); ticket.committed(); });
    frame();
    expect(calls).toEqual(['visible channel']);
    frame();
    expect(calls).toEqual(['visible channel', 'overscan']);
  });

  it('cancels pending and active work without letting stale acknowledgements release a newer commit', () => {
    const { hydrator, frames, frame } = harness();
    const cancelled = vi.fn();
    const pending = hydrator.enqueue({ left: 210, right: 220, row: 10 }, cancelled);
    pending.cancel();
    expect(frames.size).toBe(0);
    let first: HydrationTicket | undefined;
    let second: HydrationTicket | undefined;
    hydrator.enqueue({ left: 210, right: 220, row: 10 }, (ticket) => { first = ticket; });
    hydrator.enqueue({ left: 220, right: 230, row: 10 }, (ticket) => { second = ticket; });
    const third = vi.fn();
    hydrator.enqueue({ left: 230, right: 240, row: 10 }, third);
    frame();
    first!.cancel();
    frame();
    expect(second).toBeDefined();
    first!.committed();
    expect(frames.size).toBe(0);
    frame();
    expect(third).not.toHaveBeenCalled();
    second!.committed();
    frame();
    expect(third).toHaveBeenCalledOnce();
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('disposes queued callbacks and ignores late acknowledgements and registrations', () => {
    const { hydrator, frames, frame } = harness();
    const ready = vi.fn();
    const ticket = hydrator.enqueue({ left: 210, right: 220, row: 10 }, ready);
    expect(frames.size).toBe(1);
    hydrator.dispose();
    ticket.committed();
    hydrator.setViewport({ left: 200, right: 300, firstRow: 10, lastRow: 15 });
    hydrator.enqueue({ left: 210, right: 220, row: 10 }, ready);
    expect(frames.size).toBe(0);
    frame();
    expect(ready).not.toHaveBeenCalled();
  });

  it('supports StrictMode effect cleanup and replay without reviving cancelled work', () => {
    const { hydrator, frames, frame } = harness();
    const stale = vi.fn();
    const ticket = hydrator.enqueue({ left: 210, right: 220, row: 10 }, stale);
    hydrator.reset();
    const replayed = vi.fn();
    hydrator.enqueue({ left: 210, right: 220, row: 10 }, replayed);
    ticket.committed();
    expect(frames.size).toBe(1);
    frame();
    expect(replayed).toHaveBeenCalledOnce();
    expect(stale).not.toHaveBeenCalled();
  });
});
