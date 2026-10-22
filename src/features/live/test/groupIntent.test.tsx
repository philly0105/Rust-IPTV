/**
 * NAV-1: a pointer resting on a group's link asks for the group's first page, its now/next and its
 * favourite flags under the keys the page reads, so the click shows complete rows at once instead
 * of the old rows dimmed, then names, then programme titles. Links that scroll under a still
 * pointer ask for nothing.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Profiler } from 'react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { channelPageArgs, favoritesContainsArgs, nowNextArgs } from '@/api/bootPrefetch';
import { queryClient } from '@/api/query';
import type { ItemRef, PageQuery } from '@/api/types';
import { resetRouteIntentForTests, ROUTE_REST_MS } from '@/shell/routeIntent';

import { resetChannelListMemory } from '../components/ChannelList';
import { LivePage } from '../components/LivePage';
import { MINUTE } from '../lib/epgTime';
import { i18n, installDomStubs, makeChannel, program, settings } from './harness';

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

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<object>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/ui', async (orig) => ({ ...(await orig<object>()), ...(await import('./fakes')) }));
vi.mock('@/shell', async () => await import('./fakes'));
vi.mock('@/features/player', async () => await import('./fakes'));
vi.mock('@/features/player/remote', async () => await import('./fakes'));

/** Each group's channels: News holds c0-c29, Sport c100-c129. */
const GROUP_BASE: Record<string, number> = { g1: 0, g2: 100 };
const ROWS = 30;
const groupRefs = (g: string) => Array.from({ length: ROWS }, (_, i) => makeChannel(GROUP_BASE[g]! + i).ref);
const after = (from: number, cmd: string) => rpcMock.calls.slice(from).filter((c) => c.cmd === cmd).map((c) => c.args);
const PAGE_CMDS = ['catalog.channels', 'epg.nowNext', 'favorites.contains'];

let commits = 0;

function renderLive(path: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/s/:sourceId/live/:categoryId?"
              element={
                <Profiler id="live" onRender={() => void commits++}>
                  <LivePage />
                </Profiler>
              }
            />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

const sportLink = () => document.querySelector<HTMLElement>('[data-cat-index="1"]')!;
const move = (x: number, y: number) => act(() => void window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y })));
const rest = () => act(() => new Promise((r) => setTimeout(r, ROUTE_REST_MS + 30)));

/** Clicks Sport and waits for its first 15 rows with their programme titles. */
async function openSport() {
  const sent = rpcMock.calls.length;
  commits = 0;
  const t0 = performance.now();
  fireEvent.click(sportLink());
  await waitFor(() => {
    for (let i = 0; i < 15; i++) expect(screen.getByText(`c${100 + i} show`)).toBeTruthy();
  });
  return { sent, commits, ms: performance.now() - t0, requests: rpcMock.calls.slice(sent).filter((c) => PAGE_CMDS.includes(c.cmd)).length };
}

vi.setConfig({ testTimeout: 20_000 });
beforeAll(() => {
  configure({ asyncUtilTimeout: 8000 });
  installDomStubs();
});
beforeEach(async () => {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  h['sources.get'] = () => ({ id: 'src1', kind: 'm3u', name: 'Demo', channelCount: 60, movieCount: 0, seriesCount: 0, epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } });
  h['sources.list'] = () => [h['sources.get']!({})];
  h['settings.get'] = () => settings();
  h['catalog.categories'] = () => [
    { id: 'g1', sourceId: 'src1', contentType: 'live', name: 'News', hidden: false, itemCount: ROWS, position: 0 },
    { id: 'g2', sourceId: 'src1', contentType: 'live', name: 'Sport', hidden: false, itemCount: ROWS, position: 1 },
  ];
  h['catalog.channels'] = (a) => {
    const { categoryId, query: q } = a as { categoryId: string; query: PageQuery };
    const all = Array.from({ length: ROWS }, (_, i) => makeChannel(GROUP_BASE[categoryId]! + i));
    return { items: all.slice(q.offset, q.offset + q.limit), total: ROWS, offset: q.offset, limit: q.limit };
  };
  const now = Date.now();
  h['epg.nowNext'] = (a) =>
    Object.fromEntries(
      (a as { refs: ItemRef[] }).refs.map((r) => [`${r.sourceId}|${r.contentType}|${r.itemId}`, { now: program(`${r.itemId} show`, now - 10 * MINUTE, now + 20 * MINUTE) }]),
    );
  h['favorites.contains'] = () => [];
  h['favorites.list'] = () => [];
  h['recent.list'] = () => [];
  h['remote.status'] = () => ({ running: false, port: 7310 });
  resetChannelListMemory();
  queryClient.clear();
  renderLive('/s/src1/live/g1');
  await screen.findByText('c0 show');
});
afterEach(() => {
  cleanup();
  resetRouteIntentForTests();
});

describe("a group link's rest (NAV-1)", () => {
  it('without a rest, the click asks for the page and then for its now/next and favourite flags', async () => {
    const open = await openSport();
    console.log(`[measure NAV-1 group switch, no rest] page requests after the click ${open.requests}, LivePage commits to titled rows ${open.commits}, ${open.ms.toFixed(0)} ms`);
    expect(after(open.sent, 'catalog.channels')).toEqual([channelPageArgs({ sourceId: 'src1', categoryId: 'g2' }, 0)]);
    expect(after(open.sent, 'epg.nowNext')).toHaveLength(1);
  });

  it("asks for the group's page, now/next and favourite flags under the page's keys, so the click sends none", async () => {
    const sent = rpcMock.calls.length;
    move(5, 5);
    fireEvent.pointerEnter(sportLink());
    await rest();
    const sport = groupRefs('g2');
    await waitFor(() => expect(after(sent, 'favorites.contains')).toEqual([favoritesContainsArgs(sport)]));
    expect(after(sent, 'catalog.channels')).toEqual([channelPageArgs({ sourceId: 'src1', categoryId: 'g2' }, 0)]);
    expect(after(sent, 'epg.nowNext')).toEqual([nowNextArgs(sport, 0)]);

    const open = await openSport();
    console.log(`[measure NAV-1 group switch, after a rest] page requests after the click ${open.requests}, LivePage commits to titled rows ${open.commits}, ${open.ms.toFixed(0)} ms`);
    expect(open.requests).toBe(0);
  });

  it('a group list scrolling under a still pointer asks for nothing until the pointer moves', async () => {
    move(5, 5);
    const sent = rpcMock.calls.length;
    fireEvent.scroll(screen.getByTestId('group-list'));
    // Chromium's hover update after the scroll: pointerenter on the link now under the pointer.
    fireEvent.pointerEnter(sportLink());
    move(5, 5);
    await rest();
    await rest();
    expect(rpcMock.calls.slice(sent).filter((c) => PAGE_CMDS.includes(c.cmd))).toEqual([]);

    move(7, 5);
    await rest();
    await waitFor(() => expect(after(sent, 'catalog.channels')).toEqual([channelPageArgs({ sourceId: 'src1', categoryId: 'g2' }, 0)]));
  });
});
