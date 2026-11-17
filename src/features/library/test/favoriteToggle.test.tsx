// @vitest-environment jsdom
// states-feedback-01/02: the shared favourite toggle names what changed, a removal carries an
// Undo that restores the old place, and the title page's heart keeps focus while it saves.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type { FavoriteEntry, ItemRef } from '@/api/types';
import { ToastViewport, useToastStore } from '@/ui';

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
const { toggleFavoriteWithUndo } = await import('../lib/favoriteToggle');
const { FavoriteButton } = await import('@/features/vod/components/detail/actions');

const ref = (itemId: string): ItemRef => ({ sourceId: 's1', contentType: 'live', itemId });
const entry = (itemId: string, position: number): FavoriteEntry => ({
  ref: ref(itemId),
  snapshot: { title: itemId.toUpperCase(), contentType: 'live' },
  position,
  addedAt: '2026-11-01T00:00:00Z',
});

/** The core's favourites in miniature: toggle appends at the end, reorder rewrites positions. */
let favs: FavoriteEntry[] = [];
beforeEach(() => {
  rpc.reset();
  favs = [entry('a', 0), entry('b', 1), entry('c', 2)];
  rpc.handlers['favorites.list'] = () => favs;
  rpc.handlers['favorites.contains'] = (a) => (a as { refs: ItemRef[] }).refs.filter((r) => favs.some((f) => f.ref.itemId === r.itemId));
  rpc.handlers['favorites.toggle'] = (a) => {
    const { ref: r, snapshot } = a as { ref: ItemRef; snapshot: FavoriteEntry['snapshot'] };
    if (favs.some((f) => f.ref.itemId === r.itemId)) {
      favs = favs.filter((f) => f.ref.itemId !== r.itemId);
      return { isFavorite: false };
    }
    favs = [...favs, { ref: r, snapshot, position: favs.length, addedAt: '2026-11-02T00:00:00Z' }];
    return { isFavorite: true };
  };
  rpc.handlers['favorites.reorder'] = (a) => {
    const refs = (a as { refs: ItemRef[] }).refs;
    favs = refs.map((r, i) => ({ ...favs.find((f) => f.ref.itemId === r.itemId)!, position: i }));
  };
});
afterEach(() => {
  cleanup();
  useToastStore.setState({ toasts: [] });
});

describe('toggleFavoriteWithUndo', () => {
  it('names the channel on add, with no action', async () => {
    favs = [];
    await expect(toggleFavoriteWithUndo(ref('x'), { title: 'X', contentType: 'live' }, 'ESPN2', false)).resolves.toBe(true);
    const [t] = useToastStore.getState().toasts;
    expect(t?.title).toBe('Added ESPN2 to favorites');
    expect(t?.action).toBeUndefined();
  });

  it('offers Undo on removal, and Undo puts the favourite back in its old place', async () => {
    await expect(toggleFavoriteWithUndo(ref('b'), { title: 'B', contentType: 'live' }, 'B', true)).resolves.toBe(false);
    expect(favs.map((f) => f.ref.itemId)).toEqual(['a', 'c']);
    const [t] = useToastStore.getState().toasts;
    expect(t?.title).toBe('Removed B from favorites');
    expect(t?.variant).toBe('info');
    act(() => t?.action?.onClick());
    await waitFor(() => expect(favs.map((f) => f.ref.itemId)).toEqual(['a', 'b', 'c']));
  });

  it('says what failed and resolves undefined', async () => {
    rpc.handlers['favorites.toggle'] = () => {
      throw new Error('database is locked');
    };
    await expect(toggleFavoriteWithUndo(ref('x'), { title: 'X', contentType: 'live' }, 'X', false)).resolves.toBeUndefined();
    expect(useToastStore.getState().toasts[0]?.variant).toBe('error');
  });
});

describe('FavoriteButton on a title page', () => {
  it('flips at once and keeps keyboard focus while the call runs', async () => {
    let answer: (v: { isFavorite: boolean }) => void = () => undefined;
    rpc.handlers['favorites.toggle'] = () => new Promise((r) => (answer = r));
    favs = [];
    render(
      <>
        <FavoriteButton itemRef={ref('m')} snapshot={{ title: 'Heat', contentType: 'movie' }} isFavorite={false} round />
        <ToastViewport />
      </>,
    );
    const btn = screen.getByTestId('vod-favorite-button');
    btn.focus();
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn).not.toHaveProperty('disabled', true);
    expect(document.activeElement).toBe(btn);
    // A second press while saving is ignored.
    fireEvent.click(btn);
    await waitFor(() => expect(rpc.callsOf('favorites.toggle')).toHaveLength(1));
    await act(async () => answer({ isFavorite: true }));
    await waitFor(() => expect(useToastStore.getState().toasts[0]?.title).toBe('Added Heat to favorites'));
    expect(document.activeElement).toBe(btn);
  });
});
