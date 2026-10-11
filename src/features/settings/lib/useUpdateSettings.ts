import { useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { rpcKey, useRpcQuery } from '@/api/query';
import { RpcError, rpc } from '@/api/transport';
import type { Settings } from '@/api/types';

import { useToast } from '../../sources/_shim';
import { applyPatch, revertPatch, type SettingsPatch } from './patch';

const KEY = rpcKey('settings.get');

/** Shared `settings.get` query (same key and staleness as the shell's). */
export function useSettingsQuery(): UseQueryResult<Settings, RpcError> {
  return useRpcQuery('settings.get', undefined, { staleTime: Infinity });
}

/**
 * Optimistic `settings.update`: the cache changes at once, the server answer
 * replaces it, and a failure restores only the touched keys and shows a toast
 * with a retry. Resolves true on success.
 */
export function useUpdateSettings(): (patch: SettingsPatch) => Promise<boolean> {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = useTranslation('settings');

  const update = useCallback(
    async (patch: SettingsPatch): Promise<boolean> => {
      const before = qc.getQueryData<Settings>(KEY);
      if (before) qc.setQueryData<Settings>(KEY, applyPatch(before, patch));
      try {
        const next = await rpc('settings.update', { patch });
        qc.setQueryData<Settings>(KEY, next);
        return true;
      } catch (e) {
        const err = RpcError.from(e);
        const current = qc.getQueryData<Settings>(KEY);
        if (before && current) qc.setQueryData<Settings>(KEY, revertPatch(current, before, patch));
        toast({
          variant: 'error',
          title: t('saveFailed'),
          description: err.message,
          action: { label: t('retry'), onClick: () => void update(patch) },
        });
        return false;
      }
    },
    [qc, toast, t],
  );
  return update;
}
