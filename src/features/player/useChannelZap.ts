import { useMemo } from 'react';

import { zap, zapToNumber } from './store';

/** Channel up/down and number entry for the current live source (C8). */
export function useChannelZap(): { up(): void; down(): void; selectNumber(n: number): void } {
  return useMemo(
    () => ({
      up: () => void zap('up').catch(() => undefined),
      down: () => void zap('down').catch(() => undefined),
      selectNumber: (n: number) => void zapToNumber(n).catch(() => undefined),
    }),
    [],
  );
}
