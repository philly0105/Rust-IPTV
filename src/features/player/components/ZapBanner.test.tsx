/**
 * Zap banner (C5): when it shows (every live channel change for 5 s, the channel title on
 * hover, `settings.zapBanner`), and what it shows (logo, number, title, now and next with
 * progress), windowed and fullscreen.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { DEFAULT_SETTINGS, itemKey, type EpgNowNext, type ItemRef, type PlayerSource } from '@/api/types';

const handlers: Record<string, (args: unknown) => unknown> = {};
const rpcMock = vi.fn(async (name: string, args?: unknown) => {
  const h = handlers[name];
  if (!h) throw new Error(`unmocked rpc ${name}`);
  return h(args);
});

vi.mock('@/api/transport', () => ({
  rpc: (name: string, args?: unknown) => rpcMock(name, args),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined }));
// The DOM engine is not under test: only the chrome around it.
vi.mock('./InlinePlayer', () => ({ InlinePlayer: () => null }));

const store = await import('../store');
const media = await import('../media');
const nowNext = await import('../nowNext');
const zap = await import('../zapBanner');
const { ZapBanner, airingPair } = await import('./ZapBanner');
const { useZapHover } = await import('./zapHooks');
const { PlayerSurface } = await import('./PlayerSurface');
const { usePlayerStore } = store;
const { useZapBanner, ZAP_BANNER_MS, ZAP_HOLD_MAX_MS, ZAP_HOVER_GRACE_MS } = zap;

const MIN = 60_000;
const T0 = Date.parse('2026-10-13T20:45:00Z');

const ref = (itemId: string): ItemRef => ({ sourceId: 's1', contentType: 'live', itemId });
const channel = (itemId: string, title: string): PlayerSource => ({
  url: `http://h/live/${itemId}.m3u8`,
  kind: 'hls',
  title,
  isLive: true,
  isRadio: false,
  ref: ref(itemId),
});
const news = channel('101', 'News 24');
const sport = channel('102', 'Sport 1');
const movie: PlayerSource = {
  url: 'http://h/movie/7.mp4',
  kind: 'direct',
  title: 'The Long Night',
  isLive: false,
  isRadio: false,
  ref: { sourceId: 's1', contentType: 'movie', itemId: '7' },
};

function guide(start: number, end: number, title = 'Evening News', next = 'Weather'): EpgNowNext {
  const iso = (t: number): string => new Date(t).toISOString();
  return {
    now: { channelId: 'c', title, start: iso(start), end: iso(end) },
    next: { channelId: 'c', title: next, start: iso(end), end: iso(end + 30 * MIN) },
  };
}

const visible = (): boolean => useZapBanner.getState().visible;
const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const tune = (source: PlayerSource | undefined, extra: Partial<ReturnType<typeof usePlayerStore.getState>> = {}): void => {
  act(() => usePlayerStore.setState({ source, mode: 'inline', status: 'playing', dock: 'stage', ...extra }));
};

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  for (const k of Object.keys(handlers)) delete handlers[k];
  rpcMock.mockClear();
  store.__resetPlayerForTests();
  media.resetMedia();
  nowNext.__resetNowNextForTests();
  zap.__resetZapBannerForTests();
  store.setSettingsCache({ ...DEFAULT_SETTINGS, zapBanner: true, epgOffsetMinutes: 0, epgShortFallback: false });
  handlers['catalog.item'] = (a) => {
    const id = (a as { ref: ItemRef }).ref.itemId;
    return { ref: ref(id), name: id === '101' ? 'News 24' : 'Sport 1', number: Number(id) - 100, logoUrl: `http://h/logo/${id}.png`, isRadio: false };
  };
  handlers['epg.nowNext'] = (a) => {
    const r = (a as { refs: ItemRef[] }).refs[0]!;
    return r.itemId === '101' ? { [itemKey(r)]: guide(T0 - 15 * MIN, T0 + 45 * MIN) } : {};
  };
});

afterEach(() => {
  cleanup();
  zap.__resetZapBannerForTests();
  store.__resetPlayerForTests();
  store.setSettingsCache(null);
  vi.useRealTimers();
});

describe('when the banner shows', () => {
  it('comes up for 5 s on every live channel change', async () => {
    tune(news);
    expect(useZapBanner.getState()).toMatchObject({ visible: true, channelKey: itemKey(news.ref!) });
    const first = useZapBanner.getState().showing;
    await advance(ZAP_BANNER_MS - 100);
    expect(visible()).toBe(true);
    await advance(100);
    expect(visible()).toBe(false);

    tune(sport);
    expect(useZapBanner.getState()).toMatchObject({ visible: true, channelKey: itemKey(sport.ref!) });
    expect(useZapBanner.getState().showing).toBe(first + 1);
  });

  it('restarts its 5 s on a zap while it is up', async () => {
    tune(news);
    await advance(4000);
    tune(sport);
    await advance(4000);
    expect(visible()).toBe(true);
    await advance(1000);
    expect(visible()).toBe(false);
  });

  it('stays down for VOD, radio and external players, and goes when live TV ends', async () => {
    tune(movie);
    expect(visible()).toBe(false);
    tune({ ...news, isRadio: true });
    expect(visible()).toBe(false);
    tune(news, { mode: 'external' });
    expect(visible()).toBe(false);
    tune(sport);
    expect(visible()).toBe(true);
    tune(movie);
    expect(visible()).toBe(false);
    tune(news);
    act(() => usePlayerStore.getState().stop());
    expect(visible()).toBe(false);
  });

  it('honours settings.zapBanner', () => {
    store.setSettingsCache({ ...DEFAULT_SETTINGS, zapBanner: false });
    tune(news);
    expect(visible()).toBe(false);
    act(() => zap.holdZapBanner(true));
    expect(visible()).toBe(false);
  });

  it('stays while the pointer rests on the title, then leaves after a short grace', async () => {
    tune(news);
    await advance(ZAP_BANNER_MS);
    expect(visible()).toBe(false);
    act(() => zap.holdZapBanner(true));
    expect(visible()).toBe(true);
    await advance(ZAP_BANNER_MS * 3);
    expect(visible()).toBe(true);
    act(() => zap.holdZapBanner(false));
    await advance(ZAP_HOVER_GRACE_MS - 50);
    expect(visible()).toBe(true);
    await advance(50);
    expect(visible()).toBe(false);
  });
});

describe('what the banner shows', () => {
  it('logo, number, title, and now and next with the share aired', async () => {
    tune(news);
    render(<ZapBanner />);
    // Guide first loads, then the details arrive.
    expect(screen.getByTestId('zap-guide-loading')).toBeTruthy();
    await advance(0);
    const banner = screen.getByTestId('zap-banner');
    expect(banner.getAttribute('role')).toBe('status');
    expect(screen.getByTestId('zap-number').textContent).toBe('1');
    expect(screen.getByTestId('zap-title').textContent).toBe('News 24');
    // Through the image cache (C3) first.
    expect(screen.getByTestId('zap-logo').getAttribute('src')).toBe('/api/img?url=http%3A%2F%2Fh%2Flogo%2F101.png&sourceId=s1');
    expect(screen.getByTestId('zap-now').textContent).toBe('Evening News');
    expect(screen.getByTestId('zap-next').textContent).toBe('Weather');
    // 15 of 60 minutes aired.
    expect((screen.getByTestId('zap-progress') as HTMLElement).style.width).toBe('25%');
    expect(banner.textContent).toContain('Now');
    expect(banner.textContent).toContain('Next');
  });

  it('says so when the guide has nothing, and falls back to an icon without a logo', async () => {
    handlers['catalog.item'] = () => ({ ref: ref('102'), name: 'Sport 1', isRadio: false });
    tune(sport);
    render(<ZapBanner />);
    await advance(0);
    expect(screen.getByTestId('zap-no-guide').textContent).toBe('No guide information');
    expect(screen.getByTestId('zap-logo-fallback')).toBeTruthy();
    expect(screen.queryByTestId('zap-number')).toBeNull();
  });

  it('swaps a logo that fails to load for the icon', async () => {
    tune(news);
    render(<ZapBanner />);
    await advance(0);
    // The cache URL fails: the logo's own URL once, then the icon.
    fireEvent.error(screen.getByTestId('zap-logo'));
    expect(screen.getByTestId('zap-logo').getAttribute('src')).toBe('http://h/logo/101.png');
    fireEvent.error(screen.getByTestId('zap-logo'));
    expect(screen.getByTestId('zap-logo-fallback')).toBeTruthy();
  });

  it('shows the compact one-line version with time left', async () => {
    tune(news);
    render(<ZapBanner compact />);
    await advance(0);
    expect(screen.getByTestId('zap-now').textContent).toContain('Evening News');
    expect(screen.getByTestId('zap-now').textContent).toContain('45 min left');
    expect(screen.queryByTestId('zap-next')).toBeNull();
  });

  it('moves on to the next programme when "now" ends while it is up', () => {
    const g = guide(T0 - 60 * MIN, T0 - MIN, 'Old', 'Current');
    expect(airingPair(g, T0)).toEqual({ current: g.next });
    expect(airingPair(g, T0 - 2 * MIN)).toEqual({ current: g.now, upcoming: g.next });
    expect(airingPair(null, T0)).toEqual({});
  });
});

describe('in the player', () => {
  const mount = (): void => {
    render(
      <div data-player-host="">
        <PlayerSurface compact={false} channelPanelAvailable={false} />
      </div>,
    );
  };

  it('shows on a zap windowed and in fullscreen', async () => {
    tune(news);
    mount();
    await advance(0);
    expect(screen.getByTestId('zap-banner')).toBeTruthy();
    await advance(ZAP_BANNER_MS);
    expect(screen.queryByTestId('zap-banner')).toBeNull();

    act(() => usePlayerStore.setState({ isFullscreen: true }));
    tune(sport, { isFullscreen: true });
    await advance(0);
    expect(screen.getByTestId('zap-title').textContent).toBe('Sport 1');
  });

  it('comes up on hover of the channel title', async () => {
    tune(news);
    mount();
    await advance(ZAP_BANNER_MS);
    expect(screen.queryByTestId('zap-banner')).toBeNull();
    const title = screen.getByRole('heading', { name: 'News 24' });
    // The chrome is hidden by now: the title lets the pointer through until a move brings it back.
    expect(title.className).not.toContain('pointer-events-auto');
    fireEvent.pointerMove(title);
    expect(title.className).toContain('pointer-events-auto');
    fireEvent.pointerEnter(title);
    await advance(0);
    expect(screen.getByTestId('zap-banner')).toBeTruthy();
    // Resting on the title keeps the chrome, and so the banner, up.
    await advance(ZAP_BANNER_MS * 2);
    expect(screen.getByTestId('zap-banner')).toBeTruthy();
    fireEvent.pointerLeave(title);
    await advance(ZAP_HOVER_GRACE_MS);
    expect(screen.queryByTestId('zap-banner')).toBeNull();
  });

  it('a hover on the title is dead while the chrome is hidden', async () => {
    tune(news);
    mount();
    await advance(ZAP_BANNER_MS);
    fireEvent.pointerEnter(screen.getByRole('heading', { name: 'News 24' }));
    await advance(0);
    expect(screen.queryByTestId('zap-banner')).toBeNull();
  });

  it('passes clicks on the title to the video: pause, and a double click for fullscreen', () => {
    tune(news);
    mount();
    const title = screen.getByRole('heading', { name: 'News 24' });
    fireEvent.click(title, { detail: 1 });
    expect(usePlayerStore.getState().status).toBe('paused');
    fireEvent.click(title, { detail: 2 });
    fireEvent.doubleClick(title, { detail: 2 });
    expect(usePlayerStore.getState().isFullscreen).toBe(true);
    // The double click put the play state back.
    expect(usePlayerStore.getState().status).toBe('playing');
  });

  it('lets go of a hover when the stream fails under the pointer', async () => {
    tune(news);
    mount();
    await advance(0);
    fireEvent.pointerEnter(screen.getByTestId('zap-banner'));
    act(() => usePlayerStore.setState({ status: 'error', error: 'boom' }));
    await advance(0);
    expect(screen.queryByTestId('zap-banner')).toBeNull();
    // Shown again while failed: it times out as usual.
    act(() => zap.showZapBanner());
    await advance(20_000);
    expect(visible()).toBe(false);
    // A zap to a working channel: up for its 5 s, then gone.
    tune(sport);
    await advance(0);
    expect(screen.getByTestId('zap-banner')).toBeTruthy();
    await advance(20_000);
    expect(screen.queryByTestId('zap-banner')).toBeNull();
    expect(visible()).toBe(false);
  });

  it('is not drawn while the stream has failed, nor with the setting off', async () => {
    tune(news, { status: 'error', error: 'boom' });
    mount();
    await advance(0);
    expect(screen.queryByTestId('zap-banner')).toBeNull();
    tune(sport);
    await advance(0);
    expect(screen.getByTestId('zap-banner')).toBeTruthy();
    act(() => store.setSettingsCache({ ...DEFAULT_SETTINGS, zapBanner: false }));
    expect(screen.queryByTestId('zap-banner')).toBeNull();
  });
});

describe('hover holds', () => {
  function Spot() {
    const hover = useZapHover();
    return <div data-testid="spot" {...hover} />;
  }

  it('after hideZapBanner, a new hover holds and its leave starts the grace', async () => {
    tune(news);
    render(<Spot />);
    const spot = screen.getByTestId('spot');
    fireEvent.pointerEnter(spot);
    act(() => zap.hideZapBanner());
    expect(visible()).toBe(false);
    // The pointer comes back without a leave having been seen.
    fireEvent.pointerEnter(spot);
    expect(visible()).toBe(true);
    await advance(20_000);
    expect(visible()).toBe(true);
    fireEvent.pointerLeave(spot);
    await advance(ZAP_HOVER_GRACE_MS - 50);
    expect(visible()).toBe(true);
    await advance(50);
    expect(visible()).toBe(false);
  });

  it('a hold whose leave never comes ends after its maximum', async () => {
    tune(news);
    render(<Spot />);
    fireEvent.pointerEnter(screen.getByTestId('spot'));
    await advance(ZAP_HOLD_MAX_MS - 100);
    expect(visible()).toBe(true);
    await advance(100 + ZAP_HOVER_GRACE_MS);
    expect(visible()).toBe(false);
    // The pointer, still there, moves out and back in: it holds again.
    fireEvent.pointerLeave(screen.getByTestId('spot'));
    fireEvent.pointerEnter(screen.getByTestId('spot'));
    expect(visible()).toBe(true);
    await advance(ZAP_BANNER_MS * 2);
    expect(visible()).toBe(true);
  });
});
