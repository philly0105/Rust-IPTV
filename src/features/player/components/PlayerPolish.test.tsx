import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import '@/i18n';

vi.mock('@/api/transport', () => ({
  rpc: vi.fn(() => Promise.reject(new Error('offline'))),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));
// The parental gate has its own tests (parentalHook.test.ts); here everything may play.
vi.mock('../parentalHook', () => ({ ensurePlaybackAllowed: async () => true }));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined }));
// The DOM engine itself is not under test here: only the chrome around it.
vi.mock('./InlinePlayer', () => ({ InlinePlayer: () => null }));
// Unchanged behaviour; the bar asks `useNarrow(root)` once per render, so the calls count its renders.
vi.mock('./useNarrow', async (orig) => {
  const real = await orig<typeof import('./useNarrow')>();
  return { ...real, useNarrow: vi.fn(real.useNarrow) };
});

const { useNarrow } = await import('./useNarrow');
const { usePlayerStore, __resetPlayerForTests, DOUBLE_CLICK_MS } = await import('../store');
const { useMediaStore, resetMedia } = await import('../media');
const { usePlaybackShortcuts } = await import('../usePlaybackShortcuts');
const { __resetInputModality, focusIfPlayerOwnsFocus, positionReadout, SEEK_STEP } = await import('../format');
const { PlayerSurface } = await import('./PlayerSurface');
const { Controls, ctlCombo } = await import('./Controls');
const { SeekBar } = await import('./SeekBar');
const { moveKeepingFocus, PlayerDock } = await import('./PlayerDock');
const { toast, TOAST_AVOID_GAP, TOAST_AVOID_SELECTOR, ToastViewport, useToastStore } = await import('@/ui/Toast');

const vod = { url: 'http://h/m.mp4', kind: 'direct' as const, title: 'Movie', isLive: false, isRadio: false };
const live = { url: 'http://h/live.m3u8', kind: 'hls' as const, title: 'News', isLive: true, isRadio: false };

function Shortcuts() {
  usePlaybackShortcuts({ channelPanelAvailable: false });
  return null;
}

const key = (k: string): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
};

const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  __resetPlayerForTests();
  resetMedia();
  __resetInputModality();
  useMediaStore.setState({ osd: undefined });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  __resetPlayerForTests();
  resetMedia();
});

describe('arrow-key seek readout', () => {
  it('shows the step and the new position for VOD', () => {
    act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'playing', dock: 'stage', positionSeconds: 100, durationSeconds: 600 }));
    render(<Shortcuts />);
    key('ArrowRight');
    expect(usePlayerStore.getState().positionSeconds).toBe(100 + SEEK_STEP);
    expect(useMediaStore.getState().osd).toMatchObject({ primary: 'Forward 10 seconds', secondary: '1:50 / 10:00' });
    key('ArrowLeft');
    expect(useMediaStore.getState().osd).toMatchObject({ primary: 'Back 10 seconds', secondary: '1:40 / 10:00' });
  });

  it('reads live rewind as time behind live', () => {
    act(() => {
      usePlayerStore.setState({ source: live, mode: 'inline', status: 'playing', dock: 'stage', positionSeconds: 1000, durationSeconds: undefined });
      useMediaStore.setState({ seekable: { start: 900, end: 1060 } });
    });
    render(<Shortcuts />);
    key('ArrowLeft');
    expect(useMediaStore.getState().osd).toMatchObject({ primary: 'Back 10 seconds', secondary: '1:10 behind live' });
  });

  it('stays silent when a live stream has no rewind window', () => {
    act(() => usePlayerStore.setState({ source: live, mode: 'inline', status: 'playing', positionSeconds: 5 }));
    render(<Shortcuts />);
    key('ArrowLeft');
    expect(useMediaStore.getState().osd).toBeUndefined();
  });
});

describe('page keys while the player is only the mini dock', () => {
  const press = (target: EventTarget, k: string): KeyboardEvent => {
    const e = new KeyboardEvent('keydown', { key: k, code: k === ' ' ? 'Space' : '', bubbles: true, cancelable: true });
    act(() => {
      target.dispatchEvent(e);
    });
    return e;
  };

  it('leaves Space, the arrows and Page Up/Down to the page; letters still work', () => {
    act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'playing', dock: 'mini', positionSeconds: 100, durationSeconds: 600, volume: 0.5 }));
    render(<Shortcuts />);
    for (const k of [' ', 'ArrowRight', 'ArrowUp', 'PageDown']) expect(press(document.body, k).defaultPrevented, k).toBe(false);
    expect(usePlayerStore.getState().status).toBe('playing');
    expect(usePlayerStore.getState().positionSeconds).toBe(100);
    expect(usePlayerStore.getState().volume).toBe(0.5);
    key('m');
    expect(usePlayerStore.getState().muted).toBe(true);
  });

  it('keeps them with focus inside the mini player, and when the player is expanded or fullscreen', () => {
    act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'playing', dock: 'mini', positionSeconds: 100, durationSeconds: 600 }));
    render(<Shortcuts />);
    const mini = document.createElement('div');
    mini.dataset['playerMini'] = '';
    const inside = document.createElement('div');
    inside.tabIndex = 0;
    mini.appendChild(inside);
    document.body.appendChild(mini);
    expect(press(inside, 'ArrowRight').defaultPrevented).toBe(true);
    expect(usePlayerStore.getState().positionSeconds).toBe(100 + SEEK_STEP);
    mini.remove();

    act(() => usePlayerStore.setState({ isFullscreen: true }));
    press(document.body, 'ArrowRight');
    expect(usePlayerStore.getState().positionSeconds).toBe(100 + 2 * SEEK_STEP);
    act(() => usePlayerStore.setState({ isFullscreen: false, dock: 'stage' }));
    press(document.body, ' ');
    expect(usePlayerStore.getState().status).toBe('paused');
  });
});

describe('held keys', () => {
  /** A press, then `repeats` auto-repeat keydowns, as the OS sends for a held key. */
  const hold = (k: string, repeats: number): void => {
    key(k);
    for (let i = 0; i < repeats; i++) {
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: k, repeat: true, bubbles: true }));
      });
    }
  };

  it('a held toggle acts once, a held step keeps stepping', () => {
    act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'playing', positionSeconds: 100, durationSeconds: 600 }));
    render(<Shortcuts />);
    hold('m', 5);
    expect(usePlayerStore.getState().muted).toBe(true);
    hold('k', 5);
    expect(usePlayerStore.getState().status).toBe('paused');
    hold('f', 4);
    expect(usePlayerStore.getState().isFullscreen).toBe(true);
    hold('ArrowRight', 3);
    expect(usePlayerStore.getState().positionSeconds).toBe(100 + 4 * SEEK_STEP);
  });
});

describe('large seek and next-item keys', () => {
  it('Shift+arrows seek 30 s', () => {
    act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'playing', dock: 'stage', positionSeconds: 100, durationSeconds: 600 }));
    render(<Shortcuts />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    });
    expect(usePlayerStore.getState().positionSeconds).toBe(130);
    expect(useMediaStore.getState().osd).toMatchObject({ primary: 'Forward 30 seconds' });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }));
    });
    expect(usePlayerStore.getState().positionSeconds).toBe(100);
  });

  it('N plays the next queue item, and does nothing at the end of the queue', () => {
    const e1 = { ...vod, url: 'http://h/e1.mp4', title: 'Episode 1' };
    const e2 = { ...vod, url: 'http://h/e2.mp4', title: 'Episode 2' };
    act(() => usePlayerStore.setState({ source: e1, queue: [e1, e2], mode: 'inline', status: 'playing' }));
    const next = vi.spyOn(usePlayerStore.getState(), 'next');
    render(<Shortcuts />);
    key('n');
    expect(next).toHaveBeenCalledTimes(1);
    act(() => usePlayerStore.setState({ source: e2 }));
    key('n');
    expect(next).toHaveBeenCalledTimes(1);
    next.mockRestore();
  });
});

describe('seek preview position', () => {
  it('keeps the time label inside the bar at both ends', async () => {
    const { clampTip } = await import('./SeekBar');
    expect(clampTip(0, 400)).toBe(28);
    expect(clampTip(200, 400)).toBe(200);
    expect(clampTip(400, 400)).toBe(372);
    expect(clampTip(10, 40)).toBe(20);
  });

  it('a touch press shows the preview time (touch has no hover)', () => {
    render(<SeekBar min={0} max={600} value={10} buffered={[]} onSeek={() => undefined} />);
    const slider = screen.getByRole('slider');
    slider.setPointerCapture = () => undefined;
    slider.releasePointerCapture = () => undefined;
    fireEvent.pointerDown(slider, { button: 0, pointerId: 1, pointerType: 'touch', clientX: 0 });
    expect(screen.getByTestId('seek-preview')).toBeTruthy();
    fireEvent.pointerUp(slider, { button: 0, pointerId: 1, pointerType: 'touch', clientX: 0 });
    expect(screen.queryByTestId('seek-preview')).toBeNull();
  });
});

describe('up next in the mini player', () => {
  it('fits the compact card: countdown, Play now and Cancel', () => {
    act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'paused', positionSeconds: 60, durationSeconds: 60 }));
    render(
      <div data-player-host="">
        <PlayerSurface compact channelPanelAvailable={false} />
      </div>,
    );
    act(() => useMediaStore.setState({ upNext: { source: { ...vod, url: 'http://h/e2.mp4', title: 'Episode 2' }, deadline: Date.now() + 10_000 } }));
    const card = screen.getByTestId('up-next');
    // A bar across the mini player's bottom edge; the title moves into Play now's tooltip.
    expect(card.textContent).toContain('Starts in 10 s');
    expect(screen.getByRole('button', { name: 'Play now' }).getAttribute('title')).toBe('Episode 2');
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(useMediaStore.getState().upNext).toBeUndefined();
  });
});

describe('positionReadout', () => {
  const t = (k: string, o?: Record<string, unknown>): string => (k === 'live' ? 'Live' : `${String(o?.['time'])} behind`);
  it('formats VOD, live edge and behind live', () => {
    expect(positionReadout(t, { position: 65, duration: 3600 })).toBe('1:05 / 1:00:00');
    expect(positionReadout(t, { position: 99, liveEnd: 100 })).toBe('Live');
    expect(positionReadout(t, { position: 40, liveEnd: 100 })).toBe('1:00 behind');
  });
});

describe('control tooltips', () => {
  it('name the matching shortcut as key caps in a glass tooltip, without changing the accessible name', () => {
    vi.useFakeTimers();
    try {
      act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'playing', positionSeconds: 1, durationSeconds: 60 }));
      render(<Controls variant="overlay" visible />);
      /** Hovers the control and returns its tooltip; leaving it warms the next one up. */
      const tip = (name: string) => {
        const button = screen.getByRole('button', { name });
        // The kit tooltip replaces the OS title box (PL-NATIVE-TOOLTIPS).
        expect(button.hasAttribute('title')).toBe(false);
        fireEvent.mouseEnter(button);
        act(() => vi.advanceTimersByTime(400));
        const el = screen.getByRole('tooltip');
        const out = { text: el.textContent ?? '', keys: [...el.querySelectorAll('kbd')].map((k) => k.textContent), tone: el.dataset['tone'] };
        fireEvent.mouseLeave(button);
        return out;
      };
      const pause = tip('Pause');
      expect(pause.text).toMatch(/^Pause/);
      expect(pause.keys).toEqual(['Space']);
      expect(pause.tone).toBe('glass');
      expect(screen.getByRole('button', { name: 'Pause' }).getAttribute('aria-keyshortcuts')).toBe('Space K');
      expect(tip('Fullscreen').keys).toEqual(['F']);
      expect(tip('Mute').keys).toEqual(['M']);
      // The 10 s skips (PL-BAR-HIERARCHY) name J and L.
      expect(tip('Back 10 seconds').keys).toEqual(['J']);
      expect(tip('Forward 10 seconds').keys).toEqual(['L']);
      // No made-up shortcut where there is none.
      const options = tip('Playback options');
      expect(options.text).toBe('Playback options');
      expect(options.keys).toEqual([]);
      expect(ctlCombo(undefined)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('seek bar keys', () => {
  it('step by the same 10 s as the global arrows (Shift: 30 s)', () => {
    const onSeek = vi.fn();
    render(<SeekBar min={0} max={600} value={100} buffered={[]} onSeek={onSeek} />);
    const slider = screen.getByRole('slider');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    // Steps, which the store coalesces while they repeat (PL-4); Home and End are jumps.
    expect(onSeek).toHaveBeenLastCalledWith(110, true);
    fireEvent.keyDown(slider, { key: 'ArrowLeft', shiftKey: true });
    expect(onSeek).toHaveBeenLastCalledWith(70, true);
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(onSeek).toHaveBeenLastCalledWith(0, false);
  });
});

describe('live rewind bar', () => {
  it('shows the cached window up to the edge and how far back it reaches', () => {
    render(<SeekBar min={900} max={2700} value={2000} buffered={[]} live onSeek={() => undefined} />);
    expect(screen.getByTestId('rewind-depth').textContent).toBe('-30:00');
    const cached = screen.getByTestId('rewind-cached');
    expect(cached.style.left).toMatch(/^61\.1/);
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('11:40 behind live');
  });

  it('VOD bars carry neither', () => {
    render(<SeekBar min={0} max={600} value={10} buffered={[]} onSeek={() => undefined} />);
    expect(screen.queryByTestId('rewind-depth')).toBeNull();
    expect(screen.queryByTestId('rewind-cached')).toBeNull();
  });
});

describe('DOM player overlay timing', () => {
  const hidden = (): boolean => document.querySelector('[data-player-controls]')!.className.includes('opacity-0');

  beforeEach(() => {
    act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'playing', positionSeconds: 1, durationSeconds: 60 }));
  });

  it('the shade above the bar lets the pointer through to what is under it; only the bar takes it (L3-player-7)', () => {
    render(
      <div data-player-host="">
        <PlayerSurface compact={false} channelPanelAvailable={false} />
      </div>,
    );
    const bar = document.querySelector('[data-player-controls]')!;
    expect(screen.getByTestId('overlay-chrome').className).toContain('pointer-events-none');
    expect(bar.className).toContain('pointer-events-none');
    expect(bar.className).toContain('*:pointer-events-auto');
  });

  it('a mouse click that leaves focus on a control does not pin the chrome', async () => {
    vi.useFakeTimers();
    render(
      <div data-player-host="">
        <PlayerSurface compact={false} channelPanelAvailable={false} />
      </div>,
    );
    const pause = screen.getByRole('button', { name: 'Pause' });
    fireEvent.pointerDown(pause);
    act(() => pause.focus());
    await advance(3000);
    expect(hidden()).toBe(true);
  });

  it('keyboard focus on a control keeps the chrome up', async () => {
    vi.useFakeTimers();
    render(
      <div data-player-host="">
        <PlayerSurface compact={false} channelPanelAvailable={false} />
      </div>,
    );
    fireEvent.keyDown(document.body, { key: 'Tab' });
    act(() => screen.getByRole('button', { name: 'Pause' }).focus());
    await advance(3000);
    expect(hidden()).toBe(false);
  });

  it('stays up while the pointer rests on the bar, and hides once it leaves', async () => {
    vi.useFakeTimers();
    render(
      <div data-player-host="">
        <PlayerSurface compact={false} channelPanelAvailable={false} />
      </div>,
    );
    const bar = screen.getByTestId('overlay-chrome');
    fireEvent.pointerEnter(bar);
    await advance(5000);
    expect(hidden()).toBe(false);
    fireEvent.pointerLeave(bar);
    await advance(3000);
    expect(hidden()).toBe(true);
  });
});

describe('resume notice', () => {
  const episode = {
    url: 'http://x/series/e5.mkv',
    kind: 'direct' as const,
    title: 'Show',
    isLive: false,
    isRadio: false,
    ref: { sourceId: 's1', contentType: 'series' as const, itemId: '9' },
    episodeId: 'e5',
  };

  it.each([
    ['a watched episode starts at 0 with no notice', true, undefined],
    ['an unfinished one resumes with the notice', false, 'Resumed at 5:00'],
  ])('%s', async (_name, watched, osd) => {
    const { rpc } = await import('@/api/transport');
    vi.mocked(rpc).mockImplementation((async (name: string) => {
      if (name === 'positions.get') return { ref: episode.ref, episodeId: 'e5', positionSeconds: watched ? 1200 : 300, durationSeconds: 1200, updatedAt: '', watched };
      if (name === 'settings.get') return { player: 'html5' };
      return undefined;
    }) as unknown as typeof rpc);
    const { playSource } = await import('../store');
    render(<PlayerSurface compact={false} channelPanelAvailable={false} />);
    await act(async () => {
      await playSource({ ...episode, resumeSeconds: watched ? 1200 : 300 });
    });
    expect(usePlayerStore.getState().source?.resumeSeconds).toBe(watched ? undefined : 300);
    expect(useMediaStore.getState().osd?.primary).toBe(osd);
  });
});

describe('clicks on the DOM video', () => {
  const surface = (): HTMLElement => document.querySelector<HTMLElement>('[class~="z-[5]"][aria-hidden]')!;
  let ctl: { play: Mock<() => void>; pause: Mock<() => void>; seekTo: Mock<(s: number) => void> };
  let unset: () => void;

  beforeEach(async () => {
    const { setController } = await import('../store');
    // The engine reports status changes by event, later: these calls do not touch `status`.
    ctl = { play: vi.fn<() => void>(), pause: vi.fn<() => void>(), seekTo: vi.fn<(s: number) => void>() };
    unset = setController({ ...ctl, setVolume: vi.fn<(v: number) => void>(), setMuted: vi.fn<(m: boolean) => void>() });
    act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'playing', positionSeconds: 1, durationSeconds: 60 }));
    render(<PlayerSurface compact={false} channelPanelAvailable={false} />);
  });
  afterEach(() => unset());

  it('a click pauses at once, with no wait for a possible double click', () => {
    fireEvent.click(surface(), { detail: 1 });
    expect(ctl.pause).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().isFullscreen).toBe(false);
  });

  it('a tap toggles the controls and never pauses; a mouse click still does', () => {
    const hidden = (): boolean => document.querySelector('[data-player-controls]')!.className.includes('opacity-0');
    const tap = (): void => {
      fireEvent.pointerDown(surface(), { pointerType: 'touch' });
      fireEvent.click(surface(), { detail: 1 });
    };
    expect(hidden()).toBe(false);
    tap();
    expect(hidden()).toBe(true);
    tap();
    expect(hidden()).toBe(false);
    expect(ctl.pause).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().isFullscreen).toBe(false);

    fireEvent.pointerDown(surface(), { pointerType: 'mouse' });
    fireEvent.click(surface(), { detail: 1 });
    expect(ctl.pause).toHaveBeenCalledTimes(1);
  });

  it('a double tap still goes fullscreen', () => {
    fireEvent.pointerDown(surface(), { pointerType: 'touch' });
    fireEvent.click(surface(), { detail: 1 });
    fireEvent.pointerDown(surface(), { pointerType: 'touch' });
    fireEvent.click(surface(), { detail: 2 });
    fireEvent.doubleClick(surface(), { detail: 2 });
    expect(ctl.pause).not.toHaveBeenCalled();
    expect(ctl.play).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().isFullscreen).toBe(true);
  });

  it('a slow (350 ms) double click goes fullscreen and keeps playing', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    fireEvent.click(surface(), { detail: 1 });
    now.mockReturnValue(10_350);
    fireEvent.click(surface(), { detail: 2 });
    fireEvent.doubleClick(surface(), { detail: 2 });
    expect(ctl.pause).toHaveBeenCalledTimes(1);
    expect(ctl.play).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().isFullscreen).toBe(true);
  });

  it('a double click from paused stays paused', () => {
    act(() => usePlayerStore.setState({ status: 'paused' }));
    fireEvent.click(surface(), { detail: 1 });
    fireEvent.doubleClick(surface(), { detail: 2 });
    expect(ctl.play).toHaveBeenCalledTimes(1);
    expect(ctl.pause).toHaveBeenCalledTimes(1);
    expect(ctl.pause.mock.invocationCallOrder[0]!).toBeGreaterThan(ctl.play.mock.invocationCallOrder[0]!);
    expect(usePlayerStore.getState().isFullscreen).toBe(true);
  });

  it.each([
    ['with Up next pending', true],
    ['with no Up next', false],
  ])('on an ended item (%s) a double click only toggles fullscreen; a single click replays after the double-click time', async (_n, pending) => {
    vi.useFakeTimers();
    act(() => {
      usePlayerStore.setState({ status: 'paused', positionSeconds: 60, durationSeconds: 60 });
      if (pending) {
        useMediaStore.setState({ upNext: { source: { ...vod, url: 'http://h/m2.mp4', title: 'Next' }, deadline: Date.now() + 60_000 } });
      }
    });
    // A slow double click (Windows allows up to 900 ms between the clicks).
    fireEvent.click(surface(), { detail: 1 });
    await advance(800);
    fireEvent.click(surface(), { detail: 2 });
    fireEvent.doubleClick(surface(), { detail: 2 });
    await advance(DOUBLE_CLICK_MS);
    expect(ctl.play).not.toHaveBeenCalled();
    expect(ctl.seekTo).not.toHaveBeenCalled();
    expect(usePlayerStore.getState()).toMatchObject({ status: 'paused', positionSeconds: 60, isFullscreen: true });
    expect(!!useMediaStore.getState().upNext).toBe(pending);

    fireEvent.click(surface(), { detail: 1 });
    await advance(DOUBLE_CLICK_MS - 1);
    expect(ctl.play).not.toHaveBeenCalled();
    await advance(1);
    expect(ctl.seekTo).toHaveBeenCalledWith(0);
    expect(ctl.play).toHaveBeenCalledTimes(1);
  });
});

describe('up next focus', () => {
  const next = { ...vod, url: 'http://h/e2.mp4', title: 'Episode 2' };

  it('does not pull focus out of the page when an episode ends in the mini player', () => {
    act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'paused', positionSeconds: 60, durationSeconds: 60 }));
    render(
      <div>
        <input aria-label="Search" />
        <div data-player-host="">
          <PlayerSurface compact channelPanelAvailable={false} />
        </div>
      </div>,
    );
    const field = screen.getByRole('textbox', { name: 'Search' });
    act(() => field.focus());
    act(() => useMediaStore.setState({ upNext: { source: next, deadline: Date.now() + 10_000 } }));
    expect(document.activeElement).toBe(field);
  });

  it('focuses Play now when the player had focus', () => {
    act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'paused', positionSeconds: 60, durationSeconds: 60 }));
    render(
      <div data-player-host="">
        <PlayerSurface compact={false} channelPanelAvailable={false} />
      </div>,
    );
    act(() => useMediaStore.setState({ upNext: { source: next, deadline: Date.now() + 10_000 } }));
    expect(document.activeElement?.textContent).toContain('Play now');
  });
});

describe('up next card', () => {
  it('leads with the episode line and puts the series name on its own quieter line', () => {
    act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'paused', positionSeconds: 60, durationSeconds: 60 }));
    render(
      <div data-player-host="">
        <PlayerSurface compact={false} channelPanelAvailable={false} />
      </div>,
    );
    const episode = { ...vod, url: 'http://h/e2.mp4', title: 'Harbor Lights', subtitle: 'S01E02 · Low Tide' };
    act(() => useMediaStore.setState({ upNext: { source: episode, deadline: Date.now() + 10_000 } }));
    const title = screen.getByTestId('up-next-title');
    const series = screen.getByTestId('up-next-series');
    expect(title.textContent).toBe('S01E02 · Low Tide');
    expect(series.textContent).toBe('Harbor Lights');
    // Two lines, never run together into one; the series is the quieter one.
    expect(title.contains(series)).toBe(false);
    expect(title.tagName).toBe('P');
    expect(series.tagName).toBe('P');
    expect(series.className).toContain('player-on-glass-muted');
    // Hover shows the whole name in reading order.
    expect(title.getAttribute('title')).toBe('S01E02 · Low Tide · Harbor Lights');
  });

  it('a movie has just its title', () => {
    act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'paused', positionSeconds: 60, durationSeconds: 60 }));
    render(
      <div data-player-host="">
        <PlayerSurface compact={false} channelPanelAvailable={false} />
      </div>,
    );
    act(() => useMediaStore.setState({ upNext: { source: { ...vod, url: 'http://h/m2.mp4', title: 'The Sequel' }, deadline: Date.now() + 10_000 } }));
    expect(screen.getByTestId('up-next-title').textContent).toBe('The Sequel');
    expect(screen.queryByTestId('up-next-series')).toBeNull();
  });
});

describe('fullscreen channel panel focus', () => {
  it('gives focus back to the control that had it when the panel closes', async () => {
    const { FullscreenChannelPanel } = await import('./FullscreenChannelPanel');
    act(() =>
      usePlayerStore.setState({ source: { ...live, ref: { sourceId: 's1', itemId: 'c1', kind: 'channel' } } as never, mode: 'inline', status: 'playing' }),
    );
    render(
      <div>
        <button type="button">Before</button>
        <FullscreenChannelPanel available />
      </div>,
    );
    const before = screen.getByRole('button', { name: 'Before' });
    act(() => before.focus());
    act(() => useMediaStore.setState({ channelPanelOpen: true }));
    const search = screen.getByRole('searchbox');
    act(() => search.focus());
    expect(document.activeElement).not.toBe(before);
    act(() => useMediaStore.setState({ channelPanelOpen: false }));
    expect(document.activeElement).toBe(before);
  });
});

describe('fullscreen channel panel from a channel list', () => {
  const ch = (id: string, name: string, sourceId = 's1') => ({ ref: { sourceId, contentType: 'live', itemId: id }, name, isRadio: false });
  const entry = (c: ReturnType<typeof ch>, position: number, available = true) => ({
    ref: c.ref,
    snapshot: { title: c.name },
    channel: available ? c : undefined,
    available,
    position,
    addedAt: '',
  });

  it('lists the list (not the whole source) in its order and plays without leaving the list', async () => {
    const { rpc } = await import('@/api/transport');
    const items = [entry(ch('9', 'Zulu News', 's2'), 0), entry(ch('3', 'Alpha Sport'), 1), entry(ch('5', 'Gone TV'), 2, false)];
    vi.mocked(rpc).mockClear();
    vi.mocked(rpc).mockImplementation((async (name: string) => {
      if (name === 'lists.items') return items;
      if (name === 'settings.get') return { player: 'html5' };
      if (name === 'sources.get') return { id: 's1', kind: 'xtream' };
      if (name === 'epg.nowNext') return {};
      return undefined;
    }) as unknown as typeof rpc);
    const { FullscreenChannelPanel } = await import('./FullscreenChannelPanel');
    act(() =>
      usePlayerStore.setState({
        source: { ...live, ref: { sourceId: 's1', contentType: 'live', itemId: '3' } } as never,
        mode: 'inline',
        status: 'playing',
        zapContext: { sourceId: 's1', listId: 'list-7' },
      }),
    );
    // A real height for the virtual list.
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 0, left: 0, right: 360, bottom: 600, width: 360, height: 600, x: 0, y: 0, toJSON: () => ({}) });
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
    try {
      render(<FullscreenChannelPanel available />);
      await act(async () => {
        useMediaStore.setState({ channelPanelOpen: true });
        await Promise.resolve();
      });
      const names = await vi.waitFor(() => {
        const rows = screen.getAllByRole('option').map((o) => o.textContent ?? '');
        expect(rows.length).toBe(2);
        return rows;
      });
      // List order, across sources; the dropped channel is left out.
      expect(names[0]).toContain('Zulu News');
      expect(names[1]).toContain('Alpha Sport');
      const calls = vi.mocked(rpc).mock.calls.map((c) => c[0]);
      expect(calls).toContain('lists.items');
      expect(calls).not.toContain('catalog.channels');

      fireEvent.click(screen.getByRole('option', { name: /Zulu News/ }));
      await vi.waitFor(() => expect(usePlayerStore.getState().source?.ref?.itemId).toBe('9'));
      expect(usePlayerStore.getState().zapContext?.listId).toBe('list-7');
    } finally {
      rect.mockRestore();
      height.mockRestore();
    }
  });
});

describe('focus across host moves', () => {
  it('moveKeepingFocus puts focus back on the control that was focused', () => {
    const host = document.createElement('div');
    const a = document.createElement('div');
    const b = document.createElement('div');
    const btn = document.createElement('button');
    host.appendChild(btn);
    a.appendChild(host);
    document.body.append(a, b);
    btn.focus();
    moveKeepingFocus(host, b);
    expect(host.parentNode).toBe(b);
    expect(document.activeElement).toBe(btn);
    a.remove();
    b.remove();
  });

  it('focusIfPlayerOwnsFocus never pulls focus out of the page around the player', () => {
    const outside = document.createElement('input');
    const host = document.createElement('div');
    host.dataset['playerHost'] = '';
    const retry = document.createElement('button');
    host.appendChild(retry);
    document.body.append(outside, host);
    outside.focus();
    focusIfPlayerOwnsFocus(retry);
    expect(document.activeElement).toBe(outside);
    outside.blur();
    focusIfPlayerOwnsFocus(retry);
    expect(document.activeElement).toBe(retry);
    outside.remove();
    host.remove();
  });
});

describe('toasts and the docked mini player (L3-player-ui-x1)', () => {
  const box = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

  afterEach(() => {
    act(() => useToastStore.setState({ toasts: [] }));
    vi.restoreAllMocks();
  });

  /** Renders the dock and the toast stack, puts the mini frame in the stack's corner, then shows a toast. */
  function showToastBesideDock(): HTMLElement | null {
    render(
      <>
        <PlayerDock />
        <ToastViewport />
      </>,
    );
    const mini = document.querySelector<HTMLElement>('[role="region"]');
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this === mini) return box(700, 528, 308, 224);
      if (this.tagName === 'SECTION') return box(628, 632, 380, 120);
      return box(0, 0, 0, 0);
    });
    act(() => void toast({ title: 'Added to My List' }));
    return document.querySelector<HTMLElement>('section[data-toast-viewport]');
  }

  it('a toast shown while the mini player is docked sits above it, clear of its controls', () => {
    act(() => usePlayerStore.setState({ source: vod as never, mode: 'inline', status: 'playing', dock: 'mini' }));
    const section = showToastBesideDock();
    const mini = screen.getByRole('region', { name: 'Now playing' });
    expect(mini.matches(TOAST_AVOID_SELECTOR)).toBe(true);
    expect(section?.hasAttribute('data-clearing')).toBe(true);
    expect(section?.style.getPropertyValue('--toast-clear')).toBe(`${window.innerHeight - 528 + TOAST_AVOID_GAP}px`);
  });

  it('with nothing docked the stack keeps its corner', () => {
    const section = showToastBesideDock();
    expect(screen.queryByRole('region', { name: 'Now playing' })).toBeNull();
    expect(section?.hasAttribute('data-clearing')).toBe(false);
  });
});

describe('the mini dock in right-to-left layouts', () => {
  afterEach(() => {
    document.documentElement.dir = 'ltr';
    localStorage.removeItem('player.mini.pos');
  });

  const dragHandle = () => screen.getByRole('button', { name: 'Drag to move the player' });
  const saved = () => JSON.parse(localStorage.getItem('player.mini.pos') ?? 'null') as unknown;

  it('keeps an offset saved under the old `right` name and moves it from the inline-end edge', () => {
    localStorage.setItem('player.mini.pos', JSON.stringify({ right: 40, bottom: 30 }));
    act(() => usePlayerStore.setState({ source: vod as never, mode: 'inline', status: 'playing', dock: 'mini' }));
    render(<PlayerDock />);
    fireEvent.keyDown(dragHandle(), { key: 'ArrowLeft' });
    // LTR: the inline-end edge is the right one, so Left moves away from it.
    expect(saved()).toEqual({ end: 56, bottom: 30 });
  });

  it('in RTL the frame docks at the left (inline-end) edge, so the arrows move it the other way', () => {
    document.documentElement.dir = 'rtl';
    localStorage.setItem('player.mini.pos', JSON.stringify({ end: 40, bottom: 30 }));
    act(() => usePlayerStore.setState({ source: vod as never, mode: 'inline', status: 'playing', dock: 'mini' }));
    render(<PlayerDock />);
    const mini = screen.getByRole('region', { name: 'Now playing' });
    // Logical, not `right`: the browser puts it on the left in RTL, clear of the rail.
    expect(mini.getAttribute('style')).toContain('inset-inline-end: 40px');
    expect(mini.style.right).toBe('');
    fireEvent.keyDown(dragHandle(), { key: 'ArrowLeft' });
    expect(saved()).toEqual({ end: 24, bottom: 30 });
    fireEvent.keyDown(dragHandle(), { key: 'ArrowRight', shiftKey: true });
    expect(saved()).toEqual({ end: 88, bottom: 30 });
  });
});

describe('the surface re-renders without the bar (P2-PLAYER-3)', () => {
  /** The bar's own `useNarrow(root)`; the surface's calls pass a height too. */
  const barRenders = (): number => vi.mocked(useNarrow).mock.calls.filter((args) => args.length === 1).length;
  const mount = (): void => {
    act(() => usePlayerStore.setState({ source: live, mode: 'inline', status: 'playing', dock: 'stage' }));
    render(
      <div data-player-host="">
        <PlayerSurface compact={false} channelPanelAvailable={false} />
      </div>,
    );
  };

  it('a stall coming and going shows the buffering dial and leaves the bar alone', () => {
    mount();
    const before = barRenders();
    act(() => useMediaStore.setState({ waiting: true }));
    expect(screen.getByRole('status', { name: 'Buffering' })).toBeTruthy();
    act(() => useMediaStore.setState({ waiting: false }));
    expect(screen.queryByRole('status', { name: 'Buffering' })).toBeNull();
    expect(barRenders()).toBe(before);
  });

  it('the pointer resting on the bar keeps it up without drawing it again', () => {
    mount();
    const before = barRenders();
    fireEvent.pointerEnter(screen.getByTestId('overlay-chrome'));
    expect(barRenders()).toBe(before);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });
});
