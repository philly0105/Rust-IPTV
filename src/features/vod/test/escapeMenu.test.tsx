/**
 * XB2-15 (L2-player-15): Escape that closes the player's options menu must not also close the
 * inline player on a detail page.
 */
import { cleanup, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const menu = vi.hoisted(() => ({ justClosed: false }));

vi.mock('@/features/player', () => ({ usePlayerStore: () => undefined }));
vi.mock('@/features/player/components/Controls', () => ({
  playerMenuJustClosed: () => menu.justClosed,
}));

const { useEscapeToClose } = await import('../hooks/useWatchState');

afterEach(() => {
  cleanup();
  menu.justClosed = false;
  document.body.replaceChildren();
});

describe('useEscapeToClose and the player options menu', () => {
  it('closes the player on a page-level Escape', () => {
    const onClose = vi.fn();
    renderHook(() => useEscapeToClose(true, onClose));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores an Escape from inside the options menu', () => {
    const onClose = vi.fn();
    renderHook(() => useEscapeToClose(true, onClose));
    const host = document.createElement('div');
    host.setAttribute('data-testid', 'player-options-menu');
    const item = document.createElement('button');
    host.append(item);
    document.body.append(host);
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores the Escape right after one closed the menu', () => {
    const onClose = vi.fn();
    renderHook(() => useEscapeToClose(true, onClose));
    menu.justClosed = true;
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    menu.justClosed = false;
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
