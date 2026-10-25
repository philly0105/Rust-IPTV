/**
 * L3-perf-ui-6: the shell leaves the first route alone for PLAYER_PREFETCH_DELAY_MS before the
 * idle wait for the player starts; a press loads it at once from the start.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/player', () => ({}));

const { PLAYER_IDLE_TIMEOUT_MS, PLAYER_PREFETCH_DELAY_MS, PLAYER_SCROLL_QUIET_MS, schedulePlayerLoad } = await import('../ShellLayout');

function fakeWindow() {
  const target = new EventTarget();
  const idleCallbacks: (() => void)[] = [];
  const extra = { requestIdleCallback: vi.fn((cb: () => void) => idleCallbacks.push(cb)), cancelIdleCallback: vi.fn() };
  return { win: Object.assign(target, extra) as unknown as Window, idleCallbacks, extra };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('player prefetch delay', () => {
  it('Shift-wheel waits for a quiet period even when the idle timeout fires', () => {
    vi.useFakeTimers();
    const load = vi.fn();
    const { win, idleCallbacks } = fakeWindow();
    schedulePlayerLoad(load, false, win, PLAYER_PREFETCH_DELAY_MS);
    win.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
    expect(load).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PLAYER_PREFETCH_DELAY_MS);
    win.dispatchEvent(new Event('wheel'));
    idleCallbacks.shift()!();
    expect(load).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PLAYER_SCROLL_QUIET_MS - 1);
    win.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(1);
    idleCallbacks.shift()!();
    expect(load).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PLAYER_SCROLL_QUIET_MS);
    idleCallbacks.shift()!();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a play intent bypasses the scroll delay and cancels pending idle callbacks', () => {
    vi.useFakeTimers();
    const load = vi.fn();
    const { win, idleCallbacks } = fakeWindow();
    schedulePlayerLoad(load, false, win);
    win.dispatchEvent(new Event('wheel'));
    win.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(load).toHaveBeenCalledTimes(1);
    idleCallbacks[0]!();
    vi.advanceTimersByTime(PLAYER_SCROLL_QUIET_MS);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('starts the idle wait only once the delay has passed', () => {
    vi.useFakeTimers();
    const load = vi.fn();
    const { win, idleCallbacks, extra } = fakeWindow();
    schedulePlayerLoad(load, false, win, PLAYER_PREFETCH_DELAY_MS);
    vi.advanceTimersByTime(PLAYER_PREFETCH_DELAY_MS - 1);
    expect(extra.requestIdleCallback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(extra.requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: PLAYER_IDLE_TIMEOUT_MS });
    expect(load).not.toHaveBeenCalled();
    idleCallbacks[0]!();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a press during the delay loads at once and ends the wait', () => {
    vi.useFakeTimers();
    for (const type of ['pointerdown', 'keydown']) {
      const load = vi.fn();
      const { win, extra } = fakeWindow();
      schedulePlayerLoad(load, false, win, PLAYER_PREFETCH_DELAY_MS);
      win.dispatchEvent(new Event(type));
      expect(load, type).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(PLAYER_PREFETCH_DELAY_MS * 2);
      expect(extra.requestIdleCallback, type).not.toHaveBeenCalled();
      expect(load, type).toHaveBeenCalledTimes(1);
    }
  });

  it('cancel during the delay stops everything; a restore still loads at once', () => {
    vi.useFakeTimers();
    const load = vi.fn();
    const { win, extra } = fakeWindow();
    schedulePlayerLoad(load, false, win, PLAYER_PREFETCH_DELAY_MS)();
    vi.advanceTimersByTime(PLAYER_PREFETCH_DELAY_MS * 2);
    win.dispatchEvent(new Event('pointerdown'));
    expect(extra.requestIdleCallback).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();

    const now = vi.fn();
    schedulePlayerLoad(now, true, fakeWindow().win, PLAYER_PREFETCH_DELAY_MS);
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('waits a couple of seconds, not a long time', () => {
    expect(PLAYER_PREFETCH_DELAY_MS).toBeGreaterThanOrEqual(2000);
    expect(PLAYER_PREFETCH_DELAY_MS).toBeLessThanOrEqual(3000);
  });
});
