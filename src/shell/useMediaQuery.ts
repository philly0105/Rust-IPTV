import { useCallback, useSyncExternalStore } from 'react';

/** Reactive `matchMedia`; false where matchMedia is missing (tests). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
      const m = window.matchMedia(query);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    [query],
  );
  const get = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false;
  return useSyncExternalStore(subscribe, get, () => false);
}
