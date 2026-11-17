// @vitest-environment jsdom
/**
 * The kit's feedback states (states-feedback audit): busy icon buttons keep focus, Undo toasts
 * stay long enough to reach and say how to reach them.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { IconButton, ToastViewport, toast, useBusyButtons, useToastStore } from '..';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useToastStore.setState({ toasts: [] });
});

describe('IconButton loading (states-feedback-01)', () => {
  it('spins, ignores presses and keeps focus instead of going native-disabled', () => {
    const onClick = vi.fn();
    const { rerender } = render(<IconButton label="Favorite" icon={<span data-testid="glyph" />} onClick={onClick} />);
    const btn = screen.getByRole('button', { name: 'Favorite' });
    btn.focus();
    rerender(<IconButton label="Favorite" icon={<span data-testid="glyph" />} onClick={onClick} loading />);
    expect(btn).toHaveProperty('disabled', false);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByTestId('glyph')).toBeNull();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(btn);
  });
});

function Row({ onRemove }: { onRemove: () => void }) {
  const [busy, setBusy] = useState(false);
  const busyButton = useBusyButtons(busy);
  return (
    <>
      <IconButton label="Watched" icon={<span />} {...busyButton('watched', () => setBusy(true))} />
      <IconButton label="Remove" icon={<span />} {...busyButton('remove', onRemove)} />
    </>
  );
}

describe('useBusyButtons', () => {
  it('spins the pressed button only, keeps its focus, and ignores the others while busy', () => {
    const onRemove = vi.fn();
    render(<Row onRemove={onRemove} />);
    const watched = screen.getByRole('button', { name: 'Watched' });
    const remove = screen.getByRole('button', { name: 'Remove' });
    watched.focus();
    fireEvent.click(watched);
    expect(watched.getAttribute('aria-busy')).toBe('true');
    expect(remove.getAttribute('aria-busy')).toBeNull();
    expect(remove.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(watched);
    fireEvent.click(remove);
    expect(onRemove).not.toHaveBeenCalled();
  });
});

describe('toasts with an action (states-feedback-03)', () => {
  it('stay 10 s instead of 5, and the live region says how to reach the action', () => {
    vi.useFakeTimers();
    render(<ToastViewport />);
    act(() => void toast({ title: 'Removed Heat from My List', action: { label: 'Undo', onClick: () => undefined } }));
    expect(document.querySelector('[data-toast-live="polite"]')?.textContent).toBe('Removed Heat from My List. Press F8 to reach Undo.');
    act(() => void toast({ title: 'Saved' }));
    act(() => vi.advanceTimersByTime(6000));
    expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual(['Removed Heat from My List']);
    act(() => vi.advanceTimersByTime(4500));
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
