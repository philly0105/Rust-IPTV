import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { rpcKey, useRpcQuery } from '@/api/query';
import { rpcRaw, type RpcError } from '@/api/transport';
import type { Settings } from '@/api/types';

/** Shared `settings.get` query; kept fresh by the shell's settings.changed listener. */
export function useSettings(): UseQueryResult<Settings, RpcError> {
  return useRpcQuery('settings.get', undefined, { staleTime: Infinity });
}

/**
 * One value from the shared `settings.get` query (TanStack's `select`): the caller re-renders when
 * that value changes, not on every settings write, such as the `lastRoute` save after each screen
 * change (performance audit SH-1). Pass a function defined outside the component, so `select`
 * does not run again on each render.
 */
export function useSettingsValue<T>(select: (settings: Settings) => T): UseQueryResult<T, RpcError> {
  return useQuery<Settings, RpcError, T>({
    queryKey: rpcKey('settings.get'),
    // The signal aborts a refetch that a newer invalidation or an unmount replaced (as useRpcQuery).
    queryFn: async ({ signal }) => (await rpcRaw('settings.get', undefined, { signal })) as Settings,
    staleTime: Infinity,
    select,
  });
}
