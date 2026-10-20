// Review round 2: the chart's two series are the accent's mark tone and a neutral (a half-strength
// amber read as brown in dark and tan in light), the range control leads on its own line, and the
// KPI tiles share one row of columns.
import { cleanup, screen, within } from '@testing-library/react';
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
const { LIVE_FILL, VOD_FILL } = await import('../components/DayChart');

beforeAll(h.installDomStubs);
beforeEach(() => {
  rpc.reset();
  h.resetShared();
  rpc.handlers['sources.list'] = () => h.SOURCES;
  rpc.handlers['stats.summary'] = () => h.summary(7, { 0: { live: 3600, vod: 1200 }, 1: { live: 5400 }, 6: { vod: 1800 } });
});
afterEach(cleanup);

const classes = (fill: string) => fill.split(/\s+/).filter((c) => !c.startsWith('forced-colors:'));

describe('the watch-time chart', () => {
  it('draws live in the mark tone and movies and series in a neutral, never the text accent or a tint of it', () => {
    expect(classes(LIVE_FILL)).toEqual(['bg-accent-mark']);
    expect(classes(VOD_FILL)).toEqual(['bg-fg-muted']);
    for (const fill of [LIVE_FILL, VOD_FILL]) expect(fill).not.toMatch(/(^|\s)bg-accent(\/|\s|$)/);
    // Forced colours drop fills: the two series stay apart as solid and hatched.
    expect(LIVE_FILL).toContain('forced-colors:bg-[CanvasText]');
    expect(VOD_FILL).toContain('forced-colors:bg-[repeating-linear-gradient');
  });

  it('uses the same two fills in the bars, the legend tiles and the KPI dots', async () => {
    h.renderAt('/stats', [{ path: '/stats', element: <StatsPage /> }]);
    const split = await screen.findByTestId('stats-split');
    const dots = within(split).getAllByText((_, el) => el?.tagName === 'SPAN' && el.getAttribute('aria-hidden') === 'true' && el.className.includes('size-2.5'));
    expect(dots.map((d) => d.className.includes('bg-accent-mark'))).toEqual([true, false]);
    expect(dots[1]!.className).toContain('bg-fg-muted');
  });

  it('puts the range control on its own line above a KPI row of four columns', async () => {
    h.renderAt('/stats', [{ path: '/stats', element: <StatsPage /> }]);
    const kpis = await screen.findByTestId('stats-kpis');
    expect(kpis.className).toContain('lg:grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(0,1fr))]');
    // The split's two tiles take two of the row's columns (a subgrid), so every tile shares the row's edges.
    expect(within(kpis).getByTestId('stats-split').className).toContain('lg:grid-cols-subgrid');
    const range = screen.getByRole('tablist', { name: 'Range' });
    expect(range.compareDocumentPosition(kpis) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(kpis.contains(range)).toBe(false);
  });
});
