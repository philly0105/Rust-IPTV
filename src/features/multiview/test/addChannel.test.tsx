/** Putting channels on the wall from outside the page: the gate, the store checks, the menu item. */

import { act, cleanup, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addToWall, replaceOnWall, wallAccepts } from '../addChannel';
import { useMultiviewStore } from '../store';
import { useMultiviewMenuItem } from '../useMultiviewMenuItem';
import { i18n, input, LocationProbe, resetWall } from './harness';

const gate = vi.hoisted(() => ({ ensureUnlocked: (async () => true) as (items: unknown[]) => Promise<boolean> }));
const toasts = vi.hoisted(() => [] as { title?: unknown; description?: unknown; variant?: string; action?: { label: unknown; onClick(): void } }[]);

vi.mock('../parentalGate', () => ({
  ensureUnlocked: (items: unknown[]) => gate.ensureUnlocked(items),
  requestPin: async () => true,
}));

vi.mock('@/ui', async (orig) => ({
  ...(await orig<typeof import('@/ui')>()),
  toast: (t: (typeof toasts)[number]) => {
    toasts.push(t);
    return 'id';
  },
}));

const store = () => useMultiviewStore.getState();

beforeEach(() => {
  resetWall();
  toasts.length = 0;
  gate.ensureUnlocked = vi.fn(async () => true);
});

afterEach(() => cleanup());

describe('addToWall', () => {
  it('asks the gate with the channel, then adds it', async () => {
    const ch = { ...input(1), categoryId: 'g1' };
    await expect(addToWall(ch)).resolves.toBe('added');
    expect(gate.ensureUnlocked).toHaveBeenCalledWith([{ ref: ch.ref, categoryId: 'g1', title: 'Channel 1' }]);
    expect(store().tiles).toHaveLength(1);
  });

  it('does not ask the gate for a duplicate or a full wall', async () => {
    await addToWall(input(1));
    await expect(addToWall(input(1))).resolves.toBe('duplicate');
    for (let i = 2; i <= 4; i++) await addToWall(input(i));
    await expect(addToWall(input(5))).resolves.toBe('full');
    expect(gate.ensureUnlocked).toHaveBeenCalledTimes(4);
  });

  it('adds nothing when the PIN prompt is cancelled', async () => {
    gate.ensureUnlocked = vi.fn(async () => false);
    await expect(addToWall(input(1))).resolves.toBe('cancelled');
    expect(store().tiles).toHaveLength(0);
  });

  it('fails closed when the gate throws', async () => {
    gate.ensureUnlocked = vi.fn(async () => {
      throw new Error('check failed');
    });
    await expect(addToWall(input(1))).resolves.toBe('gateFailed');
    expect(store().tiles).toHaveLength(0);
  });

  it('checks the wall again after the gate: it may have filled meanwhile', async () => {
    for (let i = 1; i <= 3; i++) store().add(input(i));
    gate.ensureUnlocked = vi.fn(async () => {
      store().add(input(9));
      return true;
    });
    await expect(addToWall(input(4))).resolves.toBe('full');
  });

  it('takes live TV only', async () => {
    const radio = { ref: { sourceId: 's', contentType: 'radio' as const, itemId: 'r1' }, title: 'Radio' };
    expect(wallAccepts(radio)).toBe(false);
    expect(wallAccepts(null)).toBe(false);
    await expect(addToWall(radio)).resolves.toBe('unsupported');
    expect(gate.ensureUnlocked).not.toHaveBeenCalled();
  });
});

describe('replaceOnWall', () => {
  it('replaces through the gate and keeps the tile key', async () => {
    store().add(input(1));
    const key = store().tiles[0]!.key;
    await expect(replaceOnWall(key, input(2))).resolves.toBe('replaced');
    expect(store().tiles[0]).toMatchObject({ key, title: 'Channel 2' });
    expect(gate.ensureUnlocked).toHaveBeenCalledTimes(1);
  });

  it('refuses a channel on another tile and a tile that is gone', async () => {
    store().add(input(1));
    store().add(input(2));
    const [a] = store().tiles.map((t) => t.key);
    await expect(replaceOnWall(a!, input(2))).resolves.toBe('duplicate');
    await expect(replaceOnWall('gone', input(3))).resolves.toBe('missing');
  });

  it('keeps the old channel when the PIN prompt is cancelled', async () => {
    store().add(input(1));
    gate.ensureUnlocked = vi.fn(async () => false);
    await expect(replaceOnWall(store().tiles[0]!.key, input(2))).resolves.toBe('cancelled');
    expect(store().tiles[0]!.title).toBe('Channel 1');
  });
});

describe('useMultiviewMenuItem', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={['/live']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                {children}
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </I18nextProvider>
  );

  it('is a disabled "Add to multi-view" without a live channel', () => {
    type MenuInput = Parameters<typeof useMultiviewMenuItem>[0];
    const { result, rerender } = renderHook((ch: MenuInput) => useMultiviewMenuItem(ch), {
      wrapper,
      initialProps: null as MenuInput,
    });
    expect(result.current).toMatchObject({ id: 'multiview-add', label: 'Add to multi-view', disabled: true });
    rerender({ ref: { sourceId: 's', contentType: 'radio', itemId: 'r' }, title: 'Radio' });
    expect(result.current.disabled).toBe(true);
  });

  it('adds the channel and opens /multiview', async () => {
    const { result } = renderHook(() => useMultiviewMenuItem(input(1)), { wrapper });
    expect(result.current.disabled).toBe(false);
    act(() => result.current.onSelect());
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/multiview'));
    expect(store().tiles.map((t) => t.title)).toEqual(['Channel 1']);
  });

  it('says so when the channel is already up, with a way to the wall', async () => {
    store().add(input(1));
    const { result } = renderHook(() => useMultiviewMenuItem(input(1)), { wrapper });
    act(() => result.current.onSelect());
    await waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0]!.title).toBe('Channel 1 is already on the wall');
    expect(screen.getByTestId('location').textContent).toBe('/live');
    act(() => toasts[0]!.action!.onClick());
    expect(screen.getByTestId('location').textContent).toBe('/multiview');
  });

  it('says the wall is full', async () => {
    for (let i = 1; i <= 4; i++) store().add(input(i));
    const { result } = renderHook(() => useMultiviewMenuItem(input(5)), { wrapper });
    act(() => result.current.onSelect());
    await waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0]).toMatchObject({ title: 'Multi-view is full', description: 'Close a tile to add another channel.' });
    expect(screen.getByTestId('location').textContent).toBe('/live');
  });

  it('stays put when the PIN prompt is cancelled', async () => {
    gate.ensureUnlocked = vi.fn(async () => false);
    const { result } = renderHook(() => useMultiviewMenuItem(input(1)), { wrapper });
    act(() => result.current.onSelect());
    await waitFor(() => expect(gate.ensureUnlocked).toHaveBeenCalled());
    expect(toasts).toHaveLength(0);
    expect(screen.getByTestId('location').textContent).toBe('/live');
  });

  it('keeps its identity while the channel fields stay the same', () => {
    const { result, rerender } = renderHook(() => useMultiviewMenuItem({ ...input(1) }), { wrapper });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
