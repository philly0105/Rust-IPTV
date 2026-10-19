import { useMemo } from 'react';

import { useRpcQuery } from '@/api/query';
import type { Settings } from '@/api/types';

/** Rendering preferences the live views apply to channel names and programme times. */
export interface DisplayPrefs {
  stripCountryPrefix: boolean;
  epgOffsetMinutes: number;
}

/** `stripCountryPrefix` / `epgOffsetMinutes` are B2-fix1's `Settings` fields; read them defensively until they land. */
export function displayPrefsOf(settings: Settings | undefined): DisplayPrefs {
  const s = settings as (Settings & Partial<DisplayPrefs>) | undefined;
  const offset = Number(s?.epgOffsetMinutes ?? 0);
  return {
    stripCountryPrefix: s?.stripCountryPrefix === true,
    epgOffsetMinutes: Number.isFinite(offset) ? Math.trunc(offset) : 0,
  };
}

export function useDisplayPrefs(): DisplayPrefs {
  const settings = useRpcQuery('settings.get', undefined);
  const { stripCountryPrefix, epgOffsetMinutes } = displayPrefsOf(settings.data);
  return useMemo(() => ({ stripCountryPrefix, epgOffsetMinutes }), [stripCountryPrefix, epgOffsetMinutes]);
}
