import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { formatRuntime, type RuntimeKey } from '../lib/format';

/** `formatRuntime` bound to the active language: `Intl.DurationFormat` first, `vod` runtime keys as the fallback. */
export function useFormatRuntime(): (totalSeconds: number | undefined) => string | undefined {
  const { t, i18n } = useTranslation('vod');
  const locale = i18n.language;
  return useCallback(
    (totalSeconds: number | undefined) =>
      formatRuntime(totalSeconds, { locale, t: (key: RuntimeKey, vars) => t(key, vars) }),
    [locale, t],
  );
}
