import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { rpcKey } from '@/api/query';
import { rpcRaw, type RpcArgs, type RpcError, type RpcResult } from '@/api/transport';

/**
 * `stalker.epg` as a query that is not retried on the client: the server already waits 20 s
 * (40 s with `from`) before it reports a silent portal as a retryable timeout, so the default
 * two retries would hold the view in "loading" for up to two minutes. The caller shows the error
 * with its own retry. Same query key as `useRpcQuery`, so `epg.changed` invalidation still applies.
 */
export function usePortalEpg(
  args: RpcArgs<'stalker.epg'>,
  opts: { enabled: boolean; staleTime: number },
): UseQueryResult<RpcResult<'stalker.epg'>, RpcError> {
  return useQuery<RpcResult<'stalker.epg'>, RpcError>({
    queryKey: rpcKey('stalker.epg', args),
    queryFn: async ({ signal }) => (await rpcRaw('stalker.epg', args, { signal })) as RpcResult<'stalker.epg'>,
    enabled: opts.enabled,
    staleTime: opts.staleTime,
    retry: false,
  });
}
