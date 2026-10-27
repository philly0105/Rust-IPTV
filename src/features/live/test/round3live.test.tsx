/**
 * Review round 3, Live: the idle stage keeps a locked channel's programme back in parental Ask
 * mode, as its row and the ribbon do, and hides it again once a session unlock runs out.
 */

import { act, cleanup, configure, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, ItemRef, Page, PageQuery, ParentalLock, ParentalStatus } from '@/api/types';

import { LivePage } from '../components/LivePage';
import { StageIdle } from '../components/StageIdle';
import { MINUTE } from '../lib/epgTime';
import { i18n, installDomStubs, makeChannel, program, settings } from './harness';

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

configure({ asyncUtilTimeout: 4000 });
vi.setConfig({ testTimeout: 20_000 });
beforeAll(installDomStubs);
afterEach(cleanup);

const askLocked: ParentalStatus = { enabled: true, mode: 'ask', autoAdult: false, unlockMinutes: 15, unlocked: false, failedAttempts: 0 };

describe('the idle stage and a locked channel (review round 3)', () => {
  it('keeps the programme back and says the channel is locked', () => {
    const now = Date.now();
    render(
      <I18nextProvider i18n={i18n}>
        <StageIdle kind="live" now={now} locked last={{ channel: makeChannel(2), nowNext: { now: program('Late Match', now - 10 * MINUTE, now + 50 * MINUTE) } }} />
      </I18nextProvider>,
    );
    expect(screen.queryByTestId('stage-idle-now')).toBeNull();
    expect(screen.queryByText(/Late Match/)).toBeNull();
    expect(screen.getByTestId('stage-idle-locked').textContent).toBe('Locked');
    expect(screen.getByTestId('stage-resume').getAttribute('aria-label')).toBe('Resume Channel 2');
  });

  describe('on Live', () => {
    const TOTAL = 30;
    beforeEach(() => {
      const h = rpcMock.handlers;
      for (const k of Object.keys(h)) delete h[k];
      const src = { id: 'src1', kind: 'xtream', name: 'Demo', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } };
      h['sources.get'] = () => src;
      h['sources.list'] = () => [src];
      h['settings.get'] = () => settings();
      h['settings.update'] = () => settings();
      h['catalog.categories'] = () => [{ id: 'g1', sourceId: 'src1', contentType: 'live', name: 'News', hidden: false, itemCount: TOTAL, position: 0 }];
      h['catalog.channels'] = (a) => {
        const q = (a as { query: PageQuery }).query;
        const items = Array.from({ length: Math.max(0, Math.min(q.limit, TOTAL - q.offset)) }, (_, i) => makeChannel(q.offset + i));
        return { items, total: TOTAL, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
      };
      h['catalog.item'] = (a) => makeChannel(Number((a as { ref: ItemRef }).ref.itemId.slice(1)));
      const now = Date.now();
      h['epg.nowNext'] = (a) =>
        Object.fromEntries((a as { refs: ItemRef[] }).refs.map((r) => [`${r.sourceId}|${r.contentType}|${r.itemId}`, { now: program(`${r.itemId} show`, now - 10 * MINUTE, now + 50 * MINUTE) }]));
      h['epg.programs'] = () => [];
      h['favorites.contains'] = () => [];
      h['remote.status'] = () => ({ running: false, port: 7310 });
      h['lists.list'] = () => [];
      // Channel 7 was watched last, and asks for the PIN.
      h['recent.list'] = () => [{ ref: makeChannel(7).ref, snapshot: { title: 'Channel 7', contentType: 'live' }, viewedAt: new Date().toISOString() }];
      h['parental.status'] = () => askLocked;
      h['parental.locks'] = (): ParentalLock[] => [
        { sourceId: 'src1', contentType: 'live', kind: 'item', targetId: 'c7', name: 'Channel 7', createdAt: '2026-10-01T10:00:00Z' } as ParentalLock,
      ];
    });

    it('the card shows the programme only while a session unlock lasts', async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      render(
        <QueryClientProvider client={client}>
          <I18nextProvider i18n={i18n}>
            <MemoryRouter initialEntries={['/s/src1/live']}>
              <Routes>
                <Route path="/s/:sourceId/live" element={<LivePage />} />
              </Routes>
            </MemoryRouter>
          </I18nextProvider>
        </QueryClientProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('stage-resume').getAttribute('aria-label')).toBe('Resume Channel 7'));
      expect(await screen.findByTestId('stage-idle-locked')).toBeTruthy();
      expect(screen.queryByTestId('stage-idle-now')).toBeNull();

      // Unlocked: what is on shows.
      act(() => client.setQueryData(['parental.status', null], { ...askLocked, unlocked: true, unlockedUntil: new Date(Date.now() + 15 * MINUTE).toISOString() }));
      await waitFor(() => expect(screen.getByTestId('stage-idle-now').textContent).toContain('c7 show'));
      expect(screen.queryByTestId('stage-idle-locked')).toBeNull();

      // The unlock runs out: the programme goes back behind the PIN.
      act(() => client.setQueryData(['parental.status', null], askLocked));
      await waitFor(() => expect(screen.queryByTestId('stage-idle-now')).toBeNull());
      expect(screen.getByTestId('stage-idle-locked')).toBeTruthy();
    });
  });
});
