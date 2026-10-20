import { useTranslation } from 'react-i18next';

import { useRpcQuery } from '@/api/query';
import { DEFAULT_SETTINGS } from '@/api/types';

import { formatUnit } from './format';

/**
 * The auto-refresh switch's hint in the source dialogs (SS-4): the schedule the app really keeps,
 * every `sourceRefreshIntervalHours` in the background (12 by default), or each launch when the
 * interval is 0, and where to change it. Not a link: leaving the dialog would lose what was typed.
 */
export function useAutoRefreshHint(): string {
  const { t, i18n } = useTranslation('sources');
  const settings = useRpcQuery('settings.get', undefined, { staleTime: Infinity });
  const hours = settings.data?.sourceRefreshIntervalHours ?? DEFAULT_SETTINGS.sourceRefreshIntervalHours;
  return hours > 0 ? t('autoRefreshHintEvery', { interval: formatUnit(hours, 'hour', i18n.language) }) : t('autoRefreshHintStartup');
}
