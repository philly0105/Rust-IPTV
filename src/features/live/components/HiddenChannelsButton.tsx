import { EyeOff } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { HiddenChannelsDialog, useHiddenChannelCount } from '@/features/channeledit';
import { intlLocale } from '@/lib/intl';

/**
 * "Hidden channels (n)" under the group list (C2): opens the source's hidden
 * channels and stations. Shown only while the source has any.
 */
export function HiddenChannelsButton({ sourceId }: { sourceId: string }) {
  const { t, i18n } = useTranslation('channels');
  const fmt = useMemo(() => new Intl.NumberFormat(intlLocale(i18n.language)), [i18n.language]);
  const count = useHiddenChannelCount(sourceId);
  const [open, setOpen] = useState(false);
  return (
    <>
      {count ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          data-testid="hidden-channels-button"
          className="mx-3 mb-3 flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-xs text-fg-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
        >
          <EyeOff className="size-3.5" aria-hidden />
          <span className="flex-1 truncate text-start">{t('hiddenTitle')}</span>
          <span className="tabular-nums">{fmt.format(count)}</span>
        </button>
      ) : null}
      <HiddenChannelsDialog sourceId={sourceId} open={open} onOpenChange={setOpen} />
    </>
  );
}
