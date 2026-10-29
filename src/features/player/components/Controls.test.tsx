import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

vi.mock('@/api/transport', () => ({
  rpc: vi.fn(() => Promise.reject(new Error('offline'))),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));
// Unchanged behaviour; the calls count the bar's own renders (it asks once per render).
vi.mock('./useNarrow', async (orig) => {
  const real = await orig<typeof import('./useNarrow')>();
  return { ...real, useNarrow: vi.fn(real.useNarrow) };
});

// The options icon draws through a counter: the bar's re-renders reuse its icons (P2-PLAYER-4).
vi.mock('lucide-react', async (orig) => {
  const real = await orig<typeof import('lucide-react')>();
  const { createElement } = await import('react');
  return { ...real, Settings2: vi.fn((props: object) => createElement(real.Settings2, props)) };
});

const { Settings2 } = await import('lucide-react');
const { useNarrow } = await import('./useNarrow');
const { usePlayerStore, __resetPlayerForTests, reportProgress } = await import('../store');
const { useMediaStore, resetMedia } = await import('../media');
const { Controls, RecordControl, keepSpares, playerMenuJustClosed } = await import('./Controls');
const { usePipStore } = await import('../pip');

const commands = {
  setQuality: vi.fn(),
  setAudio: vi.fn(),
  setText: vi.fn(),
  setRate: vi.fn(),
  togglePip: vi.fn(),
  retry: vi.fn(),
};

beforeEach(() => {
  __resetPlayerForTests();
  resetMedia();
  vi.clearAllMocks();
  act(() => {
    usePlayerStore.setState({
      source: { url: 'http://v/movie.mp4', kind: 'direct', title: 'Movie', isLive: false, isRadio: false },
      status: 'playing',
      positionSeconds: 10,
      durationSeconds: 600,
    });
    useMediaStore.setState({ commands });
  });
});

afterEach(() => {
  cleanup();
  __resetPlayerForTests();
  resetMedia();
  useMediaStore.setState({ commands: null });
});

const openMenu = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Playback options' }));
};
const menu = (): HTMLElement | null => screen.queryByRole('menu');

describe('Controls options menu', () => {
  it('keeps the seek bar and control row in the dock while the menu is open', () => {
    render(<Controls variant="dock" visible />);
    openMenu();
    expect(menu()).toBeTruthy();
    expect(screen.getByRole('slider', { name: /seek/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /pause/i })).toBeTruthy();

    // The options button in the still-visible row toggles the menu closed.
    openMenu();
    expect(menu()).toBeNull();
  });

  it.each(['dock', 'overlay'] as const)('%s: choosing a speed sets the rate and closes the menu', (variant) => {
    render(<Controls variant={variant} visible />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /playback speed/i }));
    // Submenu navigation keeps the menu open.
    expect(menu()).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitemradio', { name: '1.5x' }));
    expect(commands.setRate).toHaveBeenCalledWith(1.5);
    expect(menu()).toBeNull();
  });

  it.each(['dock', 'overlay'] as const)('%s: the close button closes the menu from any view', (variant) => {
    render(<Controls variant={variant} visible />);
    openMenu();
    // A menu holds only menu items: Close is one too.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close' }));
    expect(menu()).toBeNull();

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /playback speed/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close' }));
    expect(menu()).toBeNull();
    expect(commands.setRate).not.toHaveBeenCalled();
  });

  it('Picture sets the aspect and zoom for every channel; deinterlace only shows for mpv', async () => {
    const { usePictureStore, setPicture, DEFAULT_PICTURE } = await import('../picture');
    render(<Controls variant="dock" visible />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /^picture/i }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: '4:3' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Crop to fill' }));
    // The menu stays open to compare on the picture.
    expect(screen.getByRole('menuitemradio', { name: '4:3' }).getAttribute('aria-checked')).toBe('true');
    expect(usePictureStore.getState()).toMatchObject({ aspect: '4:3', zoom: 'crop' });
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Deinterlace' })).toBeNull();
    act(() => usePlayerStore.setState({ mode: 'embedded-mpv' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Deinterlace' }));
    expect(usePictureStore.getState().deinterlace).toBe(true);
    act(() => setPicture(DEFAULT_PICTURE));
  });

  it('Back returns to the root view and Escape closes the menu', () => {
    render(<Controls variant="dock" visible />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /playback speed/i }));
    // In the submenu, the header's Back carries the view's name.
    fireEvent.click(screen.getByRole('menuitem', { name: /playback speed/i }));
    expect(screen.getByRole('menuitem', { name: /^picture/i })).toBeTruthy();
    fireEvent.keyDown(menu()!, { key: 'Escape' });
    expect(menu()).toBeNull();
  });

  it('leaves Sync out while nothing in it can be changed, and the browser has no audio row (PL-SYNC-DEAD-ROW)', () => {
    render(<Controls variant="dock" visible />);
    openMenu();
    // Built-in player in the browser, no subtitles: no Sync row that opens on disabled rows.
    expect(screen.queryByRole('menuitem', { name: /^sync/i })).toBeNull();
    // A subtitle track (the stream's or a loaded file) brings it back, with the subtitle row only:
    // audio delay needs embedded mpv, which the browser cannot run.
    act(() => {
      useMediaStore.setState({ tracks: { ...useMediaStore.getState().tracks, text: [{ id: '1', label: 'English', selected: true }] } });
    });
    fireEvent.click(screen.getByRole('menuitem', { name: /^sync/i }));
    expect(screen.getByTestId('sync-sub')).toBeTruthy();
    expect(screen.queryByTestId('sync-audio')).toBeNull();
    expect(screen.queryByText('Audio delay works only in the MPV player')).toBeNull();
  });

  it('a view with nothing to focus keeps focus in the menu on Back, and Escape only leaves the view', async () => {
    act(() => {
      useMediaStore.setState({ tracks: { ...useMediaStore.getState().tracks, text: [{ id: '1', label: 'English', selected: true }] } });
    });
    render(<Controls variant="dock" visible />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /^subtitles/i }));
    // The style view holds fields, not menu items: focus goes to its Back.
    fireEvent.click(await screen.findByRole('menuitem', { name: /subtitle style/i }));
    await screen.findByRole('dialog', { name: 'Subtitle style' });
    expect(document.activeElement?.hasAttribute('data-menu-back')).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(menu()).toBeTruthy();
    expect(await screen.findByRole('menuitem', { name: /subtitle style/i })).toBeTruthy();
  });

  // The step buttons carry kit tooltips that show at once on keyboard focus. Escape hides the
  // tooltip and still reaches the menu, which steps back: one press, not two.
  it('Escape on a keyboard-focused step button steps back to the root view on the first press', () => {
    act(() => {
      useMediaStore.setState({ tracks: { ...useMediaStore.getState().tracks, text: [{ id: '1', label: 'English', selected: true }] } });
    });
    render(<Controls variant="dock" visible />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /^sync/i }));
    const earlier = screen.getByTestId('sync-sub').querySelector('button')!;
    // jsdom guesses :focus-visible from earlier events; pin it as a keyboard user's focus.
    const real = earlier.matches.bind(earlier);
    vi.spyOn(earlier, 'matches').mockImplementation((sel: string) => (sel === ':focus-visible' ? document.activeElement === earlier : real(sel)));
    if (document.activeElement === earlier) act(() => earlier.blur());
    act(() => earlier.focus());
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(earlier, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(menu()).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /playback speed/i })).toBeTruthy();
  });

  it('Reset moves focus to the row’s Later button instead of dropping it', () => {
    act(() => {
      useMediaStore.setState({ tracks: { ...useMediaStore.getState().tracks, text: [{ id: '1', label: 'English', selected: true }] } });
    });
    render(<Controls variant="dock" visible />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /^sync/i }));
    const row = screen.getByTestId('sync-sub');
    const [, later, reset] = Array.from(row.querySelectorAll('button'));
    // Focus lands on the first enabled step button (subtitles: Earlier).
    expect(document.activeElement).toBe(row.querySelector('button'));
    fireEvent.click(later!);
    reset!.focus();
    fireEvent.click(reset!);
    expect(reset!.hasAttribute('disabled')).toBe(true);
    expect(document.activeElement).toBe(later);
  });
});

describe('Controls picture-in-picture', () => {
  afterEach(() => usePipStore.setState({ active: false }));

  it('offers picture-in-picture in the mpv dock bar and hides fullscreen while in it', () => {
    act(() => useMediaStore.setState({ canPip: true }));
    const { rerender } = render(<Controls variant="dock" visible />);
    fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
    expect(commands.togglePip).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Fullscreen' })).toBeTruthy();

    act(() => usePipStore.setState({ active: true }));
    rerender(<Controls variant="dock" visible />);
    // Its label says the state, so it is not also a pressed toggle (PL-MENU-A11Y).
    expect(screen.getByRole('button', { name: 'Exit picture in picture' }).getAttribute('aria-pressed')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Fullscreen' })).toBeNull();
  });

  it('keeps the compact dock bar free of the picture-in-picture button', () => {
    act(() => useMediaStore.setState({ canPip: true }));
    render(<Controls variant="dock" visible compact />);
    expect(screen.queryByRole('button', { name: 'Picture in picture' })).toBeNull();
  });
});

describe('Controls live rewind', () => {
  const live = { url: 'http://v/live.ts', kind: 'direct' as const, title: 'News', isLive: true, isRadio: false };

  it('shows a seek bar over the cached window and jumps back to live', () => {
    act(() => {
      usePlayerStore.setState({ source: live, mode: 'embedded-mpv', durationSeconds: undefined, positionSeconds: 1000 });
      useMediaStore.setState({ seekable: { start: 900, end: 1090 } });
    });
    const seekTo = vi.spyOn(usePlayerStore.getState(), 'seekTo');
    render(<Controls variant="dock" visible />);
    expect(screen.getByRole('slider', { name: /seek/i })).toBeTruthy();
    // A readable readout, and a labelled button rather than a bare "-1:30".
    expect(screen.getByTestId('behind-live').textContent).toBe('1:30 behind live');
    expect(screen.getByRole('button', { name: 'Jump to live' }).textContent).toContain('Jump to live');
    fireEvent.click(screen.getByRole('button', { name: 'Jump to live' }));
    // A second short of the cache end, so mpv does not stall waiting for data.
    expect(seekTo).toHaveBeenCalledWith(1089);
    seekTo.mockRestore();
  });

  it('reads as live at the edge and hides the bar until 30 s are cached', () => {
    act(() => {
      usePlayerStore.setState({ source: live, mode: 'embedded-mpv', durationSeconds: undefined, positionSeconds: 1085 });
      useMediaStore.setState({ seekable: { start: 900, end: 1090 } });
    });
    const { rerender } = render(<Controls variant="dock" visible />);
    expect(screen.queryByTestId('behind-live')).toBeNull();
    // At the edge LIVE is a status badge, not a disabled button.
    expect(screen.getByTestId('live-badge').textContent).toBe('Live');
    expect(screen.queryByRole('button', { name: /live/i })).toBeNull();

    act(() => useMediaStore.setState({ seekable: { start: 1070, end: 1090 } }));
    rerender(<Controls variant="dock" visible />);
    expect(screen.queryByRole('slider', { name: /seek/i })).toBeNull();
  });

  it('Jump to live leaves keyboard focus on play/pause, not the page', () => {
    act(() => {
      usePlayerStore.setState({ source: live, mode: 'embedded-mpv', durationSeconds: undefined, positionSeconds: 1000 });
      useMediaStore.setState({ seekable: { start: 900, end: 1090 } });
    });
    render(<Controls variant="dock" visible />);
    const jump = screen.getByRole('button', { name: 'Jump to live' });
    act(() => jump.focus());
    fireEvent.click(jump);
    // The button is gone (LIVE badge at the edge); focus stayed inside the player.
    expect(screen.queryByRole('button', { name: 'Jump to live' })).toBeNull();
    expect(document.activeElement?.getAttribute('data-ctl')).toBe('play');
  });

  it('the behind-live readout and the LIVE badge agree near the edge', () => {
    // 8 s behind on mpv is within its edge slack: LIVE, no "0:08 behind live".
    act(() => {
      usePlayerStore.setState({ source: live, mode: 'embedded-mpv', durationSeconds: undefined, positionSeconds: 1082 });
      useMediaStore.setState({ seekable: { start: 900, end: 1090 } });
    });
    render(<Controls variant="dock" visible />);
    expect(screen.getByTestId('live-badge')).toBeTruthy();
    expect(screen.getByRole('slider', { name: /seek/i }).getAttribute('aria-valuetext')).not.toMatch(/behind/);
    act(() => usePlayerStore.setState({ positionSeconds: 1079 }));
    expect(screen.getByRole('button', { name: 'Jump to live' })).toBeTruthy();
    expect(screen.getByRole('slider', { name: /seek/i }).getAttribute('aria-valuetext')).toMatch(/behind/);
  });
});

describe('Controls re-renders (PB-4)', () => {
  const seek = (): HTMLElement => screen.getByRole('slider', { name: /seek/i });
  const barRenders = (): number => vi.mocked(useNarrow).mock.calls.length;

  it('playback progress re-renders the seek bar and time, not the whole bar', () => {
    render(<Controls variant="overlay" visible />);
    const before = barRenders();
    act(() => {
      usePlayerStore.setState({ positionSeconds: 11 });
      useMediaStore.setState({ buffered: [{ start: 0, end: 30 }] });
    });
    act(() => usePlayerStore.setState({ positionSeconds: 12.5 }));
    expect(seek().getAttribute('aria-valuenow')).toBe('12');
    expect(screen.getByText(/^0:12/)).toBeTruthy();
    expect(barRenders()).toBe(before);
  });

  it('hidden chrome stops following the position and shows the current one when it comes back', () => {
    const { rerender } = render(<Controls variant="overlay" visible={false} />);
    act(() => usePlayerStore.setState({ positionSeconds: 42 }));
    expect(seek().getAttribute('aria-valuenow')).toBe('10');
    rerender(<Controls variant="overlay" visible />);
    expect(seek().getAttribute('aria-valuenow')).toBe('42');
    act(() => usePlayerStore.setState({ positionSeconds: 43 }));
    expect(seek().getAttribute('aria-valuenow')).toBe('43');
  });

  it('live: the go-live readout follows the position on its own too', () => {
    const live = { url: 'http://h/live/1.ts', kind: 'direct' as const, title: 'News', isLive: true, isRadio: false };
    act(() => {
      usePlayerStore.setState({ source: live, durationSeconds: undefined, positionSeconds: 1000 });
      useMediaStore.setState({ seekable: { start: 900, end: 1090 } });
    });
    render(<Controls variant="overlay" visible />);
    const before = barRenders();
    act(() => usePlayerStore.setState({ positionSeconds: 1030 }));
    expect(screen.getByTestId('behind-live').textContent).toBe('1:00 behind live');
    act(() => usePlayerStore.setState({ positionSeconds: 1089 }));
    expect(screen.queryByTestId('behind-live')).toBeNull();
    expect(screen.getByTestId('live-badge')).toBeTruthy();
    expect(barRenders()).toBe(before);
  });

  it("the bar's own re-renders leave its icons as they were drawn (P2-PLAYER-4)", () => {
    const { rerender } = render(<Controls variant="overlay" visible />);
    const drawn = vi.mocked(Settings2).mock.calls.length;
    expect(drawn).toBeGreaterThan(0);
    const before = barRenders();
    rerender(<Controls variant="overlay" visible={false} />);
    act(() => usePlayerStore.setState({ status: 'paused' }));
    expect(barRenders()).toBeGreaterThan(before);
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    expect(vi.mocked(Settings2).mock.calls.length).toBe(drawn);
  });

  it('a report that repeats the last one leaves the store alone', () => {
    const listener = vi.fn();
    const stop = usePlayerStore.subscribe(listener);
    reportProgress(10, 600);
    reportProgress(10);
    expect(listener).not.toHaveBeenCalled();
    reportProgress(11, 600);
    reportProgress(11, 601);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe('Controls volume', () => {
  it('shows the volume as a percent next to the slider', () => {
    act(() => usePlayerStore.setState({ volume: 0.42, muted: false }));
    render(<Controls variant="dock" visible />);
    expect(screen.getByTestId('volume-readout').textContent).toBe('42%');
  });

  it('the compact bar has no room for the readout', () => {
    render(<Controls variant="dock" visible compact />);
    expect(screen.queryByTestId('volume-readout')).toBeNull();
  });

  it('keeps the slider expanded until a drag ends outside it', () => {
    act(() => usePlayerStore.setState({ volume: 0.42, muted: false }));
    const onDragChange = vi.fn();
    render(<Controls variant="dock" visible onVolumeDragChange={onDragChange} />);
    const slider = screen.getByRole('slider', { name: 'Volume' }) as HTMLInputElement;
    const group = slider.closest('[data-vol]')!;
    slider.setPointerCapture = vi.fn();

    fireEvent.pointerDown(slider, { button: 0, pointerId: 7 });
    fireEvent.blur(slider);
    fireEvent.pointerLeave(group);
    expect(group.hasAttribute('data-dragging')).toBe(true);
    expect(usePlayerStore.getState()).toMatchObject({ volume: 0.42, muted: false });
    expect(onDragChange).toHaveBeenCalledWith(true);
    expect(slider.setPointerCapture).not.toHaveBeenCalled();

    fireEvent.change(slider, { target: { value: '62' } });
    expect(usePlayerStore.getState()).toMatchObject({ volume: 0.62, muted: false });
    fireEvent.pointerUp(window, { pointerId: 7 });
    expect(group.hasAttribute('data-dragging')).toBe(false);
    expect(onDragChange).toHaveBeenLastCalledWith(false);
  });
});

describe('Controls live status', () => {
  const live = { url: 'http://v/live.ts', kind: 'direct' as const, title: 'News', isLive: true, isRadio: false };

  it('on air: the red dot pulses a few times, then holds still', () => {
    act(() => usePlayerStore.setState({ source: live, status: 'playing', durationSeconds: undefined }));
    render(<Controls variant="overlay" visible />);
    expect(screen.getByTestId('live-badge').getAttribute('data-state')).toBe('on-air');
    const dot = screen.getByTestId('live-dot');
    expect(dot.className).toContain('animate-live-pulse');
    // Never an endless animation over the video: it keeps the compositor redrawing.
    expect(String(dot.style.animationIterationCount)).toBe('3');
  });

  it('starting: a still, dim dot', () => {
    act(() => usePlayerStore.setState({ source: live, status: 'loading', durationSeconds: undefined }));
    render(<Controls variant="overlay" visible />);
    expect(screen.getByTestId('live-badge').getAttribute('data-state')).toBe('standby');
    expect(screen.getByTestId('live-dot').className).not.toContain('animate');
  });

  it('failed: "No signal" instead of the red badge, and Retry instead of Play', () => {
    act(() => usePlayerStore.setState({ source: live, status: 'error', error: 'HTTP 404', durationSeconds: undefined }));
    render(<Controls variant="dock" visible />);
    const badge = screen.getByTestId('live-badge');
    expect(badge.textContent).toBe('No signal');
    expect(badge.getAttribute('data-state')).toBe('no-signal');
    expect(screen.getByTestId('live-dot').className).not.toMatch(/bg-live|animate/);
    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(commands.retry).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().status).toBe('loading');
    expect(usePlayerStore.getState().error).toBeUndefined();
    // Trying again: back to the plain badge, still, until the stream plays.
    expect(screen.getByTestId('live-badge').getAttribute('data-state')).toBe('standby');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });

  it('a failed stream behind the live edge shows the status, not Jump to live', () => {
    act(() => {
      usePlayerStore.setState({ source: live, mode: 'embedded-mpv', status: 'error', error: 'x', durationSeconds: undefined, positionSeconds: 1000 });
      useMediaStore.setState({ seekable: { start: 900, end: 1090 } });
    });
    render(<Controls variant="dock" visible />);
    expect(screen.getByTestId('live-badge').textContent).toBe('No signal');
    expect(screen.queryByRole('button', { name: 'Jump to live' })).toBeNull();
  });

  it('a failed movie offers Retry in the play spot of the dock bar too', () => {
    act(() => usePlayerStore.setState({ status: 'error', error: 'HTTP 500' }));
    render(<Controls variant="dock" visible />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(commands.retry).toHaveBeenCalledTimes(1);
  });

  it('over the error panel, the overlay bar keeps only what still works: options and fullscreen', () => {
    act(() => {
      usePlayerStore.setState({ source: live, status: 'error', error: 'HTTP 404', durationSeconds: undefined });
      useMediaStore.setState({ canPip: true });
    });
    render(<Controls variant="overlay" visible />);
    // The panel has Retry; the bar has no second one, no volume for nothing, no "No signal" under "did not play".
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: /mute/i })).toBeNull();
    expect(screen.queryByTestId('live-badge')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Picture in picture' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Playback options' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fullscreen' })).toBeTruthy();
    // Trying again brings the whole bar back.
    act(() => usePlayerStore.setState({ status: 'loading', error: undefined }));
    expect(screen.getByTestId('live-badge')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Picture in picture' })).toBeTruthy();
  });
});

describe('RecordControl', () => {
  afterEach(() => vi.useRealTimers());

  it('blinks its dot with the timer tick instead of a CSS animation', () => {
    vi.useFakeTimers({ now: 10_000 });
    act(() => useMediaStore.setState({ mpv: { recording: true, recordPath: 'C:/rec.ts' } as never, recordStartedAt: 10_000 }));
    render(<RecordControl compact />);
    const dot = (): HTMLElement => screen.getByTestId('rec-dot');
    expect(dot().className).not.toContain('animate');
    expect(dot().className).not.toContain('opacity-35');
    act(() => vi.advanceTimersByTime(1000));
    expect(dot().className).toContain('opacity-35');
    act(() => vi.advanceTimersByTime(1000));
    expect(dot().className).not.toContain('opacity-35');
  });
});

describe('Controls menu focus', () => {
  it('Escape closes the menu and puts focus back on Playback options', () => {
    render(<Controls variant="overlay" visible />);
    const trigger = screen.getByRole('button', { name: 'Playback options' });
    act(() => trigger.focus());
    fireEvent.click(trigger);
    expect(menu()!.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    // A page-level Escape (close the player) lets the next key go for a moment.
    expect(playerMenuJustClosed()).toBe(true);
  });

  it('choosing a value leaves focus on the trigger, not the page', () => {
    render(<Controls variant="dock" visible />);
    const trigger = screen.getByRole('button', { name: 'Playback options' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: /playback speed/i }));
    const choice = screen.getByRole('menuitemradio', { name: '1.5x' });
    act(() => choice.focus());
    fireEvent.click(choice);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('Controls for fullscreen live TV', () => {
  const channel = { url: 'http://v/live.ts', kind: 'direct' as const, title: 'News', isLive: true, isRadio: false, ref: { sourceId: 's1', contentType: 'live' as const, itemId: '7' } };

  it('puts channel up, channel down and the channel list on the bar, with their keys', () => {
    act(() => usePlayerStore.setState({ source: channel, status: 'playing', isFullscreen: true, durationSeconds: undefined }));
    render(<Controls variant="overlay" visible channelPanel />);
    expect(screen.getByRole('button', { name: 'Previous channel' }).getAttribute('aria-keyshortcuts')).toBe('PageUp');
    expect(screen.getByRole('button', { name: 'Next channel' }).getAttribute('aria-keyshortcuts')).toBe('PageDown');
    const list = screen.getByRole('button', { name: 'Open channel list' });
    expect(list.getAttribute('aria-keyshortcuts')).toBe('C');
    fireEvent.click(list);
    expect(useMediaStore.getState().channelPanelOpen).toBe(true);
  });

  it('keeps them over a failed stream, where zapping away is the way out', () => {
    act(() => usePlayerStore.setState({ source: channel, status: 'error', error: 'HTTP 404', isFullscreen: true, durationSeconds: undefined }));
    render(<Controls variant="overlay" visible channelPanel />);
    expect(screen.getByRole('button', { name: 'Next channel' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open channel list' })).toBeTruthy();
  });

  it('not outside fullscreen, nor for a movie: the page has its list beside the stage', () => {
    act(() => usePlayerStore.setState({ source: channel, status: 'playing', isFullscreen: false, durationSeconds: undefined }));
    const { unmount } = render(<Controls variant="overlay" visible />);
    expect(screen.queryByRole('button', { name: 'Next channel' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open channel list' })).toBeNull();
    unmount();
    act(() => usePlayerStore.setState({ source: { url: 'http://v/movie.mp4', kind: 'direct', title: 'Movie', isLive: false, isRadio: false }, isFullscreen: true }));
    render(<Controls variant="overlay" visible />);
    expect(screen.queryByRole('button', { name: 'Next channel' })).toBeNull();
  });
});

describe('Controls in a narrow player', () => {
  let restore: () => void = () => undefined;
  beforeEach(() => {
    // jsdom has no layout: give the bar the width of the player on a 390 px phone.
    const spy = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-player-controls') ? 358 : 0;
    });
    restore = () => spy.mockRestore();
    act(() => useMediaStore.setState({ canPip: true }));
  });
  afterEach(() => restore());

  it('keeps the core controls in the row and moves the rest into the options menu', () => {
    render(<Controls variant="overlay" visible />);
    for (const name of ['Pause', 'Mute', 'Playback options', 'Fullscreen']) expect(screen.getByRole('button', { name })).toBeTruthy();
    for (const name of ['Back 10 seconds', 'Picture in picture']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByTestId('volume-readout')).toBeNull();

    openMenu();
    const moved = screen.getByTestId('moved-controls');
    const names = Array.from(moved.querySelectorAll('[role="menuitem"]')).map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual(['Back 10 seconds', 'Forward 10 seconds', 'Picture in picture']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Picture in picture' }));
    expect(commands.togglePip).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });

  it('a narrow fullscreen bar keeps the channel list and moves channel up and down into the menu when they do not fit', () => {
    const channel = { url: 'http://v/live.ts', kind: 'direct' as const, title: 'News', isLive: true, isRadio: false, ref: { sourceId: 's1', contentType: 'live' as const, itemId: '7' } };
    act(() => usePlayerStore.setState({ source: channel, status: 'playing', isFullscreen: true, durationSeconds: undefined }));
    render(<Controls variant="overlay" visible channelPanel />);
    expect(screen.getByRole('button', { name: 'Open channel list' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Next channel' })).toBeNull();
    openMenu();
    const names = Array.from(screen.getByTestId('moved-controls').querySelectorAll('[role="menuitem"]')).map((b) => b.getAttribute('aria-label'));
    expect(names.slice(0, 2)).toEqual(['Previous channel', 'Next channel']);
  });

  it("a narrow fullscreen bar's channel list steps aside while the volume slider is out, from right of the volume", () => {
    const channel = { url: 'http://v/live.ts', kind: 'direct' as const, title: 'News', isLive: true, isRadio: false, ref: { sourceId: 's1', contentType: 'live' as const, itemId: '7' } };
    act(() => usePlayerStore.setState({ source: channel, status: 'playing', isFullscreen: true, durationSeconds: undefined }));
    render(<Controls variant="overlay" visible channelPanel />);
    const list = screen.getByRole('button', { name: 'Open channel list' });
    // The spares' yield class: hidden while the row's volume is hovered or holds focus.
    expect(list.className).toContain('[[data-ctl-row]:has([data-vol]:hover)_&]:hidden');
    expect(list.className).toContain('[[data-ctl-row]:has([data-vol]:focus-within)_&]:hidden');
    // After the volume in the row, so hiding it does not move the volume button.
    const mute = screen.getByRole('button', { name: 'Mute' });
    expect(mute.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('over an error a narrow fullscreen bar keeps channel up and down beside the channel list, at the start', async () => {
    restore();
    // A row with 100 px to spare: room for the channel pair.
    const spares = (row: Element): number => row.querySelectorAll('[data-ctl="channel-up"], [data-ctl="channel-down"]').length;
    const spies = [
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
        if (this.hasAttribute('data-player-controls')) return 358;
        if (this.hasAttribute('data-row-free')) return Math.max(0, 100 - 44 * spares(this.parentElement!));
        return 0;
      }),
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute('data-ctl-row') ? 330 : 0;
      }),
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute('data-ctl-row') ? 330 + Math.max(0, 44 * spares(this) - 100) : 0;
      }),
    ];
    restore = () => spies.forEach((s) => s.mockRestore());
    const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    const channel = { url: 'http://v/live.ts', kind: 'direct' as const, title: 'News', isLive: true, isRadio: false, ref: { sourceId: 's1', contentType: 'live' as const, itemId: '7' } };
    act(() => usePlayerStore.setState({ source: channel, status: 'error', error: 'HTTP 404', isFullscreen: true, durationSeconds: undefined }));
    render(<Controls variant="overlay" visible channelPanel />);
    await frame();
    await frame();
    const row = document.querySelector('[data-ctl-row]')!;
    const order = Array.from(row.children, (el) => el.getAttribute('data-ctl') ?? (el.hasAttribute('data-row-free') ? 'free' : el.querySelector('[data-ctl]')?.getAttribute('data-ctl')));
    expect(order.slice(0, 4)).toEqual(['channels', 'channel-up', 'channel-down', 'free']);
  });

  it('keeps the spare buttons the row has room for, most useful first', () => {
    restore();
    // A row with 100 px to spare, laid out like a flex row: each spare shown takes 44 px of it.
    const spares = (row: Element): number => row.querySelectorAll('[data-ctl="back10"], [data-ctl="fwd10"], [data-ctl="pip"]').length;
    const spies = [
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
        if (this.hasAttribute('data-player-controls')) return 358;
        if (this.hasAttribute('data-row-free')) return Math.max(0, 100 - 44 * spares(this.parentElement!));
        return 0;
      }),
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute('data-ctl-row') ? 330 : 0;
      }),
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute('data-ctl-row') ? 330 + Math.max(0, 44 * spares(this) - 100) : 0;
      }),
    ];
    restore = () => spies.forEach((s) => s.mockRestore());
    const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

    return (async () => {
      render(<Controls variant="overlay" visible />);
      await frame();
      await frame();
      // Room for two: the 10 s skips come first; picture in picture goes to the menu.
      expect(screen.getByRole('button', { name: 'Back 10 seconds' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Forward 10 seconds' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Picture in picture' })).toBeNull();
      openMenu();
      const names = Array.from(screen.getByTestId('moved-controls').querySelectorAll('[role="menuitem"]')).map((b) => b.getAttribute('aria-label'));
      expect(names).toEqual(['Picture in picture']);
    })();
  });

  it("measures the room in the row's ResizeObserver, after layout, not in a frame of its own (P2-PLAYER-1)", async () => {
    /**
     * Calls back only when the test says layout happened, and only for what a browser would report
     * then: a target observed anew (an observation's first report). Nothing here resizes.
     */
    class LayoutObserver {
      static all: LayoutObserver[] = [];
      due = new Set<Element>();
      constructor(private readonly cb: ResizeObserverCallback) {
        LayoutObserver.all.push(this);
      }
      observe(el: Element): void {
        this.due.add(el);
      }
      unobserve(el: Element): void {
        this.due.delete(el);
      }
      disconnect(): void {
        this.due.clear();
      }
      static layout(): void {
        for (const o of LayoutObserver.all) {
          const due = [...o.due];
          o.due.clear();
          if (due.length) o.cb(due.map((target) => ({ target }) as ResizeObserverEntry), o as unknown as ResizeObserver);
        }
      }
    }
    vi.stubGlobal('ResizeObserver', LayoutObserver);
    const reads = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(330);
    const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    try {
      render(<Controls variant="overlay" visible />);
      // The bar's size comes in: a narrow player.
      act(() => LayoutObserver.layout());
      expect(screen.queryByRole('button', { name: 'Back 10 seconds' })).toBeNull();
      // The narrow render asks the row's observer for its room, which comes after layout.
      act(() => LayoutObserver.layout());
      expect(reads).toHaveBeenCalled();
      reads.mockClear();
      // No render since: the row was not observed anew, so nothing calls back or reads.
      act(() => LayoutObserver.layout());
      await frame();
      expect(reads).not.toHaveBeenCalled();
      // A render that changes what the row holds (a caption track) reads nothing itself...
      act(() => useMediaStore.setState({ tracks: { ...useMediaStore.getState().tracks, text: [{ id: '1', label: 'English', selected: false }] } }));
      await frame();
      await frame();
      expect(reads).not.toHaveBeenCalled();
      // ...it observes the row anew, so the row's observer measures once layout is done.
      act(() => LayoutObserver.layout());
      expect(reads).toHaveBeenCalled();
    } finally {
      reads.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('a wide player keeps the full row and a menu without moved controls', () => {
    restore();
    render(<Controls variant="overlay" visible />);
    for (const name of ['Back 10 seconds', 'Forward 10 seconds', 'Picture in picture']) expect(screen.getByRole('button', { name })).toBeTruthy();
    openMenu();
    expect(screen.queryByTestId('moved-controls')).toBeNull();
  });
});

describe('Controls in a phone-size mini player', () => {
  let width = 0;
  beforeEach(() => {
    // jsdom has no layout: the bar is as wide as the mini player's frame.
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-player-controls') ? width : 0;
    });
    act(() => useMediaStore.setState({ canPip: true }));
  });
  afterEach(() => vi.restoreAllMocks());

  it('drops picture-in-picture and the duration under 260 px, so the core controls fit', () => {
    width = 188;
    render(<Controls variant="overlay" visible compact />);
    for (const name of ['Pause', 'Mute', 'Fullscreen']) expect(screen.getByRole('button', { name })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Picture in picture' })).toBeNull();
    expect(document.body.textContent).toContain('0:10');
    expect(document.body.textContent).not.toContain('10:00');
  });

  it("keeps both at the desktop mini player's 280 px", () => {
    width = 278;
    render(<Controls variant="overlay" visible compact />);
    expect(screen.getByRole('button', { name: 'Picture in picture' })).toBeTruthy();
    expect(document.body.textContent).toContain('10:00');
  });
});

describe('Controls dock menus (L3-player-ui-x5)', () => {
  // Was: in the flow of the dock, up to 55 % of the player, which grew the strip embedded mpv
  // reserves and shrank its video (396 to 222 px). A menu now floats over the picture, which mpv
  // leaves out of its native window (role="menu"), so the strip keeps the bar's height.
  it('float above the bar, out of the reserved strip, as tall as the room above them in the player', () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      // The frame the menu hangs from (its bottom edge is the menu's).
      const r = this.hasAttribute('data-player-host') ? { top: 0, bottom: 800 } : this.hasAttribute('data-menu-frame') ? { top: 500, bottom: 740 } : { top: 0, bottom: 0 };
      return { ...r, left: 0, right: 1000, width: 1000, height: r.bottom - r.top, x: 0, y: r.top, toJSON: () => ({}) } as DOMRect;
    });
    try {
      render(
        <div data-player-host="">
          <Controls variant="dock" visible />
        </div>,
      );
      openMenu();
      const m = screen.getByTestId('player-options-menu');
      const pop = m.parentElement!;
      expect(pop.parentElement!.hasAttribute('data-player-controls')).toBe(true);
      expect(pop.className.split(' ')).toContain('absolute');
      expect(pop.className).toContain('bottom-full');
      // From its bottom edge (740 px) up to 8 px under the top of the player.
      expect(m.getAttribute('style') ?? '').toContain('732px');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('keepSpares', () => {
  const groups = [
    ['captions', 0],
    ['pip', 1],
    ['skip', 2],
    ['stop', 1],
    ['screenshot', 1],
    ['history', 1],
  ] as const;

  it('keeps the most useful groups that fit, skipping one too big for what is left', () => {
    expect([...keepSpares(groups, 0)]).toEqual([]);
    expect([...keepSpares(groups, 2)]).toEqual(['pip', 'stop']);
    expect([...keepSpares(groups, 3)]).toEqual(['pip', 'skip']);
    expect([...keepSpares(groups, 6)]).toEqual(['pip', 'skip', 'stop', 'screenshot', 'history']);
  });
});

describe('Controls menus fit the player (review: phone menu, error state, growing bar, history)', () => {
  /** Rects by element: the player host, and the frame a menu hangs from (`data-menu-frame`). */
  let rects: { host: [number, number]; frame: [number, number] };
  /** The ResizeObserver callbacks registered so far. */
  let observed: (() => void)[];
  beforeEach(() => {
    rects = { host: [0, 800], frame: [500, 740] };
    observed = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          observed.push(cb);
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const [top, bottom] = this.hasAttribute('data-player-host') ? rects.host : this.hasAttribute('data-menu-frame') ? rects.frame : [0, 0];
      return { top, bottom, left: 0, right: 600, width: 600, height: bottom - top, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const host = (children: ReactNode) => (
    <div data-player-host="" data-player-focus="" tabIndex={-1}>
      {children}
    </div>
  );

  it('overlay menus open from the top of the bar, also over an error, where the scrim is gone', async () => {
    act(() =>
      usePlayerStore.setState({
        source: { url: 'http://v/live.ts', kind: 'direct', title: 'News', isLive: true, isRadio: false },
        status: 'error',
        error: 'HTTP 404',
      }),
    );
    render(host(<Controls variant="overlay" visible />));
    openMenu();
    const pane = screen.getByTestId('controls-pane');
    const frame = screen.getByTestId('player-options-menu').closest<HTMLElement>('[data-menu-frame]')!;
    // In the pane's box, from its top edge: the same gap above the bar whatever the root's padding.
    expect(frame.parentElement).toBe(pane.parentElement);
    expect(frame.className.split(' ')).toEqual(expect.arrayContaining(['absolute', 'bottom-full', 'mb-2']));
    expect(frame.className).not.toContain('calc(');
    expect(pane.parentElement!.className).toContain('relative');

    // The channel history the same way, with its own cap.
    fireEvent.click(screen.getByRole('menuitem', { name: /channel history/i }));
    const history = await screen.findByTestId('channel-history');
    expect(history.closest('[data-menu-frame]')!.parentElement).toBe(pane.parentElement);
    expect(history.getAttribute('style') ?? '').toContain('732px');
  });

  it('measures the room again when the bar grows under an open menu (the live seek row arriving)', () => {
    render(host(<Controls variant="overlay" visible />));
    openMenu();
    const m = screen.getByTestId('player-options-menu');
    expect(m.getAttribute('style') ?? '').toContain('732px');
    // The bar grew 26 px: the menu's bottom edge moved up with it.
    rects.frame = [474, 714];
    act(() => {
      for (const cb of observed) cb();
    });
    expect(m.getAttribute('style') ?? '').toContain('706px');
  });

  it('a player too short for a popover opens the menu as a sheet from the bottom of the screen', async () => {
    const { bindInputModality } = await import('../format');
    bindInputModality();
    // A phone's 179 px inline player: 62 px between the bar and the top of the stage.
    rects = { host: [60, 239], frame: [120, 130] };
    render(host(<Controls variant="overlay" visible />));
    openMenu();
    const m = screen.getByTestId('player-options-menu');
    expect(m.hasAttribute('data-sheet')).toBe(true);
    // Out of the stage that would clip it, with no cap from the room above the bar.
    expect(m.closest('[data-player-controls]')).toBeNull();
    expect(m.getAttribute('style')).toBeNull();
    expect(m.className.split(' ')).toEqual(expect.arrayContaining(['fixed', 'bottom-0']));
    expect(m.contains(document.activeElement)).toBe(true);
    // Its rows are all there.
    expect(screen.getByRole('menuitem', { name: /subtitles/i })).toBeTruthy();

    // A press on the scrim is not a press outside: the scrim's own click closes the sheet, so the
    // click never lands on the page under it. Focus goes to the player, where Space is play/pause.
    const scrim = document.querySelector<HTMLElement>('[data-menu-scrim]')!;
    fireEvent.pointerDown(scrim);
    expect(menu()).toBeTruthy();
    fireEvent.mouseDown(scrim);
    fireEvent.click(scrim);
    expect(menu()).toBeNull();
    expect(document.querySelector('[data-menu-scrim]')).toBeNull();
    expect(document.activeElement).toBe(document.querySelector('[data-player-focus]'));
  });

  it('the dock bar never turns its menu into a sheet (the native mpv window would cover it)', () => {
    rects = { host: [60, 239], frame: [120, 130] };
    render(host(<Controls variant="dock" visible />));
    openMenu();
    const m = screen.getByTestId('player-options-menu');
    expect(m.hasAttribute('data-sheet')).toBe(false);
    expect(m.closest('[data-player-controls]')).toBeTruthy();
  });

  it('keeps the menu header in view while a long list scrolls', () => {
    render(host(<Controls variant="overlay" visible />));
    openMenu();
    const close = within(screen.getByTestId('player-options-menu')).getByRole('menuitem', { name: 'Close' });
    expect(close.parentElement!.className.split(' ')).toContain('sticky');
  });
});

describe('Controls on a short player (review: the scrim darkened most of a phone picture)', () => {
  it('fades the scrim in over 2rem instead of 4rem', () => {
    const { container, rerender } = render(<Controls variant="overlay" visible />);
    const root = (): HTMLElement => container.querySelector<HTMLElement>('[data-player-controls]')!;
    expect(root().className.split(' ')).toEqual(expect.arrayContaining(['player-scrim-bottom', 'pt-16']));
    rerender(<Controls variant="overlay" visible short />);
    expect(root().className.split(' ')).toEqual(expect.arrayContaining(['player-scrim-bottom', 'player-scrim-compact', 'pt-8']));
    expect(root().className.split(' ')).not.toContain('pt-16');
  });
});

describe('Controls seek row in a right-to-left language (review: times swapped against the fill)', () => {
  it('lays the times and the bar out left to right, as the fill grows', () => {
    render(
      <div dir="rtl">
        <Controls variant="overlay" visible />
      </div>,
    );
    const row = screen.getByTestId('seek-row');
    expect(row.getAttribute('dir')).toBe('ltr');
    // Elapsed first (the left, where the played fill starts), the length last.
    const order = Array.from(row.children).map((el) => el.getAttribute('data-testid') ?? el.getAttribute('role'));
    expect(order).toEqual(['time-elapsed', 'slider', 'time-duration']);
  });
});
