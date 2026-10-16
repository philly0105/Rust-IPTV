/**
 * XB2-28: after a toast's Undo (or close) is pressed, focus goes back to where it was before the
 * toast took it, or to #main when that element is gone, never to <body>.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import '@/i18n';

import { ToastViewport, focusToasts, toast, useToastStore } from '..';

/** A mouse press as a browser handles it: focus moves to the pressed button. */
function pressAndClick(el: HTMLElement): void {
  fireEvent.mouseDown(el);
  el.focus();
  fireEvent.mouseUp(el);
  fireEvent.click(el);
}

function Page({ withRow = true, disabled = false }: { withRow?: boolean; disabled?: boolean }) {
  return (
    <>
      <main id="main" tabIndex={-1}>
        {withRow && (
          <button type="button" disabled={disabled}>
            Remove
          </button>
        )}
        <button type="button">Other</button>
      </main>
      <ToastViewport />
    </>
  );
}

afterEach(() => {
  cleanup();
  useToastStore.setState({ toasts: [] });
});

describe('toast focus return (XB2-28)', () => {
  it('Undo pressed with the mouse puts focus back on the control that had it', () => {
    render(<Page />);
    const row = screen.getByRole('button', { name: 'Remove' });
    row.focus();
    act(() => {
      toast({ title: 'Removed', action: { label: 'Undo', onClick: () => {} } });
    });
    pressAndClick(screen.getByRole('button', { name: 'Undo' }));
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(document.activeElement).toBe(row);
  });

  it('lands on #main when that control is gone', () => {
    const { rerender } = render(<Page />);
    screen.getByRole('button', { name: 'Remove' }).focus();
    act(() => {
      toast({ title: 'Removed', action: { label: 'Undo', onClick: () => {} } });
    });
    const undo = screen.getByRole('button', { name: 'Undo' });
    fireEvent.mouseDown(undo);
    undo.focus();
    // The row re-renders as a new node while the toast holds focus.
    rerender(<Page withRow={false} />);
    fireEvent.click(undo);
    expect(document.activeElement?.id).toBe('main');
  });

  it('lands on #main when that control can no longer take focus', () => {
    const { rerender } = render(<Page />);
    screen.getByRole('button', { name: 'Remove' }).focus();
    act(() => {
      toast({ title: 'Removed', action: { label: 'Undo', onClick: () => {} } });
    });
    const undo = screen.getByRole('button', { name: 'Undo' });
    undo.focus();
    rerender(<Page disabled />);
    fireEvent.click(undo);
    expect(document.activeElement?.id).toBe('main');
  });

  it('forgets an earlier origin when focus later enters from <body>', () => {
    render(<Page />);
    const other = screen.getByRole('button', { name: 'Other' });
    other.focus();
    act(() => {
      toast({ id: 'a', title: 'First' });
      toast({ id: 'b', title: 'Second', action: { label: 'Undo', onClick: () => {} } });
    });
    expect(focusToasts()).toBe(true);
    // Focus leaves the stack without closing a toast, then comes back from nowhere.
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    const undo = screen.getByRole('button', { name: 'Undo' });
    undo.focus();
    fireEvent.click(undo);
    // The neighbouring toast takes focus first; closing it leaves the stack for #main, not "Other".
    const dismiss = document.activeElement as HTMLElement;
    expect(dismiss.closest('[data-toast-id="a"]')).toBeTruthy();
    fireEvent.click(dismiss);
    expect(document.activeElement?.id).toBe('main');
  });
});
