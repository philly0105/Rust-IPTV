// @vitest-environment jsdom
/**
 * The kit's feedback states (states-feedback audit): busy icon buttons keep focus.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { IconButton, useBusyButtons } from '..';

afterEach(cleanup);

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
