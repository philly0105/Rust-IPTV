import { useTranslation } from 'react-i18next';

import { TEXT_LINK, cn } from '@/ui';

/**
 * One line above a list or grid whose Stalker guide timed out; the queue retries on its own. Its
 * own module, not ChannelList's: the guide draws it too, and importing it from there made the
 * guide load the channel list and its rows before its first render.
 */
export function GuideUnavailableNotice({ onRetry }: { onRetry(): void }) {
  const { t } = useTranslation('live');
  return (
    <div role="status" data-testid="guide-unavailable" className="flex items-center gap-2 border-b border-divider bg-surface-2 px-3 py-1.5 text-xs text-fg-muted">
      <span className="min-w-0 flex-1">{t('portalGuideUnavailable')}</span>
      <button
        type="button"
        onClick={onRetry}
        className={cn(TEXT_LINK, 'shrink-0')}
      >
        {t('retry')}
      </button>
    </div>
  );
}
