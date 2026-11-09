/**
 * Render stability of the Live sidebar and the guide ribbon: a parent render with nothing new for
 * a row leaves the row alone, and a page's now/next and favourite keys are hashed once. Group rows count their renders through `useRouteIntent` (one call
 * per render), timeline blocks through `canCatchUp` (one call per render).
 */
import { hashKey } from '@tanstack/react-query';
import { act, cleanup, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category } from '@/api/types';

import { CategorySidebar } from '../components/CategorySidebar';
import { refsKeyHash } from '../hooks/usePagedChannels';
import { EpgRibbon } from '../components/EpgRibbon';
import { MINUTE } from '../lib/epgTime';
import { installDomStubs, makeChannel, program, renderAt, settings } from './harness';

const counts = vi.hoisted(() => ({ intents: 0, catchUps: 0 }));

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
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/ui', async (orig) => ({ ...(await orig<object>()), ...(await import('./fakes')) }));
vi.mock('@/shell', async () => await import('./fakes'));
vi.mock('@/features/player', async () => await import('./fakes'));
vi.mock('@/features/player/remote', async () => await import('./fakes'));
vi.mock('@/shell/routeIntent', () => ({
  useRouteIntent: () => {
    counts.intents++;
    return { onPointerEnter: () => undefined, onPointerLeave: () => undefined, onFocus: () => undefined, onBlur: () => undefined };
  },
}));
vi.mock('../lib/epgTime', async (orig) => {
  const real = await orig<typeof import('../lib/epgTime')>();
  return {
    ...real,
    canCatchUp: (...args: Parameters<typeof real.canCatchUp>) => {
      counts.catchUps++;
      return real.canCatchUp(...args);
    },
  };
});

beforeAll(installDomStubs);
beforeEach(() => {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  h['sources.get'] = () => ({ id: 'src1', kind: 'm3u', name: 'Demo', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } });
  h['sources.list'] = () => [h['sources.get']!({})];
  h['settings.get'] = () => settings();
  h['settings.update'] = () => settings();
  h['reminders.list'] = () => [];
  h['recordings.list'] = () => [];
  counts.intents = 0;
  counts.catchUps = 0;
});
afterEach(cleanup);

const groups: Category[] = Array.from({ length: 12 }, (_, i) => ({
  id: `g${i}`,
  sourceId: 'src1',
  contentType: 'live',
  name: `Group ${i}`,
  hidden: false,
  itemCount: 100 + i,
  position: i,
}));
const hrefFor = (id?: string) => `/s/src1/live${id ? `/${id}` : ''}`;
const noop = () => undefined;

describe('the group sidebar', () => {
  it('re-renders only the rows whose state changed when the open group changes', () => {
    let open: (id: string) => void = noop;
    function Harness() {
      const [active, setActive] = useState('g1');
      open = setActive;
      return (
        <CategorySidebar
          categories={groups}
          hiddenCount={0}
          isLoading={false}
          error={null}
          onRetry={noop}
          activeId={active}
          hrefFor={hrefFor}
          onManage={noop}
          onNavigate={noop}
          onGroupMenu={noop}
          totalLabel="All channels"
        />
      );
    }
    renderAt('/', [{ path: '/', element: <Harness /> }]);
    expect(screen.getByTitle('Group 11')).toBeTruthy();
    counts.intents = 0;
    act(() => open('g2'));
    expect(screen.getByTitle('Group 2').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTitle('Group 1').getAttribute('aria-current')).toBeNull();
    // The group left and the group opened, plus All channels (not memoized): 12 rows rendered again before.
    expect(counts.intents).toBeLessThanOrEqual(3);
  });
});

describe('the guide ribbon timeline', () => {
  it('leaves its blocks alone when the page re-renders it with the same channel', async () => {
    const now = Date.now();
    rpcMock.handlers['epg.programs'] = () => [
      program('Early', now - 70 * MINUTE, now - 10 * MINUTE),
      program('Airing', now - 10 * MINUTE, now + 50 * MINUTE),
      program('Later', now + 50 * MINUTE, now + 110 * MINUTE),
    ];
    const channel = makeChannel(0);
    let bump: () => void = noop;
    function Harness() {
      const [n, setN] = useState(0);
      bump = () => setN((v) => v + 1);
      // A new props object (and a new handler) on every page render, as Live passes it.
      return <EpgRibbon key="ribbon" channel={channel} sourceKind="m3u" watchingLive={n < 0} onPlayLive={() => undefined} onMapEpg={() => undefined} />;
    }
    renderAt('/', [{ path: '/', element: <Harness /> }]);
    expect(await screen.findByRole('button', { name: /Airing/ })).toBeTruthy();
    const blocks = screen.getAllByRole('button').filter((b) => b.hasAttribute('data-start')).length;
    expect(blocks).toBeGreaterThan(0);
    counts.catchUps = 0;
    act(() => bump());
    act(() => bump());
    // Each block rendered again on every page render before (its click handler changed identity).
    expect(counts.catchUps).toBe(0);
  });
});

describe('the keys of a page of refs', () => {
  it('hash as TanStack hashes them, once per refs array and arguments', () => {
    const refs = Array.from({ length: 120 }, (_, i) => makeChannel(i).ref);
    const nowNext = ['epg.nowNext', { refs, withDescription: false }] as const;
    const shifted = ['epg.nowNext', { refs, offsetMinutes: 60, withDescription: false }] as const;
    const favs = ['favorites.contains', { refs }] as const;
    // The same entry as the boot prefetch and setQueryData, which hash with TanStack's own function.
    expect(refsKeyHash(nowNext)).toBe(hashKey(nowNext));
    expect(refsKeyHash(shifted)).toBe(hashKey(shifted));
    expect(refsKeyHash(favs)).toBe(hashKey(favs));
    expect(new Set([refsKeyHash(nowNext), refsKeyHash(shifted), refsKeyHash(favs)]).size).toBe(3);
    // A render with the same page asks again: the answer is the one worked out before, not a new
    // walk over the refs (refs arrays are never changed in place; this one is, to show it).
    const before = refsKeyHash(nowNext);
    (refs as { itemId: string }[])[0]!.itemId = 'changed';
    expect(refsKeyHash(nowNext)).toBe(before);
    expect(refsKeyHash(['epg.nowNext', { refs: [...refs], withDescription: false }])).not.toBe(before);
  });
});
