/**
 * Review round 2, Live: the channel pickers' guide requests (one per page, not one per wave of
 * catalog answers), the idle glow's hue from the logo, the playing row's marks, the menus and the
 * programme sheet over the mini player, and the idle card and ribbon telling one story.
 */

import { act, cleanup, configure, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, FavoriteEntry, ItemRef, Page, PageQuery } from '@/api/types';

import { ChannelRow } from '../components/ChannelRow';
import { measureLogo } from '../components/ChannelLogo';
import { ContextMenu } from '../components/ContextMenu';
import { LivePage } from '../components/LivePage';
import { StageIdle } from '../components/StageIdle';
import { SCOPE_FAVORITES, useChannelBrowse } from '../hooks/useChannelBrowse';
import { MINUTE } from '../lib/epgTime';
import { i18n, installDomStubs, makeChannel, program, renderAt, settings } from './harness';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const calls: { cmd: string; args: unknown }[] = [];
  const call = async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { handlers, calls, call };
});

vi.mock('@/api/transport', () => ({
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
  RpcError: class RpcError extends Error {},
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/ui', async (orig) => ({ ...(await orig<object>()), ...(await import('./fakes')) }));
vi.mock('@/shell', async () => await import('./fakes'));
vi.mock('@/features/player', async () => await import('./fakes'));
vi.mock('@/features/player/remote', async () => await import('./fakes'));

configure({ asyncUtilTimeout: 4000 });
vi.setConfig({ testTimeout: 20_000 });
beforeAll(installDomStubs);
beforeEach(() => {
  for (const k of Object.keys(rpcMock.handlers)) delete rpcMock.handlers[k];
  rpcMock.calls.length = 0;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const callsOf = (cmd: string) => rpcMock.calls.filter((c) => c.cmd === cmd).map((c) => c.args);

describe('channel pickers in Favorites (useChannelBrowse)', () => {
  it('asks the guide once for the page of favourites, however the catalog answers trickle in', async () => {
    const favs: FavoriteEntry[] = Array.from({ length: 60 }, (_, i) => ({
      ref: makeChannel(i).ref,
      position: i,
      addedAt: new Date(2026, 0, 1, 0, i).toISOString(),
      snapshot: { title: `Channel ${i}`, contentType: 'live' },
    })) as FavoriteEntry[];
    rpcMock.handlers['favorites.list'] = () => favs;
    // catalog.item answers in ten waves of six.
    const waits: (() => void)[] = [];
    rpcMock.handlers['catalog.item'] = (a) =>
      new Promise((resolve) => {
        const ref = (a as { ref: ItemRef }).ref;
        waits.push(() => resolve(makeChannel(Number(ref.itemId.slice(1)))));
      });
    rpcMock.handlers['epg.nowNext'] = () => ({});
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useChannelBrowse({ enabled: true, sourceId: 'src1', scope: SCOPE_FAVORITES, query: '', limit: 60 }), { wrapper });
    await waitFor(() => expect(waits.length).toBe(60));
    for (let wave = 0; wave < 10; wave++) {
      await act(async () => {
        for (const w of waits.splice(0, 6)) w();
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    await waitFor(() => expect(result.current.channels).toHaveLength(60));
    const asked = callsOf('epg.nowNext') as { refs: ItemRef[] }[];
    expect(asked).toHaveLength(1);
    expect(asked[0]!.refs).toHaveLength(60);
  });
});

describe('the idle glow takes the logo’s colour (review round 2)', () => {
  // measureLogo keeps the one canvas it first made: every test reads this buffer through it.
  const data = new Uint8ClampedArray(16 * 16 * 4);
  const fill = (rgba: [number, number, number, number]) => {
    for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  };
  beforeEach(() => {
    const ctx = { clearRect() {}, drawImage() {}, getImageData: () => ({ data }) };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx as never);
  });
  const img = () => Object.defineProperty(document.createElement('img'), 'naturalWidth', { value: 64 }) as HTMLImageElement;

  it('reads the hue of a coloured logo, and none from a grey one', () => {
    fill([30, 80, 200, 255]); // a blue tile
    const blue = measureLogo(img());
    expect(blue.hue).toBeGreaterThan(210);
    expect(blue.hue).toBeLessThan(235);
    expect(blue.plate).toBeNull(); // opaque: it brings its own background
    fill([120, 120, 120, 255]); // grey
    expect(measureLogo(img()).hue).toBeNull();
    fill([0, 0, 0, 0]); // see-through
    expect(measureLogo(img())).toEqual({ plate: null, hue: null });
  });

  it('a monogram tints the glow with its own hue; a logo leaves it slate until it has loaded', () => {
    fill([30, 80, 200, 255]);
    const ch: Channel = { ...makeChannel(3), logoUrl: undefined };
    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <StageIdle kind="live" last={{ channel: ch }} now={Date.now()} />
      </I18nextProvider>,
    );
    const glow = () => screen.getByTestId('stage-idle-glow');
    expect(glow().dataset.hue).toBeDefined();
    const tinted = glow().style.backgroundImage;
    rerender(
      <I18nextProvider i18n={i18n}>
        <StageIdle kind="live" last={{ channel: { ...ch, ref: makeChannel(4).ref, logoUrl: 'http://logo/4.png' } }} now={Date.now()} />
      </I18nextProvider>,
    );
    // The logo has not loaded: slate, never the name hash's hue (brown behind a blue logo).
    expect(glow().dataset.hue).toBeUndefined();
    expect(glow().style.backgroundImage).not.toBe(tinted);
    const logo = document.querySelector<HTMLImageElement>('[data-testid="stage-idle"] img')!;
    Object.defineProperty(logo, 'naturalWidth', { value: 64 });
    fireEvent.load(logo);
    expect(Number(glow().dataset.hue)).toBeGreaterThan(210);
    expect(Number(glow().dataset.hue)).toBeLessThan(235);
  });
});

describe('the playing row (review round 2)', () => {
  function row(over: Partial<Parameters<typeof ChannelRow>[0]> = {}) {
    const now = Date.now();
    render(
      <I18nextProvider i18n={i18n}>
        <ChannelRow
          index={0}
          channel={makeChannel(0)}
          nowNext={{ now: program('Morning Mix', now - 10 * MINUTE, now + 50 * MINUTE) }}
          favorite
          playing
          active={false}
          now={now}
          onActivate={() => undefined}
          onToggleFavorite={() => undefined}
          onContextMenu={() => undefined}
          {...over}
        />
      </I18nextProvider>,
    );
  }

  it('keeps amber for the tick and the progress: the number is the text colour and the star is neutral', () => {
    row();
    const button = screen.getByRole('button', { name: /^1, Channel 0/ });
    const number = within(button).getByText('1');
    expect(number.className).toContain('text-fg');
    expect(number.className).not.toMatch(/text-accent/);
    const star = screen.getByTestId('row-favorite');
    expect(star.getAttribute('class')).toContain('text-fg-subtle');
    expect(star.getAttribute('class')).not.toMatch(/text-(warning|accent)/);
    // The inline star steps aside while the floating actions show their own.
    expect(star.getAttribute('class')).toContain('not-pointer-coarse:group-hover/row:invisible');
    expect(screen.getByTestId('channel-progress').className).toContain('bg-accent-mark');
  });

  it('the favourite toggle has one name and says its state by pressed, the action in its tooltip', () => {
    row();
    const toggle = within(screen.getByTestId('row-actions')).getByRole('button', { name: 'Favorite' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    const icon = toggle.querySelector('svg')!;
    expect(icon.getAttribute('class')).toContain('text-fg');
    expect(icon.getAttribute('class')).not.toMatch(/text-warning/);
  });
});

describe('menus over the mini player (review round 2)', () => {
  it('the channel menu renders in the overlay layer, not inside the page, at the kit menu’s level', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <main data-testid="page">
          <ContextMenu pos={{ x: 10, y: 10 }} items={[{ id: 'a', label: 'Play', onSelect: () => undefined }]} label="Channel 0" onClose={() => undefined} />
        </main>
      </I18nextProvider>,
    );
    const menu = screen.getByRole('menu', { name: 'Channel 0' });
    expect(screen.getByTestId('page').contains(menu)).toBe(false);
    expect(menu.closest('[data-portal-host]')).toBeTruthy();
    expect(menu.className).toContain('z-[60]');
  });
});

describe('the idle card and the ribbon tell one story (review round 2)', () => {
  const TOTAL = 30;
  beforeEach(() => {
    const h = rpcMock.handlers;
    const src = { id: 'src1', kind: 'xtream', name: 'Demo', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } };
    h['sources.get'] = () => src;
    h['sources.list'] = () => [src];
    h['settings.get'] = () => settings();
    h['settings.update'] = () => settings();
    h['catalog.categories'] = () => [{ id: 'g1', sourceId: 'src1', contentType: 'live', name: 'News', hidden: false, itemCount: TOTAL, position: 0 }];
    h['catalog.channels'] = (a) => {
      const q = (a as { query: PageQuery }).query;
      const items = Array.from({ length: Math.max(0, Math.min(q.limit, TOTAL - q.offset)) }, (_, i) => makeChannel(q.offset + i));
      return { items, total: TOTAL, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
    };
    h['catalog.item'] = (a) => makeChannel(Number((a as { ref: ItemRef }).ref.itemId.slice(1)));
    h['epg.nowNext'] = () => ({});
    h['epg.programs'] = () => [];
    h['favorites.contains'] = () => [];
    h['remote.status'] = () => ({ running: false, port: 7310 });
    // Channel 7 was watched last: not the first row of the list.
    h['recent.list'] = () => [
      { ref: makeChannel(7).ref, snapshot: { title: 'Channel 7', contentType: 'live' }, watchedAt: new Date().toISOString(), positionSeconds: 0, durationSeconds: 0 },
    ];
  });

  it('while the list has not been used, both describe the channel last watched, and only the card offers to start it', async () => {
    renderAt('/s/src1/live', [{ path: '/s/:sourceId/live', element: <LivePage /> }]);
    await screen.findByText('Channel 0');
    expect(await screen.findByTestId('stage-idle-caption')).toHaveProperty('textContent', 'Last watched');
    await waitFor(() => expect(screen.getByTestId('ribbon-header').textContent).toContain('Channel 7'));
    expect(screen.getByTestId('stage-resume').textContent).toContain('Resume Channel 7');
    expect(screen.queryByTestId('ribbon-back-to-live')).toBeNull();
  });

  it('once the user moves through the list, both follow the cursor, and the card says it is the highlighted row', async () => {
    renderAt('/s/src1/live', [{ path: '/s/:sourceId/live', element: <LivePage /> }]);
    await screen.findByText('Channel 0');
    await screen.findByTestId('stage-resume');
    const first = document.querySelector<HTMLButtonElement>('[data-testid="channel-list"] [data-row-index="0"]')!;
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByTestId('stage-resume').textContent).toContain('Play Channel 2'));
    expect(screen.getByTestId('stage-idle-caption').textContent).toBe('Highlighted');
    await waitFor(() => expect(screen.getByTestId('ribbon-header').textContent).toContain('Channel 2'));
    expect(screen.queryByTestId('ribbon-back-to-live')).toBeNull();
    // Focus moving on (to the ribbon, say) keeps the column on the cursor's channel.
    act(() => (document.activeElement as HTMLElement).blur());
    expect(screen.getByTestId('stage-idle-caption').textContent).toBe('Highlighted');
  });
});
