import { EyeOff } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { HiddenChannelsDialog, useHiddenChannelCount } from '@/features/channeledit';
import { intlLocale } from '@/lib/intl';
import { countClass, linkClass } from './CategorySidebar';

/**
 * "Hidden channels  n" with the pinned views above All channels (C2, walkthrough-09): opens the
 * source's hidden channels and stations. Shown only while the source has any. It sat under the
 * last group, out of sight past hundreds of groups, where "Find it under Hidden channels" sent you.
 * `height` is the group column's row slot, so it lines up with Favorites and Recently watched.
 */
export function HiddenChannelsButton({ sourceId, height }: { sourceId: string; height: number }) {
  const { t, i18n } = useTranslation('channels');
  const fmt = useMemo(() => new Intl.NumberFormat(intlLocale(i18n.language)), [i18n.language]);
  const count = useHiddenChannelCount(sourceId);
  const [open, setOpen] = useState(false);
  return (
    <>
      {count ? (
        <div className="px-2" style={{ height }}>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            data-testid="hidden-channels-button"
            className={`${linkClass(false)} w-full`}
          >
            <EyeOff size={14} className="shrink-0 text-fg-subtle" aria-hidden />
            <span className="flex-1 truncate text-start">{t('hiddenTitle')}</span>
            <span className={countClass(false)}>{fmt.format(count)}</span>
          </button>
        </div>
      ) : null}
      <HiddenChannelsDialog sourceId={sourceId} open={open} onOpenChange={setOpen} />
    </>
  );
}
