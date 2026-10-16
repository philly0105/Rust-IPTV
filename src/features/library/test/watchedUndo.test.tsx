// @vitest-environment jsdom
// B6 round 3 (R3-library F3): Mark watched / unwatched toasts carry an Undo
// that puts the changed or removed rows back with their original time (C14).
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemRef, PlaybackPosition } from '@/api/types';
import library from '@/i18n/en/library.json';
import vod from '@/i18n/en/vod.json';
import { useToastStore } from '@/ui';

const rpcMock = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import('./harness')['createRpcMock']> }));
vi.mock('@/api/transport', () => {
  class RpcError extends Error {
    code = 'internal';
    static from(err: unknown) {
      return err instanceof RpcError ? err : new RpcError(err instanceof Error ? err.message : String(err));
    }
  }
  return {
    rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
    rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
    isDesktop: false,
    RpcError,
    proxiedUrl: (s: { url: string }) => s.url,
  };
});
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));

const harness = await import('./harness');
rpcMock.current = harness.createRpcMock();
const rpc = rpcMock.current;
const { queryClient } = await import('@/api/query');
const { WatchedButton } = await import('@/features/vod/components/detail/actions');

const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['vod', 'library'],
  defaultNS: 'vod',
  resources: { en: { vod, library } },
  interpolation: { escapeValue: false },
  initAsync: false,
});

/** The core's position table in miniature: setWatched, remove and dated set (newer only). */
let rows: PlaybackPosition[] = [];
const key = (r: { ref: ItemRef; episodeId?: string }) => `${r.ref.itemId}|${r.episodeId ?? ''}`;
const NOW = '2026-10-12T12:00:00.000Z';
function installCore() {
  const drop = (a: { ref: ItemRef; episodeId?: string }) => {
    rows = rows.filter((r) => key(r) !== key(a));
  };
  rpc.handlers['positions.get'] = (a) => rows.find((r) => key(r) === key(a as PlaybackPosition)) ?? null;
  rpc.handlers['positions.forSeries'] = (a) => rows.filter((r) => r.ref.itemId === (a as { ref: ItemRef }).ref.itemId);
  rpc.handlers['positions.remove'] = (a) => drop(a as PlaybackPosition);
  rpc.handlers['userstate.setWatched'] = (raw) => {
    const a = raw as { ref: ItemRef; episodeId?: string; watched: boolean };
    const old = rows.find((r) => key(r) === key(a));
    drop(a);
    if (!a.watched) return;
    const at = old?.durationSeconds ?? old?.positionSeconds ?? 0;
    rows.push({ ...(old ?? { ref: a.ref, ...(a.episodeId ? { episodeId: a.episodeId } : {}) }), positionSeconds: at, watched: true, updatedAt: NOW } as PlaybackPosition);
  };
  rpc.handlers['positions.set'] = (raw) => {
    const a = raw as PlaybackPosition & { updatedAt?: string; watched?: boolean };
    const old = rows.find((r) => key(r) === key(a));
    const updatedAt = a.updatedAt ?? NOW;
    if (old && a.updatedAt && Date.parse(a.updatedAt) <= Date.parse(old.updatedAt)) return;
    drop(a);
    rows.push({ ...a, watched: a.watched ?? false, updatedAt });
  };
}

function lastToast() {
  const toasts = useToastStore.getState().toasts;
  return toasts[toasts.length - 1];
}
function renderButton(props: Parameters<typeof WatchedButton>[0]) {
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <WatchedButton {...props} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}
const sorted = (list: PlaybackPosition[]) => [...list].sort((a, b) => key(a).localeCompare(key(b)));

beforeAll(harness.installDomStubs);
beforeEach(() => {
  rpc.reset();
  useToastStore.setState({ toasts: [] });
  installCore();
});
afterEach(cleanup);

describe('Mark watched / unwatched Undo (D33)', () => {
  const movie: ItemRef = { sourceId: 'src1', contentType: 'movie', itemId: 'm1' };
  const show: ItemRef = { sourceId: 'src1', contentType: 'series', itemId: 's1' };

  it('Mark watched on a half-watched movie: Undo brings back the resume point and its time', async () => {
    const original: PlaybackPosition = {
      ref: movie,
      positionSeconds: 1800,
      durationSeconds: 6000,
      watched: false,
      updatedAt: '2026-10-01T10:00:00.000Z',
      snapshot: { title: 'Film', contentType: 'movie' },
    };
    rows = [original];
    renderButton({ itemRef: movie, watched: false });
    fireEvent.click(screen.getByRole('button', { name: 'Mark as watched' }));
    await waitFor(() => expect(lastToast()?.action?.label).toBe('Undo'));
    expect(rows[0]).toMatchObject({ watched: true, updatedAt: NOW });

    lastToast()!.action!.onClick();
    await waitFor(() => expect(rows).toEqual([original]));
  });

  it('Mark unwatched on watched episodes: Undo restores them watched, with their times', async () => {
    const e1: PlaybackPosition = { ref: show, episodeId: 'e1', positionSeconds: 1200, durationSeconds: 1200, watched: true, updatedAt: '2026-10-02T10:00:00.000Z' };
    const e2: PlaybackPosition = { ref: show, episodeId: 'e2', positionSeconds: 300, durationSeconds: 1200, watched: false, updatedAt: '2026-10-03T10:00:00.000Z' };
    const other: PlaybackPosition = { ref: show, episodeId: 'e9', positionSeconds: 50, durationSeconds: 1200, watched: false, updatedAt: '2026-10-04T10:00:00.000Z' };
    rows = [e1, e2, other];
    renderButton({ itemRef: show, episodeIds: ['e1', 'e2', 'e3'], watched: true });
    fireEvent.click(screen.getByRole('button', { name: 'Mark as unwatched' }));
    await waitFor(() => expect(lastToast()?.action?.label).toBe('Undo'));
    expect(rows).toEqual([other]);

    lastToast()!.action!.onClick();
    await waitFor(() => expect(sorted(rows)).toEqual(sorted([e1, e2, other])));
    // e3 had no row before, and none is left behind.
    expect(rows.some((r) => r.episodeId === 'e3')).toBe(false);
  });

  it('Undo refreshes My List and the grid pages Hide watched filters, not only positions', async () => {
    rows = [{ ref: movie, positionSeconds: 600, durationSeconds: 6000, watched: false, updatedAt: '2026-10-01T10:00:00.000Z' }];
    renderButton({ itemRef: movie, watched: false });
    fireEvent.click(screen.getByRole('button', { name: 'Mark as watched' }));
    await waitFor(() => expect(lastToast()?.action?.label).toBe('Undo'));

    // Fresh copies after the mark: only the Undo can make them stale now.
    const grid = ['catalog.movies', { sourceId: 'src1', query: { offset: 0, limit: 60 }, hideWatched: true }] as const;
    const plainGrid = ['catalog.movies', { sourceId: 'src1', query: { offset: 0, limit: 60 } }] as const;
    const myList = ['watchlist.list', {}] as const;
    for (const k of [grid, plainGrid, myList]) queryClient.setQueryData(k, []);
    const stale = (k: readonly unknown[]) => queryClient.getQueryState(k)?.isInvalidated ?? false;

    lastToast()!.action!.onClick();
    await waitFor(() => expect(stale(grid)).toBe(true));
    expect(stale(myList)).toBe(true);
    // A grid without Hide watched shows the same titles either way.
    expect(stale(plainGrid)).toBe(false);
  });

  it('a failed snapshot still marks, just without Undo', async () => {
    rpc.handlers['positions.get'] = () => {
      throw new Error('offline');
    };
    renderButton({ itemRef: movie, watched: false });
    fireEvent.click(screen.getByRole('button', { name: 'Mark as watched' }));
    await waitFor(() => expect(lastToast()?.title).toBe(vod.markedWatched));
    expect(lastToast()?.action).toBeUndefined();
  });
});
