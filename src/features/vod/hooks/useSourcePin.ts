import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { queryClient, rpcKey } from '@/api/query';
import { RpcError, rpc } from '@/api/transport';
import type { ItemRef, SourcePin, VodItem } from '@/api/types';
import { useToast } from '@/ui';

import { matchKey, migrateLocalPins } from '../lib/pins';

/** Preferred-source pin for a title (`sourcePins.*`), plus the copy it points at when that copy is among `others`. */
export function useSourcePin(item: Pick<VodItem, 'title' | 'titleBase' | 'year'> | undefined, others: VodItem[]) {
  const { t } = useTranslation('vod');
  const { toast } = useToast();
  const key = item ? matchKey(item) : undefined;
  const query = useQuery<SourcePin | null, RpcError>({
    queryKey: rpcKey('sourcePins.get', { matchKey: key ?? '' }),
    // Pins an older build kept in localStorage reach the core before the first read.
    queryFn: async () => {
      await migrateLocalPins();
      return rpc('sourcePins.get', { matchKey: key ?? '' });
    },
    enabled: !!key,
  });
  const pin = query.data ?? undefined;

  const update = useCallback(
    async (ref: ItemRef | null) => {
      if (!key) return;
      const queryKey = rpcKey('sourcePins.get', { matchKey: key });
      try {
        if (ref) queryClient.setQueryData(queryKey, await rpc('sourcePins.set', { matchKey: key, ref }));
        else {
          await rpc('sourcePins.clear', { matchKey: key });
          queryClient.setQueryData(queryKey, null);
        }
      } catch (err) {
        toast({ title: t('pinFailed'), description: RpcError.from(err).message, variant: 'error' });
      }
    },
    [key, t, toast],
  );

  const pinnedOther = pin ? others.find((o) => o.ref.sourceId === pin.sourceId && o.ref.itemId === pin.itemId) : undefined;
  return { pin, setPin: update, pinnedOther };
}
