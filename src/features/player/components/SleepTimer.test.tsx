/**
 * The sleep timer's chrome (C5): the entry in the options menu, the countdown chip, the Z
 * shortcut and its readout, the one-minute toast with Keep watching and Cancel, and the prompt
 * that stands in for the toast in fullscreen.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { formatClock } from '@/features/live/lib/epgTime';
import type { PlayerSource } from '@/api/types';

vi.mock('@/api/transport', () => ({
  rpc: vi.fn(() => Promise.reject(new Error('offline'))),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined }));

const store = await import('../store');
const media = await import('../media');
const nowNext = await import('../nowNext');
const sleep = await import('../sleepTimer');
const { usePlaybackShortcuts } = await import('../usePlaybackShortcuts');
const { Controls } = await import('./Controls');
const { SleepTimerHost, SleepPrompt, sleepLeftText } = await import('./SleepTimer');
const { ToastViewport, useToastStore } = await import('@/ui/Toast');
const lazyParts = await import('./lazyParts');
const { usePlayerStore } = store;
const { useSleepTimer } = sleep;

const MIN = 60_000;
const T0 = Date.parse('2026-10-13T22:00:00Z');

const live: PlayerSource = {
  url: 'http://h/live/101.m3u8',
  kind: 'hls',
  title: 'News 24',
  isLive: true,
  isRadio: false,
  ref: { sourceId: 's1', contentType: 'live', itemId: '101' },
};
const episode: PlayerSource = {
  url: 'http://h/series/e1.mkv',
  kind: 'direct',
  title: 'Show',
  isLive: false,
  isRadio: false,
  episodeId: 'e1',
  ref: { sourceId: 's1', contentType: 'series', itemId: '9' },
};

function Shortcuts() {
  usePlaybackShortcuts({ channelPanelAvailable: false });
  return null;
}

const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const key = (k: string): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
};
const clock = (t: number): string => formatClock(t, 'en');

// The app preloads its on-demand player parts at idle; the tests load them up front.
beforeAll(async () => {
  const { SleepChip, SleepMenu, SleepPrompt: Prompt, SleepRowValue, SleepTimerHost: Host } = lazyParts;
  await Promise.all([SleepChip, SleepMenu, Prompt, SleepRowValue, Host].map((p) => p.preload()));
});

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  store.__resetPlayerForTests();
  media.resetMedia();
  nowNext.__resetNowNextForTests();
  sleep.__resetSleepTimerForTests();
  useToastStore.setState({ toasts: [] });
  act(() => usePlayerStore.setState({ source: live, mode: 'inline', status: 'playing', volume: 0.8, dock: 'stage' }));
});

afterEach(() => {
  cleanup();
  sleep.__resetSleepTimerForTests();
  store.__resetPlayerForTests();
  media.resetMedia();
  useToastStore.setState({ toasts: [] });
  vi.useRealTimers();
});

describe('options menu entry', () => {
  it('sets a preset from the Sleep timer submenu and reads it back', async () => {
    render(<Controls variant="overlay" visible />);
    expect(screen.queryByTestId('sleep-chip')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Playback options' }));
    const row = screen.getByRole('menuitem', { name: /Sleep timer/ });
    expect(row.textContent).toContain('Off');
    fireEvent.click(row);

    const menu = screen.getByRole('menu', { name: 'Playback options' });
    const choices = within(menu).getAllByRole('menuitemradio');
    expect(choices.map((c) => c.textContent)).toEqual([
      'Off',
      `15 min${clock(T0 + 15 * MIN)}`,
      `30 min${clock(T0 + 30 * MIN)}`,
      `45 min${clock(T0 + 45 * MIN)}`,
      `60 min${clock(T0 + 60 * MIN)}`,
      `90 min${clock(T0 + 90 * MIN)}`,
      expect.stringContaining('End of programme'),
    ]);
    expect(choices[0]!.getAttribute('aria-checked')).toBe('true');
    // Focus lands in the submenu for its arrow keys.
    expect(document.activeElement).toBe(choices[0]);

    fireEvent.click(choices[2]!);
    expect(useSleepTimer.getState()).toMatchObject({ target: { kind: 'minutes', minutes: 30 }, endsAt: T0 + 30 * MIN });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(media.useMediaStore.getState().osd).toMatchObject({ primary: 'Sleep timer', secondary: `30 min, Stops at ${clock(T0 + 30 * MIN)}` });
  });

  it('offers "End of programme" only once the guide has an end, else says there is none', async () => {
    render(<Controls variant="overlay" visible />);
    fireEvent.click(screen.getByRole('button', { name: 'Playback options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Sleep timer/ }));
    const programme = screen.getByRole('menuitemradio', { name: /End of programme/ }) as HTMLButtonElement;
    expect(programme.disabled).toBe(true);
    // The core is offline in this test: no guide.
    await advance(0);
    expect(programme.disabled).toBe(true);
    expect(programme.textContent).toContain('No guide');
  });

  it('offers the end of the episode for VOD with a known length', async () => {
    act(() => usePlayerStore.setState({ source: episode, positionSeconds: 600, durationSeconds: 1800 }));
    render(<Controls variant="overlay" visible />);
    fireEvent.click(screen.getByRole('button', { name: 'Playback options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Sleep timer/ }));
    const end = screen.getByRole('menuitemradio', { name: /End of episode/ });
    expect(end.textContent).toContain(clock(T0 + 1200_000));
    expect(screen.queryByRole('menuitemradio', { name: /End of programme/ })).toBeNull();
    fireEvent.click(end);
    expect(useSleepTimer.getState()).toMatchObject({ target: { kind: 'episodeEnd' }, endsAt: T0 + 1200_000 });
  });
});

describe('countdown chip', () => {
  it('counts down in the bar, opens the sleep menu, and breathes while the volume fades', async () => {
    render(<Controls variant="overlay" visible />);
    act(() => useSleepTimer.getState().start({ kind: 'minutes', minutes: 15 }));
    const chip = screen.getByTestId('sleep-chip');
    expect(chip.textContent).toBe('15:00');
    expect(chip.getAttribute('aria-label')).toBe('Sleep timer, 15:00 left');
    expect(chip.getAttribute('aria-keyshortcuts')).toBe('Z');
    await advance(65_000);
    expect(chip.textContent).toBe('13:55');

    fireEvent.click(chip);
    expect(screen.getByRole('menuitemradio', { name: /15 min/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menu').textContent).toContain(`Stops at ${clock(T0 + 15 * MIN)}`);
    fireEvent.click(chip);
    expect(screen.queryByRole('menu')).toBeNull();

    expect(chip.className).not.toContain('player-sleep-fading');
    await advance(15 * MIN - 65_000 - 20_000);
    expect(screen.getByTestId('sleep-chip').className).toContain('player-sleep-fading');
    await advance(20_000);
    expect(screen.queryByTestId('sleep-chip')).toBeNull();
  });

  it('formats the time left like the player clock', () => {
    expect(sleepLeftText(T0 + 90 * MIN, T0)).toBe('1:30:00');
    expect(sleepLeftText(T0 + 500, T0)).toBe('0:01');
    expect(sleepLeftText(T0 - 5000, T0)).toBe('0:00');
  });
});

describe('Z shortcut', () => {
  it('cycles off, 15, 30, 45, 60, 90, off with a readout each time', () => {
    render(<Shortcuts />);
    const seen: (string | undefined)[] = [];
    for (let i = 0; i < 6; i++) {
      key('z');
      seen.push(media.useMediaStore.getState().osd?.secondary);
    }
    expect(seen).toEqual([
      `15 min, Stops at ${clock(T0 + 15 * MIN)}`,
      `30 min, Stops at ${clock(T0 + 30 * MIN)}`,
      `45 min, Stops at ${clock(T0 + 45 * MIN)}`,
      `60 min, Stops at ${clock(T0 + 60 * MIN)}`,
      `90 min, Stops at ${clock(T0 + 90 * MIN)}`,
      'Off',
    ]);
    expect(useSleepTimer.getState().target).toBeNull();
  });

  it('does nothing while typing', () => {
    render(
      <>
        <Shortcuts />
        <input aria-label="search" />
      </>,
    );
    const input = screen.getByRole('textbox', { name: 'search' });
    input.focus();
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    });
    expect(useSleepTimer.getState().target).toBeNull();
  });
});

describe('one-minute warning', () => {
  const mount = (): void => {
    render(
      <>
        <SleepTimerHost />
        <ToastViewport />
      </>,
    );
  };

  it('toasts at T-60 s; Keep watching adds 15 minutes', async () => {
    mount();
    act(() => useSleepTimer.getState().start({ kind: 'minutes', minutes: 15 }));
    await advance(14 * MIN - 1000);
    expect(document.querySelector(`[data-toast-id="${sleep.SLEEP_WARNING_TOAST}"]`)).toBeNull();
    await advance(1000);
    const item = document.querySelector<HTMLElement>(`[data-toast-id="${sleep.SLEEP_WARNING_TOAST}"]`)!;
    expect(item).toBeTruthy();
    expect(item.textContent).toContain('Sleep timer ending');
    expect(item.textContent).toContain('Playback stops in 1:00');
    // The live region gets one fixed sentence, not a ticking countdown.
    expect(document.querySelector('[data-toast-live="polite"]')!.textContent).toContain('Playback stops in under a minute.');
    await advance(5000);
    expect(item.textContent).toContain('Playback stops in 0:55');

    fireEvent.click(within(item).getByRole('button', { name: 'Keep watching (+15 min)' }));
    expect(useSleepTimer.getState().endsAt).toBe(T0 + 30 * MIN);
    await advance(0);
    expect(document.querySelector(`[data-toast-id="${sleep.SLEEP_WARNING_TOAST}"]`)).toBeNull();
  });

  it('Cancel turns the timer off and takes the toast down', async () => {
    mount();
    act(() => useSleepTimer.getState().start({ kind: 'minutes', minutes: 15 }));
    await advance(14 * MIN + 45_000);
    expect(usePlayerStore.getState().volume).toBeLessThan(0.8);
    const item = document.querySelector<HTMLElement>(`[data-toast-id="${sleep.SLEEP_WARNING_TOAST}"]`)!;
    fireEvent.click(within(item).getByTestId('sleep-toast-cancel'));
    await advance(0);
    expect(useSleepTimer.getState().target).toBeNull();
    expect(usePlayerStore.getState().volume).toBe(0.8);
    expect(document.querySelector(`[data-toast-id="${sleep.SLEEP_WARNING_TOAST}"]`)).toBeNull();
  });

  it('ends with "Sleep timer stopped playback"', async () => {
    mount();
    act(() => useSleepTimer.getState().start({ kind: 'minutes', minutes: 15 }));
    await advance(15 * MIN);
    expect(document.querySelector(`[data-toast-id="${sleep.SLEEP_WARNING_TOAST}"]`)).toBeNull();
    const done = document.querySelector<HTMLElement>(`[data-toast-id="${sleep.SLEEP_DONE_TOAST}"]`)!;
    expect(done.textContent).toContain('Sleep timer stopped playback');
    expect(done.textContent).toContain(`Stopped at ${clock(T0 + 15 * MIN)}`);
    expect(usePlayerStore.getState().source).toBeUndefined();
  });

  it('stands in for the toast inside fullscreen, with focus on Keep watching when the player has it', async () => {
    act(() => usePlayerStore.setState({ isFullscreen: true }));
    render(
      <div data-player-host="">
        <button type="button">inside</button>
        <SleepPrompt />
      </div>,
    );
    act(() => screen.getByRole('button', { name: 'inside' }).focus());
    act(() => useSleepTimer.getState().start({ kind: 'minutes', minutes: 15 }));
    expect(screen.queryByTestId('sleep-prompt')).toBeNull();
    await advance(14 * MIN + 30_000);
    const prompt = screen.getByTestId('sleep-prompt');
    expect(prompt.textContent).toContain('Playback stops in 0:30');
    const keep = within(prompt).getByRole('button', { name: 'Keep watching (+15 min)' });
    expect(document.activeElement).toBe(keep);
    fireEvent.click(keep);
    expect(useSleepTimer.getState().endsAt).toBe(T0 + 30 * MIN);
    expect(screen.queryByTestId('sleep-prompt')).toBeNull();
  });

  it('is not drawn windowed (the toast covers that)', async () => {
    render(<SleepPrompt />);
    act(() => useSleepTimer.getState().start({ kind: 'minutes', minutes: 15 }));
    await advance(14 * MIN + 30_000);
    expect(screen.queryByTestId('sleep-prompt')).toBeNull();
  });
});
