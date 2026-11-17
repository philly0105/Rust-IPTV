/**
 * The guide's "With guide data" view (realdata-03): on a patchy guide most rows of All channels
 * say "No guide data". The view reads the source's channels a page at a time, keeps the ones
 * `epg.grid` has programmes for, and reads only as far as the rows on screen need.
 */
import { cleanup, configure, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemRef } from '@/api/types';

import { defaultStart, EpgGridPage } from '../../components/EpgGridPage';
import { HOUR } from '../../lib/epgTime';
import { GUIDE_SCAN_PAGE } from '../viewChannels';
import { createRpcMock, installDomStubs, makeChannel, program, renderGuide, router, settings } from './harness';

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

const CHANNELS = 1000;
const key = (r: ItemRef) => `${r.sourceId}|${r.contentType}|${r.itemId}`;
const indexOf = (r: ItemRef) => Number(r.itemId.slice(1));
/** One channel in ten has a guide. */
const hasGuide = (i: number) => i % 10 === 3;

const GRID = [{ path: '/epg', element: <EpgGridPage /> }];

beforeAll(() => {
  installDomStubs();
  configure({ asyncUtilTimeout: 8000 });
  vi.setConfig({ testTimeout: 20_000 });
});
beforeEach(() => {
  rpc.reset();
  const h = rpc.handlers;
  const start = defaultStart(Date.now());
  h['sources.list'] = () => [{ id: 'src1', kind: 'm3u', name: 'Demo', channelCount: CHANNELS, epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } }];
  h['settings.get'] = () => settings();
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['catalog.categories'] = () => [];
  h['lists.list'] = () => [];
  h['catalog.channels'] = (a) => {
    const { offset, limit } = (a as { query: { offset: number; limit: number } }).query;
    const items = Array.from({ length: Math.max(0, Math.min(limit, CHANNELS - offset)) }, (_, i) => makeChannel(offset + i));
    return { items, total: CHANNELS, offset, limit };
  };
  h['epg.grid'] = (a) =>
    Object.fromEntries((a as { refs: ItemRef[] }).refs.map((r) => [key(r), hasGuide(indexOf(r)) ? [program(`${r.itemId} show`, start, start + HOUR)] : []]));
  h['epg.sources'] = () => [{ url: 'http://guide', origin: 'settings', enabled: true, status: 'ok', programCount: 100, channelCount: 10 }];
  h['epg.nowNext'] = () => ({});
  h['epg.search'] = () => [];
  h['favorites.contains'] = () => [];
  h['reminders.list'] = () => [];
  h['recordings.list'] = () => [];
  h['recordings.rules'] = () => [];
  h['recordings.capabilities'] = () => ({ supported: true });
  h['channels.edits'] = () => [];
});
afterEach(() => cleanup());

describe('the guide\'s "With guide data" view (realdata-03)', () => {
  it('shows only the channels with programmes, and reads only the pages the screen needs', async () => {
    renderGuide({ path: `/epg?source=src1&view=withGuide&at=${defaultStart(Date.now())}`, routes: GRID });
    await screen.findByTestId('epg-grid');
    await waitFor(() => {
      for (const i of [3, 13, 23, 33]) expect(screen.getByText(`c${i} show`)).toBeTruthy();
    });
    // The rows are the channels with a guide, in channel order, with no empty rows between them.
    const names = Array.from(document.querySelectorAll<HTMLElement>('[data-channel-row]')).slice(0, 4).map((b) => b.title);
    expect(names).toEqual(['Play Channel 3', 'Play Channel 13', 'Play Channel 23', 'Play Channel 33']);
    expect(screen.queryByTestId('no-guide-band')).toBeNull();
    // It stops once the rows on screen and the ones after them are found: not all 1000 channels.
    await new Promise((r) => setTimeout(r, 200));
    const pages = (rpc.of('catalog.channels') as { query: { offset: number } }[]).map((a) => a.query.offset);
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.length).toBeLessThan(CHANNELS / GUIDE_SCAN_PAGE);
    expect(new Set(pages).size).toBe(pages.length);
  });

  it('is offered in the group picker once a guide holds programmes', async () => {
    renderGuide({ path: `/epg?source=src1&at=${defaultStart(Date.now())}`, routes: GRID });
    await screen.findByTestId('epg-grid');
    fireEvent.click(screen.getByTestId('guide-group'));
    fireEvent.click(await screen.findByRole('option', { name: /With guide data/ }));
    await waitFor(() => expect(router.location?.search).toContain('view=withGuide'));
  });

  it('says so when no channel has guide data', async () => {
    rpc.handlers['epg.grid'] = (a) => Object.fromEntries((a as { refs: ItemRef[] }).refs.map((r) => [key(r), []]));
    renderGuide({ path: `/epg?source=src1&view=withGuide&at=${defaultStart(Date.now())}`, routes: GRID });
    expect(await screen.findByText('No channels from this source have guide data now')).toBeTruthy();
    expect(rpc.of('catalog.channels')).toHaveLength(CHANNELS / GUIDE_SCAN_PAGE);
  });
});
