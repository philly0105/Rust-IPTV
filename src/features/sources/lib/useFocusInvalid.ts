import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Moves focus to the first field marked `aria-invalid` inside `root` once the
 * render that marks it has committed and `busy` (the submit that disabled the
 * fields) is over. A frame callback raced React: after an awaited RPC the
 * error state commits in a scheduler task, and when the frame came first the
 * field was still disabled and unmarked, so focus stayed on the Save button
 * the user clicked (L3-app-9). Each `request()` focuses at most once.
 */
export function useFocusInvalid(root: RefObject<HTMLElement | null>, busy: boolean): () => void {
  const pending = useRef(false);
  const [ticket, setTicket] = useState(0);
  useEffect(() => {
    if (!pending.current || busy) return;
    pending.current = false;
    root.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [ticket, busy, root]);
  return useCallback(() => {
    pending.current = true;
    setTicket((n) => n + 1);
  }, []);
}
