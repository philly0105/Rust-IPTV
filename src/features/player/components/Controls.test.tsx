import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

vi.mock('@/api/transport', () => ({
  rpc: vi.fn(() => Promise.reject(new Error('offline'))),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));

const { usePlayerStore, __resetPlayerForTests } = await import('../store');
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
    expect(screen.getByRole('menuitem', { name: /^sync/i })).toBeTruthy();
    fireEvent.keyDown(menu()!, { key: 'Escape' });
    expect(menu()).toBeNull();
  });

  it('Sync with nothing to adjust keeps focus in the menu, and Escape only leaves the view', () => {
    render(<Controls variant="dock" visible />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /^sync/i }));
    // Built-in player, no subtitles: every step button is disabled; focus goes to Back.
    expect(document.activeElement?.hasAttribute('data-menu-back')).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
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
    expect(screen.getByRole('button', { name: 'Exit picture in picture' }).getAttribute('aria-pressed')).toBe('true');
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

  it('a failed movie offers Retry in the play spot too', () => {
    act(() => usePlayerStore.setState({ status: 'error', error: 'HTTP 500' }));
    render(<Controls variant="overlay" visible />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(commands.retry).toHaveBeenCalledTimes(1);
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

  it('keeps the core controls in the row and moves the rest into the options menu', async () => {
    render(<Controls variant="overlay" visible />);
    for (const name of ['Pause', 'Mute', 'Playback options', 'Fullscreen']) expect(screen.getByRole('button', { name })).toBeTruthy();
    for (const name of ['Stop', 'Picture in picture', 'Take screenshot']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByTestId('volume-readout')).toBeNull();

    openMenu();
    // The camera button loads on demand.
    await screen.findByRole('menuitem', { name: 'Take screenshot' });
    const moved = screen.getByTestId('moved-controls');
    const names = Array.from(moved.querySelectorAll('[role="menuitem"]')).map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual(['Picture in picture', 'Take screenshot', 'Stop']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Picture in picture' }));
    expect(commands.togglePip).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });

  it('keeps the spare buttons the row has room for, most useful first', async () => {
    restore();
    // A row with 100 px to spare, laid out like a flex row: each spare shown takes 42 px of it.
    const spares = (row: Element): number => row.querySelectorAll(':scope > [data-ctl="stop"], :scope > [data-ctl="pip"], :scope > [data-ctl="screenshot"]').length;
    const spies = [
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
        if (this.hasAttribute('data-player-controls')) return 358;
        if (this.hasAttribute('data-row-free')) return Math.max(0, 100 - 42 * spares(this.parentElement!));
        return 0;
      }),
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute('data-ctl-row') ? 330 : 0;
      }),
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute('data-ctl-row') ? 330 + Math.max(0, 42 * spares(this) - 100) : 0;
      }),
    ];
    restore = () => spies.forEach((s) => s.mockRestore());
    const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

    render(<Controls variant="overlay" visible />);
    await frame();
    await frame();
    // Room for two: picture in picture, then stop; the camera goes to the menu.
    expect(screen.getByRole('button', { name: 'Picture in picture' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Take screenshot' })).toBeNull();
    openMenu();
    await screen.findByRole('menuitem', { name: 'Take screenshot' });
    const names = Array.from(screen.getByTestId('moved-controls').querySelectorAll('[role="menuitem"]')).map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual(['Take screenshot']);
  });

  it('a wide player keeps the full row and a menu without moved controls', () => {
    restore();
    render(<Controls variant="overlay" visible />);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Picture in picture' })).toBeTruthy();
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
      const r = this.hasAttribute('data-player-host') ? { top: 0, bottom: 800 } : this.dataset['testid'] === 'player-options-menu' ? { top: 500, bottom: 740 } : { top: 0, bottom: 0 };
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
