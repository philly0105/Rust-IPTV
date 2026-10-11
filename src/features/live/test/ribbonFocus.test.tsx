/** R6-r3 F5: the ribbon timeline is reachable by keyboard even with no programme block in its window. */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { EpgRibbon } from '../components/EpgRibbon';
import { HOUR, MINUTE } from '../lib/epgTime';
import { installDomStubs, makeChannel, program, renderAt, settings } from './harness';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const call = async (cmd: string, args?: unknown) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { handlers, call };
});

vi.mock('@/api/transport', () => ({
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
  RpcError: class RpcError extends Error {},
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
}));
vi.mock('@/ui', async (orig) => ({ ...(await orig<object>()), ...(await import('./fakes')) }));
vi.mock('@/shell', async () => await import('./fakes'));
vi.mock('@/features/player', async () => await import('./fakes'));
vi.mock('@/features/player/remote', async () => await import('./fakes'));

beforeAll(installDomStubs);
beforeEach(() => {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  h['sources.get'] = () => ({ id: 'src1', kind: 'm3u', name: 'Big 50k', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } });
  h['sources.list'] = () => [h['sources.get']!({})];
  h['settings.get'] = () => settings();
  h['settings.update'] = () => settings();
});
afterEach(cleanup);

function renderRibbon() {
  renderAt('/', [
    { path: '/', element: <EpgRibbon channel={makeChannel(0)} sourceKind="m3u" watchingLive={false} onPlayLive={() => undefined} onMapEpg={() => undefined} /> },
  ]);
}

describe('ribbon timeline focusability', () => {
  it('makes the scroller the tab stop when no programme falls in the window', async () => {
    const now = Date.now();
    // Guide data exists inside the 12 h fetch window, but beyond the rendered view (about 6 h past now):
    // the timeline mounts with no block in the DOM, as on the reviewer's 50k page.
    rpcMock.handlers['epg.programs'] = () => [program('Late Film', now + 10 * HOUR, now + 11 * HOUR)];
    renderRibbon();
    const timeline = await screen.findByTestId('ribbon-timeline');
    expect(timeline.querySelectorAll('button[data-start]')).toHaveLength(0);
    expect(timeline.getAttribute('tabindex')).toBe('0');
  });

  it('leaves the tab stop on the airing programme when it is rendered', async () => {
    const now = Date.now();
    rpcMock.handlers['epg.programs'] = () => [
      program('Midday Report', now - 30 * MINUTE, now + 30 * MINUTE),
      program('Evening Film', now + 30 * MINUTE, now + 2 * HOUR),
    ];
    renderRibbon();
    const block = await screen.findByRole('button', { name: /Midday Report/ });
    await waitFor(() => expect(block.getAttribute('tabindex')).toBe('0'));
    expect(screen.getByTestId('ribbon-timeline').hasAttribute('tabindex')).toBe(false);
  });
});
