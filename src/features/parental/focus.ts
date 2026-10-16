import { useEffect, type RefObject } from 'react';

/**
 * Keeps typing going into the PIN field. The dialog's focus trap moves focus
 * to the dialog panel itself when something outside takes it (a radio group
 * that refocuses its checked option a frame after the change that opened the
 * dialog, a click on the page behind); in a PIN dialog the field is the only
 * place digits can go, so focus that lands on the panel moves on to it.
 */
export function useFocusPinOnPanel(inputRef: RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const input = inputRef.current;
      const el = e.target;
      if (!input || !(el instanceof HTMLElement) || el.getAttribute('role') !== 'dialog' || !el.contains(input)) return;
      input.focus({ preventScroll: true });
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, [inputRef]);
}
