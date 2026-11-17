/** Round 3 fix lane live3 (2026-11-17): the Live TV page, its ribbon and the channel list page. */

import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EpgProgram } from '@/api/types';
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

const now = Date.now();
const day: EpgProgram[] = [
  program('Morning Report', now - 30 * MINUTE, now + 30 * MINUTE),
  program('Afternoon Film', now + 30 * MINUTE, now + 2 * HOUR),
  program('Late Movie', now + 6 * HOUR, now + 7 * HOUR),
];

function ribbon(extra: { compact?: boolean } = {}) {
  rpcMock.handlers['epg.programs'] = () => day;
  renderAt('/', [
    {
      path: '/',
      element: <EpgRibbon channel={makeChannel(1)} sourceKind="xtream" watchingLive onPlayLive={() => undefined} onMapEpg={() => undefined} details {...extra} />,
    },
  ]);
}

describe('the stacked stage of a portrait tablet (v-live-01)', () => {
  it('the compact ribbon is the Now card and the timeline, whole: no description, no Up next, no growing', async () => {
    ribbon({ compact: true });
    await screen.findByRole('button', { name: /^Afternoon Film/ }, { timeout: 10_000 });
    expect(screen.queryByTestId('up-next')).toBeNull();
    expect(screen.queryByTestId('ribbon-description')).toBeNull();
    expect(screen.getByTestId('epg-ribbon').className).not.toContain('md:flex-1');
    expect(screen.getByTestId('ribbon-body').className).toContain('h-[104px]');
  });

  it('keeps the list view at the timeline height, two whole rows', async () => {
    rpcMock.handlers['settings.get'] = () => settings({ epgViewMode: 'list' });
    ribbon({ compact: true });
    await screen.findByRole('list', { name: 'List' }, { timeout: 10_000 });
    expect(screen.getByTestId('ribbon-body').className).toContain('h-[104px]');
  });

  it('beside the list the ribbon keeps Up next', async () => {
    ribbon();
    expect(await screen.findByTestId('up-next', {}, { timeout: 10_000 })).toBeTruthy();
    expect(screen.getByTestId('epg-ribbon').className).toContain('md:flex-1');
  });
});
