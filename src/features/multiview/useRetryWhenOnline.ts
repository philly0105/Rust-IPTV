/**
 * A tile that failed for a network reason tries again by itself when the browser comes back
 * online, so a dropped Wi-Fi does not leave the wall full of error panels.
 */

import { useEffect, useRef } from 'react';

export function useRetryWhenOnline(active: boolean, retry: () => void): void {
  const retryRef = useRef(retry);
  retryRef.current = retry;
  useEffect(() => {
    if (!active) return;
    const onOnline = (): void => retryRef.current();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [active]);
}
