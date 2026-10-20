// VL-stats-interaction: the per-day chart answers a resting pointer, and both top lists have meters.
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.hoisted(() => ({ current: null as null | { call: (cmd: string, args?: unknown) => Promise<unknown> } }));
vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));

const h = await import('./harness');
const rpc = h.createRpcMock();
rpcMock.current = rpc;
const { StatsPage } = await import('../pages/StatsPage');

beforeAll(h.installDomStubs);
beforeEach(() => {
  rpc.reset();
  h.resetShared();
  rpc.handlers['sources.list'] = () => h.SOURCES;
  rpc.handlers['stats.summary'] = () =>
    h.summary(
      7,
      { 0: { live: 3600, vod: 1200 }, 1: { live: 5400 }, 6: { vod: 1800 } },
      {
        channels: [h.topItem(h.ref('live', '7'), 'BBC One', 7200), h.topItem(h.ref('live', '8'), 'Jazz FM', 1800)],
        titles: [h.topItem(h.ref('movie', '201'), 'Black Harbor', 1800), h.topItem(h.ref('series', '55'), 'Dark', 900)],
      },
    );
});
afterEach(cleanup);

describe('VL-stats-interaction', () => {
  it('a resting pointer shows the day card above its bar and steps the other days back', async () => {
    h.renderAt('/stats', [{ path: '/stats', element: <StatsPage /> }]);
    const slider = await screen.findByRole('slider', { name: 'Watch time per day' });
    const first = slider.children[0] as HTMLElement;
    fireEvent.pointerEnter(first, { pointerType: 'mouse' });
    const card = within(first).getByTestId('stats-day-card');
    // The oldest day of the week: 30 min, all of it movies and series.
    expect(card.textContent).toMatch(/30 min.*Live.*0 min.*Movies and series.*30 min/);
    expect(card.getAttribute('aria-hidden')).toBe('true');
    // The other days dim; the hovered one stays full.
    const bar = (i: number) => within(slider.children[i] as HTMLElement).queryByTestId('stats-bar');
    expect(bar(1)!.className).toContain('opacity-55');
    expect(bar(0)!.className).not.toContain('opacity-55');
    fireEvent.pointerLeave(slider.parentElement!);
    expect(screen.queryByTestId('stats-day-card')).toBeNull();
    // A touch does not open the card (it picks the day on tap, as before).
    fireEvent.pointerEnter(first, { pointerType: 'touch' });
    expect(screen.queryByTestId('stats-day-card')).toBeNull();
  });

  it('gives the top titles the same share meter as the top channels', async () => {
    h.renderAt('/stats', [{ path: '/stats', element: <StatsPage /> }]);
    const titles = await screen.findByTestId('stats-top-titles');
    const meters = within(titles).getAllByTestId('stats-meter');
    expect(meters).toHaveLength(2);
    expect((meters[1]!.firstElementChild as HTMLElement).style.width).toBe('50%');
    expect(within(screen.getByTestId('stats-top-channels')).getAllByTestId('stats-meter')).toHaveLength(2);
  });
});
