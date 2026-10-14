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

const { usePlayerStore, __resetPlayerForTests, DOUBLE_CLICK_MS } = await import('../store');
const { useMediaStore, resetMedia } = await import('../media');
const { usePlaybackShortcuts } = await import('../usePlaybackShortcuts');
const { __resetInputModality, focusIfPlayerOwnsFocus, positionReadout, SEEK_STEP } = await import('../format');
const { PlayerSurface } = await import('./PlayerSurface');
const { Controls, ctlTitle } = await import('./Controls');
const { SeekBar } = await import('./SeekBar');
const { moveKeepingFocus } = await import('./PlayerDock');

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
    act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'playing', positionSeconds: 100, durationSeconds: 600 }));
    render(<Shortcuts />);
    key('ArrowRight');
    expect(usePlayerStore.getState().positionSeconds).toBe(100 + SEEK_STEP);
    expect(useMediaStore.getState().osd).toMatchObject({ primary: 'Forward 10 seconds', secondary: '1:50 / 10:00' });
    key('ArrowLeft');
    expect(useMediaStore.getState().osd).toMatchObject({ primary: 'Back 10 seconds', secondary: '1:40 / 10:00' });
  });

  it('reads live rewind as time behind live', () => {
    act(() => {
      usePlayerStore.setState({ source: live, mode: 'inline', status: 'playing', positionSeconds: 1000, durationSeconds: undefined });
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

describe('large seek and next-item keys', () => {
  it('Shift+arrows seek 30 s', () => {
    act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'playing', positionSeconds: 100, durationSeconds: 600 }));
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
  it('name the matching shortcut without changing the accessible name', () => {
    act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'playing', positionSeconds: 1, durationSeconds: 60 }));
    render(<Controls variant="overlay" visible />);
    const pause = screen.getByRole('button', { name: 'Pause' });
    expect(pause.getAttribute('title')).toBe('Pause (Space)');
    expect(pause.getAttribute('aria-keyshortcuts')).toBe('Space K');
    expect(screen.getByRole('button', { name: 'Fullscreen' }).getAttribute('title')).toBe('Fullscreen (F)');
    expect(screen.getByRole('button', { name: 'Mute' }).getAttribute('title')).toBe('Mute (M)');
    // No made-up shortcut where there is none.
    expect(screen.getByRole('button', { name: 'Stop' }).getAttribute('title')).toBe('Stop');
    expect(ctlTitle('X')).toBe('X');
  });
});

describe('seek bar keys', () => {
  it('step by the same 10 s as the global arrows (Shift: 30 s)', () => {
    const onSeek = vi.fn();
    render(<SeekBar min={0} max={600} value={100} buffered={[]} onSeek={onSeek} />);
    const slider = screen.getByRole('slider');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onSeek).toHaveBeenLastCalledWith(110);
    fireEvent.keyDown(slider, { key: 'ArrowLeft', shiftKey: true });
    expect(onSeek).toHaveBeenLastCalledWith(70);
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
