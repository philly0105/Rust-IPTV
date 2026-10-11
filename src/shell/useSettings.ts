import type { UseQueryResult } from '@tanstack/react-query';

import { useRpcQuery } from '@/api/query';
import type { RpcError } from '@/api/transport';
import type { Settings } from '@/api/types';

/** Shared `settings.get` query; kept fresh by the shell's settings.changed listener. */
export function useSettings(): UseQueryResult<Settings, RpcError> {
  return useRpcQuery('settings.get', undefined, { staleTime: Infinity });
}
