import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Outlet } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { fakeResizeObservers, installDomStubs, makeSource, Page, renderRoutes, rpcMock, settings } from './harness';

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
  onConnectionState: () => () => undefined,
}));

const { Rail, railRevealDelta } = await import('../Rail');

function routes(collapsed: boolean) {
  return [
    {
      path: '/',
      element: (
        <>
          <Rail collapsed={collapsed} autoCollapsed={collapsed} />
          <Outlet />
        </>
      ),
      children: [
        { path: 'dashboard', element: <Page>home</Page> },
        { path: 's/:sourceId/*', element: <Page>source page</Page> },
        { path: 'live/archive/:sourceId/:channelId', element: <Page>archive page</Page> },
      ],
    },
  ];
}

const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 240, width: 240, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

/** Lays the rail out like a 1280x800 window: its scroll box spans 60-668 px, and the third source sits under the fold. */
function layOutRail() {
  const box = screen.getByTestId('rail-scroll');
  let top = 0;
  Object.defineProperty(box, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => void (top = v) });
  const proto = HTMLElement.prototype;
  const original = proto.getBoundingClientRect;
  vi.spyOn(proto, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === box) return rect(60, 668);
    if (this.getAttribute('aria-current') === 'page') return rect(701 - top, 733 - top);
    if (this.tagName === 'LI' && this.textContent?.includes('Source s3')) return rect(640 - top, 840 - top);
    return original.call(this);
  });
  return { box, scrollTop: () => top };
}

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  rpcMock.handlers['settings.get'] = () => settings();
  rpcMock.handlers['sources.list'] = () => [1, 2, 3].map((i) => makeSource(`s${i}`, { position: i, seriesCount: 5 }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('rail scroll (L2-shell-1)', () => {
  it('railRevealDelta keeps a target inside the box, and a tall target keeps its top edge', () => {
    expect(railRevealDelta({ top: 60, bottom: 668 }, { top: 100, bottom: 140 })).toBe(0);
    expect(railRevealDelta({ top: 60, bottom: 668 }, { top: 701, bottom: 733 })).toBe(733 - 668 + 24);
    expect(railRevealDelta({ top: 60, bottom: 668 }, { top: 20, bottom: 52 })).toBe(20 - 60 - 24);
    // 700 px of links under a row at 300: the row stops 24 px under the top, not above it.
    expect(railRevealDelta({ top: 60, bottom: 668 }, { top: 300, bottom: 1000 })).toBe(300 - 60 - 24);
  });

  it('opening a source from elsewhere (card, palette) scrolls its active link into view once laid out', async () => {
    const observers = fakeResizeObservers();
    try {
      const { router } = renderRoutes(routes(false), '/dashboard');
      await screen.findByText('Source s3');
      const { box, scrollTop } = layOutRail();
      const rects = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
      expect(scrollTop()).toBe(0);
      await act(() => router.navigate('/s/s3/live'));
      expect(within(box).getByRole('link', { name: 'Live TV' }).getAttribute('aria-current')).toBe('page');
      // P2-RAILS-2: nothing is measured right after the new page committed (that forced its
      // layout); the observer's first callback, after the browser's layout, scrolls the link in.
      expect(rects.mock.contexts).not.toContain(box);
      expect(scrollTop()).toBe(0);
      act(() => observers.layOut());
      // The link at 701-733 now ends 24 px above the box's 668 px bottom edge.
      expect(scrollTop()).toBe(733 - 668 + 24);
    } finally {
      observers.restore();
    }
  });

  it("fades the sources' hidden end in the observer's callback, so the rail never shows without it", async () => {
    const observers = fakeResizeObservers();
    try {
      renderRoutes(routes(false), '/dashboard');
      await screen.findByText('Source s3');
      const { box } = layOutRail();
      Object.defineProperty(box, 'clientHeight', { configurable: true, value: 608 });
      Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 900 });
      // The callback runs after layout and before paint: the fade is in the DOM when it returns,
      // not in a render a frame after the rail showed (act off: updates schedule as in the app).
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
      observers.layOut();
      expect(box.getAttribute('data-fade-bottom')).toBe('true');
    } finally {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      observers.restore();
    }
  });

  it('expanding a source by hand below the fold scrolls its links into view', async () => {
    renderRoutes(routes(false), '/dashboard');
    const btn = await screen.findByRole('button', { name: /Source s3/ });
    const { box } = layOutRail();
    const scrollTo = vi.fn();
    box.scrollTo = scrollTo as unknown as typeof box.scrollTo;
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(scrollTo).toHaveBeenCalledWith({ top: 840 - 668 + 24, behavior: 'smooth' });
    // Collapsing it again does not scroll.
    scrollTo.mockClear();
    fireEvent.click(btn);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe('catch-up archive', () => {
  it("opens and marks the archive's source, though the route sits outside /s/:id", async () => {
    renderRoutes(routes(false), '/live/archive/s2/ch1');
    const btn = await screen.findByRole('button', { name: /Source s2/ });
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(btn.className).toContain('text-fg ');
    expect(screen.getByRole('button', { name: /Source s1/ }).getAttribute('aria-expanded')).toBe('false');
  });
});

describe('collapsed rail (L2-shell-2)', () => {
  it("a source's monogram opens its Live, Movies, Series, Favorites and Recent links", async () => {
    const { router } = renderRoutes(routes(true), '/s/s1/live');
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    const trigger = await within(nav).findByRole('button', { name: 'Source s1' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(trigger);
    const menu = await screen.findByRole('menu', { name: 'Source s1' });
    const items = within(menu).getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['Live TVcurrent page', 'Radio', 'Movies', 'Series', 'Favorites', 'Recent']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Series' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/s/s1/series'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('an m3u source probes for radio only once the monogram is hovered or focused', async () => {
    // Two sources: a lone one is a plain link to the Sources page, with Radio among the Watch rows.
    rpcMock.handlers['sources.list'] = () => [makeSource('m', { kind: 'm3u', name: 'Playlist', movieCount: 0 }), makeSource('s2')];
    rpcMock.handlers['catalog.channels'] = () => ({ items: [], total: 3 });
    renderRoutes(routes(true), '/dashboard');
    const trigger = await screen.findByRole('button', { name: 'Playlist' });
    expect(rpcMock.calls.some((c) => c.cmd === 'catalog.channels')).toBe(false);
    fireEvent.focus(trigger);
    await waitFor(() => expect(rpcMock.calls.some((c) => c.cmd === 'catalog.channels')).toBe(true));
    fireEvent.click(trigger);
    const menu = await screen.findByRole('menu');
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Radio' })).toBeTruthy());
    expect(within(menu).queryByRole('menuitem', { name: 'Movies' })).toBeNull();
  });
});
