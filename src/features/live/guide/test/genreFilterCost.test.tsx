/**
 * Choosing a genre counts the matching programmes of the rows in memory only (GD-GENRE): on a
 * 50,000-channel guide the click used to walk every row and probe the query cache for each one
 * outside the loaded pages.
 */
import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, EpgProgram, Page, PageQuery } from '@/api/types';

import { defaultStart, EpgGridPage } from '../../components/EpgGridPage';
import { HOUR } from '../../lib/epgTime';
import { createRpcMock, installDomStubs, makeChannel, newClient, program, renderGuide, settings } from './harness';

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

const TOTAL = 50_000;
const key = (r: Channel['ref']) => `${r.sourceId}|${r.contentType}|${r.itemId}`;

beforeAll(() => {
  installDomStubs();
  configure({ asyncUtilTimeout: 8000 });
  vi.setConfig({ testTimeout: 20_000 });
});
beforeEach(() => {
  rpc.reset();
  localStorage.clear();
  const h = rpc.handlers;
  const at = defaultStart(Date.now());
  h['sources.list'] = () => [{ id: 'src1', kind: 'm3u', name: 'Demo', channelCount: TOTAL, epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } }];
  h['settings.get'] = () => settings();
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['catalog.categories'] = () => [];
  h['catalog.channels'] = (a) => {
    const { query: q } = a as { query: PageQuery };
    const items = Array.from({ length: Math.max(0, Math.min(q.limit, TOTAL - q.offset)) }, (_, i) => makeChannel(q.offset + i));
    return { items, total: TOTAL, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
  // Every other channel airs sport, one programme an hour.
  h['epg.grid'] = (a) =>
    Object.fromEntries(
      (a as { refs: Channel['ref'][] }).refs.map((r) => {
        const list: EpgProgram[] = [];
        for (let k = -6; k < 12; k++) list.push({ ...program(`${r.itemId} P${k}`, at + k * HOUR, at + (k + 1) * HOUR), category: Number(r.itemId.slice(1)) % 2 ? 'Sports' : 'News' });
        return [key(r), list];
      }),
    );
  h['epg.programs'] = () => [];
  h['epg.sources'] = () => [{ url: 'http://x/epg.xml', status: 'ok', programCount: 100, channelCount: 10, enabled: true, origin: 'settings' }];
  h['epg.search'] = () => [];
  h['reminders.list'] = () => [];
  h['recordings.list'] = () => [];
  h['recordings.rules'] = () => [];
  h['recordings.capabilities'] = () => ({ supported: true });
  h['channels.edits'] = () => [];
  h['lists.list'] = () => [];
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the genre filter on a 50,000-channel guide (GD-GENRE)', () => {
  it('counts the loaded rows only, and probes the cache for none of the others', async () => {
    const client = newClient();
    renderGuide({ path: `/epg?source=src1&at=${defaultStart(Date.now())}`, routes: [{ path: '/epg', element: <EpgGridPage /> }] }, client);
    await screen.findByRole('button', { name: /^c1 P0,/ });
    const probes = vi.spyOn(client, 'getQueryData');
    const chips = screen.getByRole('group', { name: 'Filter by genre' });
    const t0 = performance.now();
    fireEvent.click(within(chips).getByRole('button', { name: 'Sports' }));
    const clickMs = performance.now() - t0;
    const note = screen.getByTestId('guide-genre-note');
    await waitFor(() => expect(note.textContent).toMatch(/^Filtered to Sports\. Matching programmes: \d+$/));
    const probesInClick = probes.mock.calls.length;
    console.log(`[measure GD-GENRE] getQueryData calls in the click ${probesInClick}, click handler and render ${clickMs.toFixed(1)} ms`);
    // The rows whose guide is in: the first chunk of 40, half of them sport, six programmes each in the 6 h window.
    expect(note.textContent).toBe('Filtered to Sports. Matching programmes: 120');
    expect(probesInClick).toBeLessThan(500);
  });
});
