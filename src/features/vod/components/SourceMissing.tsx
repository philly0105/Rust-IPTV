import { Unplug } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { RpcError } from '@/api/transport';
import { EmptyState, buttonClass } from '@/ui';

/**
 * True when `sources.get` failed because the source no longer exists (the user removed it, or
 * the link points at a source that was never there). Retrying or refreshing cannot help then.
 */
export function isSourceMissing(error: unknown): boolean {
  return error != null && RpcError.from(error).code === 'not_found';
}

/** The page body for a VOD route whose source is gone: no Retry, a way back to working sources. */
export function SourceMissing() {
  const { t } = useTranslation('vod');
  return (
    <EmptyState
      icon={<Unplug size={28} />}
      title={t('sourceMissingTitle')}
      description={t('sourceMissingBody')}
      action={
        <>
          <Link to="/sources" className={buttonClass('primary', 'md')}>
            {t('openSources')}
          </Link>
          <Link to="/dashboard" className={buttonClass('secondary', 'md')}>
            {t('goToDashboard')}
          </Link>
        </>
      }
    />
  );
}
