/**
 * Media keys and the system's media controls (L3-desktop-5): the keyboard's play/pause, stop and
 * track keys drive the player, and `navigator.mediaSession` mirrors what plays and offers the
 * buttons that apply (next and previous only where there is a neighbour or a queue).
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

vi.mock('@/api/transport', () => ({
  rpc: vi.fn(() => Promise.reject(new Error('offline'))),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined }));

const { usePlayerStore, __resetPlayerForTests } = await import('./store');
const { usePlaybackShortcuts } = await import('./usePlaybackShortcuts');
const { shortcutRegistry } = await import('@/shell/shortcuts');
const { bindMediaSession } = await import('./mediaSession');

function Shortcuts() {
  usePlaybackShortcuts({ channelPanelAvailable: false });
  return null;
}

const movie = { url: 'http://h/m.mp4', kind: 'direct' as const, title: 'Movie', isLive: false, isRadio: false };
const live = {
  url: 'http://h/live/101.m3u8',
  kind: 'hls' as const,
  title: 'Channel 1',
  subtitle: 'News at Nine',
  isLive: true,
  isRadio: false,
  ref: { sourceId: 's1', contentType: 'live' as const, itemId: '101' },
};

const press = (key: string): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
  });
};

beforeEach(() => __resetPlayerForTests());
afterEach(() => {
  cleanup();
  __resetPlayerForTests();
});

describe('media keys', () => {
  it('play/pause and stop act on what plays, and are listed with the playback keys', () => {
    render(<Shortcuts />);
    act(() => usePlayerStore.setState({ source: movie, mode: 'inline', status: 'playing' }));
    const combos = shortcutRegistry
      .list()
      .filter((s) => s.area === 'Playback')
      .map((s) => s.combo);
    expect(combos).toEqual(expect.arrayContaining(['mediaplaypause', 'mediastop']));
    // Nothing to step to: no track keys.
    expect(combos).not.toContain('mediatracknext');

    press('MediaPlayPause');
    expect(usePlayerStore.getState().status).toBe('paused');
    press('MediaPlayPause');
    expect(usePlayerStore.getState().status).toBe('playing');
    press('MediaStop');
    expect(usePlayerStore.getState().source).toBeUndefined();
  });

  it('the track keys are offered on live TV, where they change channel', () => {
    render(<Shortcuts />);
    act(() => usePlayerStore.setState({ source: live, mode: 'inline', status: 'playing' }));
    const combos = shortcutRegistry
      .list()
      .filter((s) => s.area === 'Playback')
      .map((s) => s.combo);
    expect(combos).toEqual(expect.arrayContaining(['mediatracknext', 'mediatrackprevious']));
  });
});

describe('the system media session', () => {
  const actions = new Map<string, (() => void) | null>();
  const session = {
    metadata: null as unknown,
    playbackState: 'none' as string,
    setActionHandler: (a: string, h: (() => void) | null) => void actions.set(a, h),
  };
  class Metadata {
    constructor(readonly init: { title: string; artist: string }) {}
  }

  beforeEach(() => {
    actions.clear();
    session.metadata = null;
    session.playbackState = 'none';
    Object.defineProperty(navigator, 'mediaSession', { value: session, configurable: true });
    vi.stubGlobal('MediaMetadata', Metadata);
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'mediaSession');
    vi.unstubAllGlobals();
  });

  it('mirrors the playing channel and routes the buttons, then clears everything when unbound', () => {
    const buttons = { togglePlay: vi.fn(), stop: vi.fn(), next: vi.fn(), previous: vi.fn() };
    const unbind = bindMediaSession(() => buttons);
    expect(session.playbackState).toBe('none');
    expect(actions.get('play') ?? null).toBeNull();

    usePlayerStore.setState({ source: live, mode: 'inline', status: 'playing' });
    expect(session.playbackState).toBe('playing');
    expect((session.metadata as Metadata).init).toEqual({ title: 'Channel 1', artist: 'News at Nine' });
    // Play while playing does nothing; pause toggles.
    actions.get('play')!();
    expect(buttons.togglePlay).not.toHaveBeenCalled();
    actions.get('pause')!();
    expect(buttons.togglePlay).toHaveBeenCalledTimes(1);
    actions.get('nexttrack')!();
    actions.get('previoustrack')!();
    actions.get('stop')!();
    expect(buttons.next).toHaveBeenCalledTimes(1);
    expect(buttons.previous).toHaveBeenCalledTimes(1);
    expect(buttons.stop).toHaveBeenCalledTimes(1);

    // A movie with no queue: no track buttons.
    usePlayerStore.setState({ source: movie, status: 'paused' });
    expect(session.playbackState).toBe('paused');
    expect(actions.get('nexttrack')).toBeNull();
    expect(actions.get('play')).toBeTypeOf('function');

    unbind();
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe('none');
    expect([...actions.values()].every((h) => h === null)).toBe(true);
  });
});
