/**
 * data-perf r1 F4: the shell loads the player chunk after the first route, on the first idle
 * moment or the first pointer or key press, or at once when there is playback to restore.
 * It belongs in src/shell/test; it sits here because that folder was outside this fixer's
 * paths during the Run 3 fix stage.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/features/player', () => {
  loads.count++;
  return { restorePlayback: async () => false, PlayerDock: () => null, ExternalPlaybackFooter: () => null };
});

const { PLAYER_IDLE_TIMEOUT_MS, PLAYER_RESUME_KEY, schedulePlayerLoad } = await import('@/shell/ShellLayout');

const ROOT = join(__dirname, '..', '..', '..', '..');

function fakeWindow(idle: boolean) {
  const target = new EventTarget();
  const idleCallbacks: (() => void)[] = [];
  const extra = idle
    ? {
        requestIdleCallback: vi.fn((cb: () => void) => idleCallbacks.push(cb)),
        cancelIdleCallback: vi.fn(),
      }
    : { requestIdleCallback: undefined, cancelIdleCallback: undefined };
  return { win: Object.assign(target, extra) as unknown as Window, idleCallbacks, extra };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('player chunk deferral', () => {
  it('importing the shell does not import the player', async () => {
    // Give a module-level dynamic import time to resolve, as the old shell's did.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(loads.count).toBe(0);
  });

  it('reads the resume record the player writes', () => {
    expect(read('src/features/player/store.ts')).toContain(`export const RESUME_KEY = '${PLAYER_RESUME_KEY}';`);
  });

  it('loads at once when there is playback to restore', () => {
    const load = vi.fn();
    const { win, extra } = fakeWindow(true);
    schedulePlayerLoad(load, true, win);
    expect(load).toHaveBeenCalledTimes(1);
    expect(extra.requestIdleCallback).not.toHaveBeenCalled();
  });

  it('waits for the first idle moment, with a cap', () => {
    const load = vi.fn();
    const { win, idleCallbacks, extra } = fakeWindow(true);
    schedulePlayerLoad(load, false, win);
    expect(load).not.toHaveBeenCalled();
    expect(extra.requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: PLAYER_IDLE_TIMEOUT_MS });
    idleCallbacks[0]!();
    expect(load).toHaveBeenCalledTimes(1);
    // The idle load also ends the wait for a press.
    win.dispatchEvent(new Event('pointerdown'));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('loads on the first pointer or key press before the browser is idle', () => {
    for (const type of ['pointerdown', 'keydown']) {
      const load = vi.fn();
      const { win, extra } = fakeWindow(true);
      schedulePlayerLoad(load, false, win);
      win.dispatchEvent(new Event(type));
      expect(load, type).toHaveBeenCalledTimes(1);
      expect(extra.cancelIdleCallback, type).toHaveBeenCalled();
      win.dispatchEvent(new Event('keydown'));
      win.dispatchEvent(new Event('pointerdown'));
      expect(load, type).toHaveBeenCalledTimes(1);
    }
  });

  it('falls back to a macrotask without requestIdleCallback, and cancel stops everything', () => {
    vi.useFakeTimers();
    const load = vi.fn();
    const { win } = fakeWindow(false);
    schedulePlayerLoad(load, false, win);
    expect(load).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(load).toHaveBeenCalledTimes(1);

    const cancelled = vi.fn();
    const other = fakeWindow(false).win;
    schedulePlayerLoad(cancelled, false, other)();
    vi.runAllTimers();
    other.dispatchEvent(new Event('pointerdown'));
    expect(cancelled).not.toHaveBeenCalled();
  });
});

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}
