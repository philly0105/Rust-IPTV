/**
 * Campaign loop 1 (cross-area): the channel menus of the Live list and the guide say "Locked with
 * its group" when the channel's group is locked, and the Live header's guide link keeps its name
 * while its label hides on a phone (so the page title is not squeezed at 390 px).
 */
import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, ItemRef, Page, PageQuery, ParentalLock } from '@/api/types';
import parental from '@/i18n/en/parental.json';

import { resetChannelListMemory } from '../components/ChannelList';
import { EpgGridPage } from '../components/EpgGridPage';
import { LivePage } from '../components/LivePage';
import { i18n, installDomStubs, makeChannel, renderAt, settings } from './harness';

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
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
}));
vi.mock('@/ui', async (orig) => ({ ...(await orig<object>()), ...(await import('./fakes')) }));
vi.mock('@/shell', async () => await import('./fakes'));
vi.mock('@/features/player', async () => await import('./fakes'));
vi.mock('@/features/player/remote', async () => await import('./fakes'));

const fakes = await import('./fakes');

const LIVE = [{ path: '/s/:sourceId/live', element: <LivePage /> }];
const TOTAL = 40;

function baseHandlers() {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  h['sources.get'] = () => ({ id: 'src1', kind: 'xtream', name: 'Demo portal', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } });
  h['sources.list'] = () => [h['sources.get']!({})];
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
  h['epg.grid'] = (a) => Object.fromEntries((a as { refs: ItemRef[] }).refs.map((r) => [`${r.sourceId}|${r.contentType}|${r.itemId}`, []]));
  h['favorites.contains'] = () => [];
  h['remote.status'] = () => ({ running: false, port: 7310 });
  // Ask mode with the News group (g1, every test channel's group) locked.
  h['parental.status'] = () => ({ enabled: true, mode: 'ask', autoAdult: false, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['parental.locks'] = () =>
    [{ sourceId: 'src1', contentType: 'live', kind: 'category', targetId: 'g1', name: 'News', createdAt: '2026-10-15T00:00:00Z' }] satisfies ParentalLock[];
}

beforeAll(() => {
  // The harness loads only the live strings; the lock entries come from the parental ones.
  i18n.addResourceBundle('en', 'parental', parental, true, true);
  configure({ asyncUtilTimeout: 4000 });
  vi.setConfig({ testTimeout: 20_000 });
  installDomStubs();
});
beforeEach(() => {
  baseHandlers();
  resetChannelListMemory();
  fakes.usePlayerStore.setState({ source: undefined, zapContext: undefined });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function expectLockedWithGroup() {
  const menu = await screen.findByRole('menu');
  const entry = await within(menu).findByRole<HTMLButtonElement>('menuitem', { name: 'Locked with its group' });
  expect(entry.disabled).toBe(true);
  expect(within(menu).queryByRole('menuitem', { name: 'Lock channel' })).toBeNull();
}

describe('channel menus in a locked group', () => {
  it('the Live list says "Locked with its group"', async () => {
    renderAt('/s/src1/live', LIVE);
    await screen.findByText('Channel 0');
    const row = document.querySelector<HTMLElement>('[data-testid="channel-list"] [data-row-index="0"]')!.parentElement!;
    fireEvent.contextMenu(row, { clientX: 40, clientY: 40 });
    await expectLockedWithGroup();
  });

  it('the guide says "Locked with its group"', async () => {
    renderAt('/epg?source=src1', [{ path: '/epg', element: <EpgGridPage /> }]);
    const header = await screen.findByRole('rowheader', { name: /Channel 0/ });
    fireEvent.contextMenu(header.closest('[role="row"]')!, { clientX: 40, clientY: 40 });
    await expectLockedWithGroup();
  });
});

describe('Live header guide link', () => {
  it('keeps its name while the label hides on a phone', async () => {
    renderAt('/s/src1/live', LIVE);
    await waitFor(() => expect(fakes.lastHeader()?.actions).toBeTruthy());
    const actions = fakes.lastHeader()!.actions;
    cleanup();
    renderAt('/', [{ path: '/', element: <>{actions}</> }]);
    const link = screen.getByRole('link', { name: 'TV guide' });
    expect(link.getAttribute('aria-label')).toBe('TV guide');
    expect(within(link).getByText('TV guide').className).toContain('max-sm:sr-only');
  });
});
