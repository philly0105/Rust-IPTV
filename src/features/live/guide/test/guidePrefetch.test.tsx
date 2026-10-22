/**
 * The guide's first data asked ahead (NAV-1): `prefetchScreenData('/epg…')` asks for the first
 * channel page and, once the guide has laid out a window this session, the first grid chunk, under
 * exactly the keys the page reads, so the page sends none of those requests itself.
 */
import { cleanup, configure, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prefetchScreenData } from '@/api/bootPrefetch';
import { queryClient } from '@/api/query';
import type { Channel, EpgProgram, ItemRef, Page, PageQuery } from '@/api/types';

import { defaultStart, EpgGridPage } from '../../components/EpgGridPage';
import { HOUR } from '../../lib/epgTime';
import { createRpcMock, installDomStubs, makeChannel, program, renderGuide, settings } from './harness';

const rpcMock = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import('./harness')['createRpcMock']> }));
vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<object>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  isDesktop: true,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/shell', async () => await import('../../test/fakes'));
vi.mock('@/features/player', async () => await import('../../test/fakes'));
vi.mock('@/features/player/remote', async () => await import('../../test/fakes'));

rpcMock.current = createRpcMock();
const rpc = rpcMock.current;

const CHANNELS = Array.from({ length: 30 }, (_, i) => makeChannel(i));
const key = (r: ItemRef) => `${r.sourceId}|${r.contentType}|${r.itemId}`;
const GRID = [{ path: '/epg', element: <EpgGridPage /> }];

beforeAll(() => {
  installDomStubs();
  configure({ asyncUtilTimeout: 8000 });
  vi.setConfig({ testTimeout: 20_000 });
});
beforeEach(() => {
  rpc.reset();
  queryClient.clear();
  const h = rpc.handlers;
  const at = defaultStart(Date.now());
  h['sources.list'] = () => [{ id: 'src1', kind: 'm3u', name: 'Demo', channelCount: CHANNELS.length, epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } }];
  h['settings.get'] = () => settings({ epgOffsetMinutes: 60 });
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['catalog.categories'] = () => [];
  h['catalog.channels'] = (a) => {
    const { query: q } = a as { query: PageQuery };
    return { items: CHANNELS.slice(q.offset, q.offset + q.limit), total: CHANNELS.length, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
  h['epg.grid'] = (a) =>
    Object.fromEntries(
      (a as { refs: ItemRef[] }).refs.map((r) => {
        const list: EpgProgram[] = [program(`${r.itemId} now`, at, at + HOUR)];
        return [key(r), list];
      }),
    );
  h['epg.programs'] = () => [];
  h['epg.sources'] = () => [];
  h['epg.search'] = () => [];
  h['lists.list'] = () => [];
  h['reminders.list'] = () => [];
  h['recordings.list'] = () => [];
  h['recordings.rules'] = () => [];
  h['recordings.capabilities'] = () => ({ supported: true });
  h['channels.edits'] = () => [];
});
afterEach(() => cleanup());

describe('the guide asked for ahead (NAV-1)', () => {
  it('a return to the guide gets its channels and first grid chunk before the page renders, and the page asks for neither', async () => {
    // The first visit lays out a window: its length is what the prefetch needs.
    const first = renderGuide({ path: '/epg?source=src1', routes: GRID }, queryClient);
    await screen.findByText('c1 now');
    const firstGrid = rpc.of('epg.grid')[0];
    first.unmount();
    queryClient.clear();
    rpc.calls.length = 0;

    prefetchScreenData('/epg?source=src1');
    await waitFor(() => expect(rpc.of('epg.grid')).toHaveLength(1));
    // Under the page's own arguments, the guide offset included.
    expect(rpc.of('epg.grid')[0]).toEqual(firstGrid);
    expect(rpc.of('catalog.channels')).toHaveLength(1);
    expect(rpc.of('catalog.categories')).toEqual([{ sourceId: 'src1', contentType: 'live' }]);

    renderGuide({ path: '/epg?source=src1', routes: GRID }, queryClient);
    await screen.findByText('c1 now');
    await new Promise((r) => setTimeout(r, 200));
    expect(rpc.of('epg.grid')).toHaveLength(1);
    expect(rpc.of('catalog.channels')).toHaveLength(1);
    expect(rpc.of('catalog.categories')).toHaveLength(1);
  });
});
