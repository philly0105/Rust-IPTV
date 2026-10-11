import { useCallback, useEffect, useRef } from 'react';

/**
 * `requestAnimationFrame` tied to the component's lifetime: a newer call
 * replaces the pending one, and unmount cancels it, so a focus callback never
 * runs against a torn-down DOM (or after a test's jsdom is gone).
 */
export function useNextFrame(): (fn: () => void) => void {
  const id = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (id.current !== null) cancelAnimationFrame(id.current);
      id.current = null;
    },
    [],
  );
  return useCallback((fn: () => void) => {
    if (id.current !== null) cancelAnimationFrame(id.current);
    id.current = requestAnimationFrame(() => {
      id.current = null;
      fn();
    });
  }, []);
}
