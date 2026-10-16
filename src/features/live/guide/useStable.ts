import { useCallback, useRef } from 'react';

/**
 * A function whose identity never changes and that calls the latest `fn`: event handlers handed
 * to memoised guide rows and the toolbar, so a page render does not re-render them.
 * Only for events, never for render.
 */
export function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}
