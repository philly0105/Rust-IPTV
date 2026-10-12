import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

vi.mock('@/api/transport', () => ({
  rpc: vi.fn(() => Promise.reject(new Error('offline'))),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined }));
// The DOM engine itself is not under test here: only the chrome around it.
vi.mock('./InlinePlayer', () => ({ InlinePlayer: () => null }));

const { usePlayerStore, __resetPlayerForTests } = await import('../store');
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
