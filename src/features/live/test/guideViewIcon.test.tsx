/**
 * The guide's view picker marks Favorites with Live TV's heart (round 3 moved Live's favourites
 * from a star to a heart; the guide kept the star, so one view had two icons a button apart).
 */
import { cleanup, configure, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, Channel, Page, PageQuery } from '@/api/types';

import { defaultStart, EpgGridPage } from '../components/EpgGridPage';
import { createRpcMock, installDomStubs, makeChannel, renderGuide, settings } from '../guide/test/harness';
import { HeaderSlot } from './fakes';

const rpcMock = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import('../guide/test/harness')['createRpcMock']> }));
vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<object>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  isDesktop: true,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined, getConnectionState: () => 'closed' }));
vi.mock('@/shell', async () => await import('./fakes'));
vi.mock('@/features/player', async () => await import('./fakes'));
vi.mock('@/features/player/remote', async () => await import('./fakes'));

rpcMock.current = createRpcMock();
const rpc = rpcMock.current;

const CHANNELS = Array.from({ length: 10 }, (_, i) => makeChannel(i));
const cat = (id: string, name: string, itemCount: number): Category => ({ id, sourceId: 'src1', contentType: 'live', name, hidden: false, itemCount, position: 0 });

beforeAll(() => {
  installDomStubs();
  configure({ asyncUtilTimeout: 4000 });
  vi.setConfig({ testTimeout: 20_000 });
});
beforeEach(() => {
  rpc.reset();
  const h = rpc.handlers;
  h['sources.list'] = () => [{ id: 'src1', kind: 'm3u', name: 'Demo', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } }];
  h['settings.get'] = () => settings();
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['catalog.categories'] = () => [cat('g1', 'News', CHANNELS.length)];
  h['catalog.channels'] = (a) => {
    const { query: q } = a as { query: PageQuery };
    return { items: CHANNELS.slice(q.offset, q.offset + q.limit), total: CHANNELS.length, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
  h['epg.grid'] = (a) => Object.fromEntries((a as { refs: Channel['ref'][] }).refs.map((r) => [`${r.sourceId}|${r.contentType}|${r.itemId}`, []]));
  h['epg.sources'] = () => [];
  h['epg.search'] = () => [];
  h['reminders.list'] = () => [];
  h['recordings.list'] = () => [];
  h['recordings.rules'] = () => [];
  h['recordings.capabilities'] = () => ({ supported: true });
  h['channels.edits'] = () => [];
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the guide's view picker", () => {
  it("marks Favorites with Live TV's heart, not a star", async () => {
    renderGuide({
      path: `/epg?source=src1&at=${defaultStart(Date.now())}`,
      routes: [
        {
          path: '/epg',
          element: (
            <>
              <HeaderSlot />
              <EpgGridPage />
            </>
          ),
        },
      ],
    });
    await screen.findByText('Channel 0');
    const picker = screen.getByTestId('guide-group');
    fireEvent.click(within(picker).queryByRole('button') ?? picker);
    const option = (await screen.findAllByText('Favorites')).map((el) => el.closest('[role=option], button, li')).find(Boolean)!;
    expect(option.querySelector('svg.lucide-heart')).not.toBeNull();
    expect(option.querySelector('svg.lucide-star')).toBeNull();
  });
});
