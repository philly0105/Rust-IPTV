/**
 * The player audit's bugs (PL-*): Space after a clicked control, a click away from an open menu,
 * iPhone fullscreen, the live title's programme, the built-in player's right-click menu, the
 * muted autoplay prompt, and the touch double tap.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import '@/i18n';

import { itemKey, type ItemRef } from '@/api/types';

const handlers: Record<string, (args: unknown) => unknown> = {};
vi.mock('@/api/transport', () => ({
  rpc: vi.fn(async (name: string, args: unknown) => {
    const h = handlers[name];
    if (!h) throw new Error(`unmocked rpc ${name}`);
    return h(args);
  }),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('../parentalHook', () => ({ ensurePlaybackAllowed: async () => true }));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined }));
// The DOM engine itself is not under test here: only the chrome around it.
vi.mock('./InlinePlayer', async (orig) => ({ ...(await orig<typeof import('./InlinePlayer')>()), InlinePlayer: () => null }));

const { usePlayerStore, __resetPlayerForTests, setController } = await import('../store');
const { useMediaStore, resetMedia } = await import('../media');
const { usePlaybackShortcuts } = await import('../usePlaybackShortcuts');
const { __resetInputModality } = await import('../format');
const { __resetMenuDismissForTests } = await import('../menuDismiss');
const { PlayerSurface, DOUBLE_TAP_MS } = await import('./PlayerSurface');
const { noteAutoMuted } = await import('./InlinePlayer');
const { Controls } = await import('./Controls');
const { PlayerStage } = await import('./PlayerStage');
const { __resetNowNextForTests, bindLiveProgramme, LIVE_PROGRAMME_CHECK_MS, LIVE_PROGRAMME_IDLE_MS } = await import('../nowNext');

const vod = { url: 'http://h/m.mp4', kind: 'direct' as const, title: 'Movie', isLive: false, isRadio: false };
const liveRef: ItemRef = { sourceId: 's1', contentType: 'live', itemId: '7' };

function Shortcuts() {
  usePlaybackShortcuts({ channelPanelAvailable: false });
  return null;
}

/** The click layer over the video. */
const surface = (): HTMLElement => document.querySelector<HTMLElement>('[class~="z-[5]"][aria-hidden]')!;
const playerRoot = (): HTMLElement => document.querySelector<HTMLElement>('[data-player-focus]')!;

let ctl: { play: Mock<() => void>; pause: Mock<() => void>; seekTo: Mock<(s: number) => void> };
let unset: () => void = () => undefined;

beforeEach(() => {
  __resetPlayerForTests();
  resetMedia();
  __resetInputModality();
  __resetMenuDismissForTests();
  useMediaStore.setState({ osd: undefined, autoMuted: false });
  ctl = { play: vi.fn<() => void>(), pause: vi.fn<() => void>(), seekTo: vi.fn<(s: number) => void>() };
  unset = setController({ ...ctl, setVolume: vi.fn<(v: number) => void>(), setMuted: vi.fn<(m: boolean) => void>() });
  act(() => usePlayerStore.setState({ source: vod, mode: 'inline', status: 'playing', dock: 'stage', positionSeconds: 100, durationSeconds: 600 }));
});

afterEach(() => {
  unset();
  cleanup();
  vi.useRealTimers();
  __resetPlayerForTests();
  resetMedia();
});

describe('PL-SPACE-CLICKED-CONTROL: Space after a mouse click on a control', () => {
  it('a pressed control does not take focus; the player does, and Space is play/pause there', () => {
    render(
      <>
        <Shortcuts />
        <PlayerSurface compact={false} channelPanelAvailable={false} />
      </>,
    );
    const fullscreen = screen.getByRole('button', { name: 'Fullscreen' });
    // fireEvent returns false when the default (focusing the button) was prevented.
    expect(fireEvent.mouseDown(fullscreen, { button: 0 })).toBe(false);
    fireEvent.click(fullscreen);
    expect(usePlayerStore.getState().isFullscreen).toBe(true);
    expect(document.activeElement).toBe(playerRoot());

    const space = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
    act(() => {
      document.activeElement!.dispatchEvent(space);
    });
    expect(ctl.pause).toHaveBeenCalledTimes(1);
    // Space did not press Fullscreen again.
    expect(usePlayerStore.getState().isFullscreen).toBe(true);
  });

  it('keyboard focus on a control still gets its Enter and Space (only the pointer press moves on)', () => {
    render(<PlayerSurface compact={false} channelPanelAvailable={false} />);
    const mute = screen.getByRole('button', { name: 'Mute' });
    act(() => mute.focus());
    expect(document.activeElement).toBe(mute);
  });
});

describe('PL-MENU-OUTSIDE-CLICK: a click on the picture with a menu open', () => {
  it('only closes the options menu: no pause, and its double click does not go fullscreen', () => {
    render(<PlayerSurface compact={false} channelPanelAvailable={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Playback options' }));
    expect(screen.getByRole('menu', { name: 'Playback options' })).toBeTruthy();

    fireEvent.pointerDown(surface(), { button: 0 });
    fireEvent.click(surface(), { detail: 1 });
    expect(screen.queryByRole('menu', { name: 'Playback options' })).toBeNull();
    expect(ctl.pause).not.toHaveBeenCalled();
    fireEvent.click(surface(), { detail: 2 });
    fireEvent.doubleClick(surface(), { detail: 2 });
    expect(usePlayerStore.getState().isFullscreen).toBe(false);

    // The next click is a click again.
    fireEvent.pointerDown(surface(), { button: 0 });
    fireEvent.click(surface(), { detail: 1 });
    expect(ctl.pause).toHaveBeenCalledTimes(1);
  });

  it('a press outside the player closes it too, and does not swallow a later click on the picture', () => {
    render(
      <>
        <button type="button">elsewhere</button>
        <PlayerSurface compact={false} channelPanelAvailable={false} />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Playback options' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'elsewhere' }), { button: 0 });
    expect(screen.queryByRole('menu', { name: 'Playback options' })).toBeNull();
    fireEvent.pointerDown(surface(), { button: 0 });
    fireEvent.click(surface(), { detail: 1 });
    expect(ctl.pause).toHaveBeenCalledTimes(1);
  });
});

describe('PL-NATIVE-CONTEXT-MENU: right click on the built-in player', () => {
  it("opens the player's menu instead of the page's, and a click away only closes it", async () => {
    render(<PlayerSurface compact={false} channelPanelAvailable={false} />);
    expect(fireEvent.contextMenu(surface(), { clientX: 120, clientY: 80 })).toBe(false);
    const menu = await screen.findByTestId('video-context-menu');
    const rows = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((n) => n.textContent);
    // The same rows as embedded mpv's, Picture and (VOD) Speed included.
    expect(rows).toContain('Picture');
    expect(rows).toContain('Playback speedNormal');

    fireEvent.pointerDown(surface(), { button: 0 });
    fireEvent.click(surface(), { detail: 1 });
    expect(screen.queryByTestId('video-context-menu')).toBeNull();
    expect(ctl.pause).not.toHaveBeenCalled();
  });
});

describe('PL-IOS-FULLSCREEN: no element fullscreen (iPhone Safari)', () => {
  it('the video goes fullscreen in the system player and the store flag stays off', () => {
    const video = document.createElement('video');
    video.setAttribute('data-player-video', '');
    const enter = vi.fn();
    Object.assign(video, { webkitEnterFullscreen: enter });
    document.body.appendChild(video);
    try {
      expect(typeof document.documentElement.requestFullscreen).not.toBe('function');
      usePlayerStore.getState().toggleFullscreen();
      expect(enter).toHaveBeenCalledTimes(1);
      expect(usePlayerStore.getState().isFullscreen).toBe(false);
    } finally {
      video.remove();
    }
  });

  it('elsewhere the store flag drives fullscreen as before', () => {
    usePlayerStore.getState().toggleFullscreen();
    expect(usePlayerStore.getState().isFullscreen).toBe(true);
  });
});

describe('PL-MUTED-AUTOPLAY: a start the browser muted', () => {
  it('offers to unmute until sound is back, by the prompt or any other way', () => {
    render(<PlayerSurface compact={false} channelPanelAvailable={false} />);
    expect(screen.queryByTestId('unmute-prompt')).toBeNull();
    act(() => {
      usePlayerStore.setState({ muted: true });
      noteAutoMuted();
    });
    const prompt = screen.getByTestId('unmute-prompt');
    expect(prompt.textContent).toContain('Click to unmute');
    expect(prompt.textContent).toContain('Tap to unmute');
    fireEvent.click(prompt);
    expect(usePlayerStore.getState().muted).toBe(false);
    expect(useMediaStore.getState().autoMuted).toBe(false);
    expect(screen.queryByTestId('unmute-prompt')).toBeNull();
    // A click on it never reached the picture.
    expect(ctl.pause).not.toHaveBeenCalled();

    act(() => {
      usePlayerStore.setState({ muted: true });
      noteAutoMuted();
    });
    expect(screen.getByTestId('unmute-prompt')).toBeTruthy();
    act(() => usePlayerStore.getState().setVolume(0.6));
    expect(useMediaStore.getState().autoMuted).toBe(false);
    expect(screen.queryByTestId('unmute-prompt')).toBeNull();
  });

  it('a mute the person chose shows no prompt', () => {
    render(<PlayerSurface compact={false} channelPanelAvailable={false} />);
    act(() => usePlayerStore.getState().toggleMute());
    expect(usePlayerStore.getState().muted).toBe(true);
    expect(screen.queryByTestId('unmute-prompt')).toBeNull();
  });
});

describe('PL-TOUCH-ERGONOMICS: double tap on a side of the picture', () => {
  const tapAt = (x: number, detail = 1): void => {
    fireEvent.pointerDown(surface(), { pointerType: 'touch' });
    fireEvent.click(surface(), { detail, clientX: x, clientY: 50 });
  };
  let restoreRect: () => void = () => undefined;
  beforeEach(() => {
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const w = this.hasAttribute('data-player-focus') ? 300 : 0;
      return { left: 0, top: 0, right: w, bottom: 170, width: w, height: 170, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    restoreRect = () => spy.mockRestore();
  });
  afterEach(() => restoreRect());

  it('steps 10 s back or ahead, shows how far, and never goes fullscreen', () => {
    render(<PlayerSurface compact={false} channelPanelAvailable={false} />);
    tapAt(280);
    tapAt(280, 2);
    fireEvent.doubleClick(surface(), { detail: 2 });
    expect(usePlayerStore.getState().positionSeconds).toBe(110);
    expect(screen.getByTestId('tap-seek').getAttribute('data-side')).toBe('forward');
    expect(usePlayerStore.getState().isFullscreen).toBe(false);
    expect(ctl.pause).not.toHaveBeenCalled();

    tapAt(20);
    tapAt(20, 2);
    expect(usePlayerStore.getState().positionSeconds).toBe(100);
    expect(screen.getByTestId('tap-seek').getAttribute('data-side')).toBe('back');
  });

  it('two taps far apart in time are two taps (the controls toggle)', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    render(<PlayerSurface compact={false} channelPanelAvailable={false} />);
    tapAt(280);
    now.mockReturnValue(10_000 + DOUBLE_TAP_MS + 50);
    tapAt(280);
    expect(usePlayerStore.getState().positionSeconds).toBe(100);
    expect(screen.queryByTestId('tap-seek')).toBeNull();
    now.mockRestore();
  });

  it('live without a rewind window does not seek', () => {
    act(() => usePlayerStore.setState({ source: { ...vod, isLive: true, url: 'http://h/live.m3u8' }, durationSeconds: undefined }));
    render(<PlayerSurface compact={false} channelPanelAvailable={false} />);
    tapAt(280);
    tapAt(280, 2);
    expect(usePlayerStore.getState().positionSeconds).toBe(100);
  });
});

describe('PL-STALE-PROGRAMME: the live subtitle follows what airs', () => {
  it('patches the subtitle when the airing programme changes, keeping the same media', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-20T10:00:00Z'), toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    __resetNowNextForTests();
    handlers['settings.get'] = () => ({});
    const show = (title: string, start: string, end: string) => ({ title, start, end, channelId: 'c7' });
    let guide = { now: show('Morning News', '2026-10-20T09:30:00Z', '2026-10-20T10:00:30Z'), next: show('Weather', '2026-10-20T10:00:30Z', '2026-10-20T10:30:00Z') };
    handlers['epg.nowNext'] = () => ({ [itemKey(liveRef)]: guide });
    const source = { url: 'http://h/live/7.ts', kind: 'direct' as const, title: 'News 7', isLive: true, isRadio: false, ref: liveRef, subtitle: 'Morning News' };
    act(() => usePlayerStore.setState({ source, status: 'playing' }));
    const unbind = bindLiveProgramme();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LIVE_PROGRAMME_CHECK_MS);
      });
      const after = usePlayerStore.getState().source!;
      expect(after.subtitle).toBe('Weather');
      expect(after.url).toBe(source.url);
      // A guide with nothing airing leaves it.
      guide = { now: undefined, next: undefined } as never;
      __resetNowNextForTests();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LIVE_PROGRAMME_CHECK_MS * 70);
      });
      expect(usePlayerStore.getState().source!.subtitle).toBe('Weather');
    } finally {
      unbind();
    }
  });
});

describe('the live programme follower asks the guide once per programme', () => {
  const at = (hhmm: string): string => `2026-10-20T${hhmm}:00Z`;
  const show = (title: string, start: string, end: string) => ({ title, start: at(start), end: at(end), channelId: 'c7' });
  const source = { url: 'http://h/live/7.ts', kind: 'direct' as const, title: 'News 7', isLive: true, isRadio: false, ref: liveRef, subtitle: 'Morning News' };
  let asked = 0;
  let unbind: () => void = () => undefined;

  /** Plays the channel and follows it, the guide answering `guide()`. */
  function follow(guide: () => unknown): void {
    handlers['settings.get'] = () => ({});
    handlers['epg.nowNext'] = () => {
      asked += 1;
      return { [itemKey(liveRef)]: guide() };
    };
    handlers['epg.shortEpg'] = () => [];
    act(() => usePlayerStore.setState({ source, status: 'playing' }));
    unbind = bindLiveProgramme();
  }
  const advance = async (minutes: number): Promise<void> => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(minutes * 60_000);
    });
  };
  const subtitle = (): string | undefined => usePlayerStore.getState().source?.subtitle;

  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse(at('10:00')), toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    __resetNowNextForTests();
    asked = 0;
  });
  afterEach(() => unbind());

  it('keeps the answer while a programme in it airs, past the 60 s cache, and asks again once they ended', async () => {
    follow(() => {
      const now = Date.now();
      if (now < Date.parse(at('11:00'))) return { now: show('Morning News', '09:30', '11:00'), next: show('Weather', '11:00', '11:30') };
      if (now < Date.parse(at('11:30'))) return { now: show('Weather', '11:00', '11:30'), next: show('Late Show', '11:30', '12:30') };
      return { now: show('Late Show', '11:30', '12:30') };
    });
    // 90 checks in 45 minutes; only the first asks (every third used to, when the 60 s cache ran out).
    await advance(45);
    expect(asked).toBe(1);
    expect(subtitle()).toBe('Morning News');
    // The answer's next took over at 11:00 without a request.
    await advance(20);
    expect(asked).toBe(1);
    expect(subtitle()).toBe('Weather');
    // At 11:30 both programmes it knew had ended: one request.
    await advance(35);
    expect(asked).toBe(2);
    expect(subtitle()).toBe('Late Show');
  });

  it('asks a guide with nothing on the channel again every few minutes, not on every check', async () => {
    follow(() => undefined);
    await advance(30);
    // Once, then once per LIVE_PROGRAMME_IDLE_MS.
    expect(asked).toBeGreaterThan(1);
    expect(asked).toBeLessThanOrEqual(1 + (30 * 60_000) / LIVE_PROGRAMME_IDLE_MS);
  });
});

describe('PL-BAR-HIERARCHY: the redesigned bar', () => {
  const commands = { setQuality: vi.fn(), setAudio: vi.fn(), setText: vi.fn(), setRate: vi.fn(), togglePip: vi.fn(), retry: vi.fn() };
  beforeEach(() => {
    act(() => useMediaStore.setState({ commands }));
  });

  it('is one toolbar with a large play/pause, 10 s skips for VOD and the times at the seek bar’s ends', () => {
    render(<Controls variant="overlay" visible />);
    expect(screen.getByRole('toolbar', { name: 'Player controls' })).toBeTruthy();
    const play = screen.getByRole('button', { name: 'Pause' });
    expect(play.className).toContain('size-12');
    expect(screen.getByRole('button', { name: 'Mute' }).className).toContain('size-10');
    fireEvent.click(screen.getByRole('button', { name: 'Forward 10 seconds' }));
    expect(usePlayerStore.getState().positionSeconds).toBe(110);
    fireEvent.click(screen.getByRole('button', { name: 'Back 10 seconds' }));
    expect(usePlayerStore.getState().positionSeconds).toBe(100);
    expect(screen.getByTestId('time-elapsed').textContent).toBe('1:40');
    expect(screen.getByTestId('time-duration').textContent).toBe('10:00');
  });

  it('live has no skips and one live mark', () => {
    act(() => usePlayerStore.setState({ source: { ...vod, isLive: true, url: 'http://h/live.m3u8' }, durationSeconds: undefined }));
    render(<Controls variant="overlay" visible />);
    expect(screen.queryByRole('button', { name: 'Back 10 seconds' })).toBeNull();
    expect(screen.getAllByTestId('live-badge')).toHaveLength(1);
  });

  it('keeps Stop, the screenshot and channel history in the options menu, with their keys', () => {
    act(() => usePlayerStore.setState({ source: { ...vod, isLive: true, url: 'http://h/live.m3u8' }, durationSeconds: undefined }));
    render(<Controls variant="overlay" visible />);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Playback options' }));
    expect(screen.getByRole('menuitem', { name: 'Take screenshot' }).getAttribute('aria-keyshortcuts')).toBe('S');
    expect(screen.getByRole('menuitem', { name: 'Channel history' }).getAttribute('aria-keyshortcuts')).toBe('Shift+B');
    // The keys are glass key caps, one per key, so a lone letter does not read as a divider.
    const caps = (name: string) =>
      Array.from(screen.getByRole('menuitem', { name }).querySelectorAll('[data-menu-hint] kbd')).map((k) => k.textContent);
    expect(caps('Take screenshot')).toEqual(['S']);
    expect(caps('Channel history')).toEqual(['Shift', 'B']);
    expect(screen.getByRole('menuitem', { name: 'Take screenshot' }).querySelector('kbd')!.className).toContain('bg-white/10');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop' }));
    expect(usePlayerStore.getState().source).toBeUndefined();
  });

  it('grows its controls in fullscreen', () => {
    act(() => usePlayerStore.setState({ isFullscreen: true }));
    render(<Controls variant="overlay" visible />);
    expect(document.querySelector('[data-player-controls]')!.hasAttribute('data-big')).toBe(true);
    expect(screen.getByRole('button', { name: 'Pause' }).className).toContain('size-16');
  });
});

describe('PL-MENU-A11Y: menu buttons and toggles', () => {

  it('Playback options is a menu button that says whether it is open, and controls the menu', () => {
    render(<Controls variant="overlay" visible />);
    const options = screen.getByRole('button', { name: 'Playback options' });
    expect(options.getAttribute('aria-haspopup')).toBe('menu');
    expect(options.getAttribute('aria-expanded')).toBe('false');
    expect(options.hasAttribute('aria-pressed')).toBe(false);
    fireEvent.click(options);
    expect(options.getAttribute('aria-expanded')).toBe('true');
    expect(options.getAttribute('aria-controls')).toBe(screen.getByRole('menu').id);
  });

  it('Captions keeps one name and says on or off with aria-pressed', () => {
    act(() => useMediaStore.setState({ tracks: { ...useMediaStore.getState().tracks, text: [{ id: '1', label: 'English', selected: true }] } }));
    render(<Controls variant="overlay" visible />);
    expect(screen.getByRole('button', { name: 'Captions' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('PL-DUPLICATE-CHROME: a stage that heads itself', () => {
  it('marks the stage so the player drops its own title bar outside fullscreen', () => {
    const { container, rerender } = render(<PlayerStage showTitle={false} />);
    expect(container.querySelector('[data-player-stage]')!.getAttribute('data-stage-title')).toBe('off');
    rerender(<PlayerStage />);
    expect(container.querySelector('[data-player-stage]')!.hasAttribute('data-stage-title')).toBe(false);
  });

  it('the live title bar carries no LIVE pill: the bar’s badge is the one live mark', () => {
    act(() => usePlayerStore.setState({ source: { ...vod, isLive: true, url: 'http://h/live.m3u8', ref: liveRef }, durationSeconds: undefined }));
    handlers['settings.get'] = () => ({});
    handlers['epg.nowNext'] = () => ({});
    handlers['catalog.item'] = () => ({});
    render(<PlayerSurface compact={false} channelPanelAvailable={false} />);
    const bar = screen.getByTestId('player-titlebar');
    expect(bar.textContent).not.toMatch(/live/i);
    expect(screen.getAllByTestId('live-badge')).toHaveLength(1);
  });
});

describe('stage 2 polish: the chrome around errors, menus and the zap banner', () => {
  it('over a failed stream the bar lays no scrim over the error screen’s buttons', () => {
    const { rerender } = render(<Controls variant="overlay" visible />);
    const root = (): HTMLElement => document.querySelector<HTMLElement>('[data-player-controls]')!;
    expect(root().className).toContain('player-scrim-bottom');
    act(() => usePlayerStore.setState({ status: 'error', error: 'HTTP 404' }));
    rerender(<Controls variant="overlay" visible />);
    expect(root().className).not.toContain('player-scrim-bottom');
  });

  it('opening the options menu takes the zap banner down', async () => {
    const { showZapBanner, useZapBanner } = await import('../zapBanner');
    act(() => usePlayerStore.setState({ source: { ...vod, isLive: true, url: 'http://h/live.m3u8', ref: liveRef }, durationSeconds: undefined }));
    handlers['settings.get'] = () => ({});
    handlers['epg.nowNext'] = () => ({});
    handlers['catalog.item'] = () => ({});
    render(<PlayerSurface compact={false} channelPanelAvailable={false} />);
    act(() => showZapBanner());
    expect(useZapBanner.getState().visible).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Playback options' }));
    expect(useZapBanner.getState().visible).toBe(false);
  });

  it('a submenu opens at its top, whatever the root view was scrolled to', () => {
    render(<Controls variant="overlay" visible />);
    fireEvent.click(screen.getByRole('button', { name: 'Playback options' }));
    const menu = screen.getByTestId('player-options-menu');
    menu.scrollTop = 120;
    fireEvent.click(screen.getByRole('menuitem', { name: /^picture/i }));
    expect(menu.scrollTop).toBe(0);
  });

  it('a menu cut short by a short stage fades out along its bottom edge until scrolled to its end', () => {
    render(<Controls variant="overlay" visible />);
    fireEvent.click(screen.getByRole('button', { name: 'Playback options' }));
    const menu = screen.getByTestId('player-options-menu');
    // jsdom has no layout: say the rows run 200 px past the bottom edge.
    Object.defineProperty(menu, 'scrollHeight', { configurable: true, value: 420 });
    Object.defineProperty(menu, 'clientHeight', { configurable: true, value: 220 });
    fireEvent.scroll(menu);
    expect(screen.getByTestId('menu-more')).toBeTruthy();
    menu.scrollTop = 200;
    fireEvent.scroll(menu);
    expect(screen.queryByTestId('menu-more')).toBeNull();
  });
});

describe('PL-TOUCH-ERGONOMICS: the seek bar under a coarse pointer', () => {
  it('grows its hit area to 36 px and its thumb to 16 px around the same 4 px track', async () => {
    const { SeekBar } = await import('./SeekBar');
    render(<SeekBar min={0} max={600} value={100} buffered={[]} onSeek={() => undefined} />);
    const slider = screen.getByRole('slider', { name: 'Seek' });
    expect(slider.className).toContain('h-6');
    expect(slider.className).toContain('pointer-coarse:h-9');
    expect(screen.getByTestId('seek-thumb').className).toContain('pointer-coarse:size-4');
    // The track itself stays 4 px (it thickens to 6 px under the pointer, not under the finger's hit area).
    expect((slider.firstElementChild as HTMLElement).className).toMatch(/(^| )h-1( |$)/);
  });
});

describe('short players: Up next and the end of a movie fit above the bar', () => {
  /** A phone's 16:9 player: 320 x 180. */
  const phoneSized = (): void => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(320);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(180);
  };
  afterEach(() => vi.restoreAllMocks());

  it('Up next is one line across the top that still names the episode', () => {
    phoneSized();
    act(() => usePlayerStore.setState({ status: 'paused', positionSeconds: 600, durationSeconds: 600 }));
    render(<PlayerSurface compact={false} channelPanelAvailable={false} />);
    const episode = { ...vod, url: 'http://h/e2.mp4', title: 'Harbor Lights', subtitle: 'S01E02 · Low Tide' };
    act(() => useMediaStore.setState({ upNext: { source: episode, deadline: Date.now() + 10_000 } }));
    const card = screen.getByTestId('up-next');
    expect(card.className).toContain('top-0');
    expect(card.className).not.toContain('bottom-28');
    expect(screen.getByTestId('up-next-title').textContent).toBe('S01E02 · Low Tide');
    expect(screen.getByRole('button', { name: 'Play now' })).toBeTruthy();
  });

  it('the replay disc drops its label and sits under the title bar', () => {
    phoneSized();
    act(() => usePlayerStore.setState({ status: 'paused', positionSeconds: 600, durationSeconds: 600 }));
    render(<PlayerSurface compact={false} channelPanelAvailable={false} />);
    const overlay = screen.getByTestId('ended-overlay');
    // Under the title bar (z-10), over the click layer (z-[5]).
    expect(overlay.className).toContain('z-[8]');
    const replay = overlay.querySelector('button')!;
    expect(replay.getAttribute('aria-label')).toBe('Replay');
    expect(replay.textContent).toBe('');
  });
});

describe('a short player gives its end of item the whole height', () => {
  afterEach(() => vi.restoreAllMocks());

  it('hides its title bar while the replay disc or Up next is up', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(320);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(180);
    render(<PlayerSurface compact={false} channelPanelAvailable={false} />);
    const title = (): string => screen.getByTestId('player-titlebar').className;
    act(() => usePlayerStore.setState({ status: 'paused', positionSeconds: 100 }));
    expect(title()).not.toContain('opacity-0');
    act(() => usePlayerStore.setState({ positionSeconds: 600 }));
    expect(title()).toContain('opacity-0');
  });
});
