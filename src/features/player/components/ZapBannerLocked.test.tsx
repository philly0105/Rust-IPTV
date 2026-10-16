/**
 * A zap passing a channel parental controls lock (Ask mode, L3-live-10): the banner, the mini
 * player's header line and the readouts show its number and name with a lock, without its
 * logo or guide, until the PIN lets it play.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
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
vi.mock('./InlinePlayer', () => ({ InlinePlayer: () => null }));

// The zap that marks a placeholder locked has its own tests (parentalHook.test.ts); here a
// source is locked when the test says so.
const lockedForTest = new WeakSet<PlayerSource>();
vi.mock('../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store')>();
  return { ...actual, isLockedZap: (s: PlayerSource | undefined) => (!!s && lockedForTest.has(s)) || actual.isLockedZap(s) };
});

const store = await import('../store');
const media = await import('../media');
const nowNext = await import('../nowNext');
const zap = await import('../zapBanner');
const { ZapBanner, ZapHeaderLine } = await import('./ZapBanner');
const { PlayerSurface } = await import('./PlayerSurface');
const { BarReadout } = await import('./Controls');
const { usePlayerStore } = store;

const T0 = Date.parse('2026-10-13T20:45:00Z');
const MIN = 60_000;
const ref = (itemId: string): ItemRef => ({ sourceId: 's1', contentType: 'live', itemId });
const lateNight = (): PlayerSource => ({ url: '', kind: 'direct', title: 'Late Night', isLive: true, isRadio: false, ref: ref('166') });

const epgCalls = (): number => rpcMock.mock.calls.filter((c) => c[0] === 'epg.nowNext').length;
const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const tune = (source: PlayerSource): void => {
  act(() => usePlayerStore.setState({ source, mode: 'inline', status: 'loading', dock: 'stage' }));
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
  handlers['catalog.item'] = () => ({ ref: ref('166'), name: 'Late Night', number: 66, logoUrl: 'http://h/logo/166.png', isRadio: false });
  handlers['epg.nowNext'] = (a) => {
    const r = (a as { refs: ItemRef[] }).refs[0]!;
    const iso = (t: number): string => new Date(t).toISOString();
    const g: EpgNowNext = {
      now: { title: 'After Hours', start: iso(T0 - 15 * MIN), end: iso(T0 + 45 * MIN) },
      next: { title: 'Late Show', start: iso(T0 + 45 * MIN), end: iso(T0 + 105 * MIN) },
    } as EpgNowNext;
    return { [itemKey(r)]: g };
  };
});

afterEach(() => {
  cleanup();
  zap.__resetZapBannerForTests();
  store.__resetPlayerForTests();
  store.setSettingsCache(null);
  vi.useRealTimers();
});

describe('a locked channel in a zap (L3-live-10)', () => {
  it('the banner shows its number and name with a lock, and neither its logo nor its guide', async () => {
    const s = lateNight();
    lockedForTest.add(s);
    tune(s);
    render(<ZapBanner />);
    await advance(0);
    expect(screen.getByTestId('zap-number').textContent).toBe('66');
    expect(screen.getByTestId('zap-title').textContent).toBe('Late Night');
    expect(screen.getByTestId('zap-lock')).toBeTruthy();
    expect(screen.queryByTestId('zap-logo')).toBeNull();
    expect(screen.queryByTestId('zap-logo-fallback')).toBeNull();
    expect(screen.getByTestId('zap-locked').textContent).toBe('Locked');
    expect(screen.queryByTestId('zap-guide-loading')).toBeNull();
    expect(screen.queryByTestId('zap-now')).toBeNull();
    expect(epgCalls()).toBe(0);
  });

  it('once the PIN lets it play, the logo and guide come', async () => {
    const s = lateNight();
    lockedForTest.add(s);
    tune(s);
    render(<ZapBanner />);
    await advance(0);
    expect(epgCalls()).toBe(0);
    // The unlocked stream replaces the placeholder: same channel, not locked.
    act(() => usePlayerStore.setState({ source: { ...s, url: 'http://h/live/166.m3u8', kind: 'hls' }, status: 'playing' }));
    await advance(0);
    expect(screen.queryByTestId('zap-lock')).toBeNull();
    expect(screen.getByTestId('zap-logo')).toBeTruthy();
    expect(screen.getByTestId('zap-now').textContent).toBe('After Hours');
    expect(epgCalls()).toBe(1);
  });

  it('the small player chip says it is locked instead of what airs', async () => {
    const s = lateNight();
    lockedForTest.add(s);
    tune(s);
    render(<ZapBanner chip />);
    await advance(0);
    expect(screen.getByTestId('zap-lock')).toBeTruthy();
    expect(screen.getByTestId('zap-locked').textContent).toBe('Locked');
    expect(screen.queryByTestId('zap-guide-loading')).toBeNull();
    expect(epgCalls()).toBe(0);
  });

  it("the mini player's header line keeps to the number, the name and a lock", async () => {
    const s = lateNight();
    lockedForTest.add(s);
    tune(s);
    render(<ZapHeaderLine title="Late Night" />);
    await advance(0);
    expect(screen.getByTestId('zap-number').textContent).toBe('66');
    expect(screen.getByTestId('zap-locked').textContent).toBe('Locked');
    expect(screen.queryByTestId('zap-now')).toBeNull();
    expect(epgCalls()).toBe(0);
  });

  it('the readouts draw a lock before the number of a locked step', () => {
    tune(lateNight());
    render(
      <div data-player-host="">
        <PlayerSurface compact={false} channelPanelAvailable={false} />
        <BarReadout />
      </div>,
    );
    act(() => media.showOsd('66', 'Late Night', { locked: true }));
    const osd = document.querySelector<HTMLElement>('.player-osd')!;
    expect(osd.querySelector('[data-testid=osd-locked] svg')).not.toBeNull();
    expect(osd.textContent).toBe('Locked66Late Night');
    expect(screen.getByTestId('bar-readout-locked').textContent).toBe('Locked ');
    act(() => media.showOsd('67', 'Film 4'));
    expect(document.querySelector('[data-testid=osd-locked]')).toBeNull();
    expect(screen.queryByTestId('bar-readout-locked')).toBeNull();
  });
});
