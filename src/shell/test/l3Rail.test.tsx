/**
 * Loop 3 rail: the primary links and the sources scroll apart, so many sources no longer push
 * Settings out of reach (L3-visual-2); the tour's Live step points at a source that has channels
 * (L3-app-6); a cut-off source name shows in full on hover (L3-visual-12).
 */
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { Outlet } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { installDomStubs, makeSource, Page, renderRoutes, rpcMock, settings } from './harness';

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

const { Rail, liveTourSource } = await import('../Rail');

function routes(collapsed = false) {
  return [
    {
      path: '/',
      element: (
        <>
          <Rail collapsed={collapsed} autoCollapsed={collapsed} />
          <Outlet />
        </>
      ),
      children: [{ path: 'dashboard', element: <Page>home</Page> }],
    },
  ];
}

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  rpcMock.handlers['settings.get'] = () => settings();
});
afterEach(() => {
  cleanup();
});

describe('rail layout (L3-visual-2)', () => {
  it('keeps the primary links out of the sources scroll box, capped so the sources keep room', async () => {
    rpcMock.handlers['sources.list'] = () => Array.from({ length: 30 }, (_, i) => makeSource(`s${i}`, { name: `Source ${i}`, position: i }));
    renderRoutes(routes(), '/dashboard');
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    await within(nav).findByText('Source 29');
    const primary = screen.getByTestId('rail-primary');
    const scroll = screen.getByTestId('rail-scroll');
    expect(primary.contains(scroll) || scroll.contains(primary)).toBe(false);
    const primaryLinks = within(primary).getAllByRole('link');
    expect(primaryLinks.length).toBeGreaterThan(2);
    for (const link of primaryLinks) expect(scroll.contains(link)).toBe(false);
    expect(within(scroll).getByText('Source 29')).toBeTruthy();
    // Settings stays in the footer, outside both.
    const settingsLink = within(nav).getByRole('link', { name: /Settings/ });
    expect(primary.contains(settingsLink) || scroll.contains(settingsLink)).toBe(false);
    // The sources take the rest of the height and scroll; the primary block scrolls only past its cap.
    for (const c of ['flex-1', 'min-h-0', 'overflow-y-auto']) expect(scroll.classList.contains(c), c).toBe(true);
    expect(primary.className).toMatch(/\bshrink-0\b/);
    expect(primary.className).toMatch(/\boverflow-y-auto\b/);
    expect(primary.className).toContain('max-h-[max(50%,calc(100%-10rem))]');
  });
});

describe('tour Live anchor (L3-app-6)', () => {
  it('skips a failed or empty first source', () => {
    const failed = makeSource('a', { lastError: 'HTTP 404', channelCount: 0 });
    const empty = makeSource('b', { channelCount: 0 });
    const healthy = makeSource('c', { channelCount: 40 });
    const erroredWithChannels = makeSource('d', { channelCount: 10, lastError: 'timeout' });
    expect(liveTourSource([failed, empty, healthy])?.id).toBe('c');
    expect(liveTourSource([erroredWithChannels, healthy])?.id).toBe('c');
    // Only errored sources with channels: the first of them beats none.
    expect(liveTourSource([failed, erroredWithChannels])?.id).toBe('d');
    expect(liveTourSource([failed, empty])).toBeUndefined();
    expect(liveTourSource([])).toBeUndefined();
  });

  it('puts the one Live anchor on the healthy source in the rail', async () => {
    rpcMock.handlers['sources.list'] = () => [
      makeSource('bad', { name: 'Header M3U', position: 1, channelCount: 0, lastError: 'HTTP 404' }),
      makeSource('good', { name: 'Night Portal', position: 2, channelCount: 120 }),
    ];
    renderRoutes(routes(), '/dashboard');
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    await within(nav).findByText('Night Portal');
    const anchors = nav.querySelectorAll('[data-tour="live"]');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.textContent).toContain('Night Portal');
  });
});

describe('source names (L3-visual-12)', () => {
  it('a long name carries its full text as a tooltip', async () => {
    const name = 'A very long provider name that the rail has to cut off';
    rpcMock.handlers['sources.list'] = () => [makeSource('s1', { name }), makeSource('s2')];
    renderRoutes(routes(), '/dashboard');
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    const label = await within(nav).findByText(name);
    expect(label.getAttribute('title')).toBe(name);
    expect(label.className).toMatch(/\btruncate\b/);
  });

  it("the only source's row shows its full name and where it leads in its tooltip", async () => {
    const name = 'A very long provider name that the rail has to cut off';
    rpcMock.handlers['sources.list'] = () => [makeSource('s1', { name })];
    renderRoutes(routes(), '/dashboard');
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    const row = await within(nav).findByRole('link', { name: new RegExp(`^${name}`) });
    expect(within(row).getByText(name).className).toMatch(/\btruncate\b/);
    fireEvent.mouseEnter(row);
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toBe(`${name}Manage sources`);
  });
});
