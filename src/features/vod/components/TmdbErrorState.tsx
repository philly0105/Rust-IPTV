import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { RpcError } from '@/api/transport';
import { ErrorState, buttonClass } from '@/ui';

/**
 * Error state for TMDB-backed sections. A rejected key (`auth`) gets a
 * key-specific title and hint plus a way to Metadata settings, instead of
 * the generic hint about the source's username, password or MAC address.
 */
export function TmdbErrorState({
  error,
  onRetry,
  title,
  size = 'page',
}: {
  error: unknown;
  onRetry: () => void;
  /** Title for errors other than a rejected key (default: derived from the error code). */
  title?: ReactNode;
  size?: 'page' | 'inline';
}) {
  const { t } = useTranslation('vod');
  if (RpcError.from(error).code !== 'auth') {
    return title === undefined ? (
      <ErrorState size={size} error={error} onRetry={onRetry} />
    ) : (
      <ErrorState size={size} error={error} onRetry={onRetry} title={title} />
    );
  }
  return (
    <ErrorState
      size={size}
      error={error}
      onRetry={onRetry}
      title={t('tmdbKeyRejectedTitle')}
      hint={t('tmdbKeyRejectedHint')}
      action={
        <Link to="/settings/metadata" data-testid="vod-tmdb-key-settings" className={buttonClass('secondary', size === 'inline' ? 'sm' : 'md')}>
          {t('openMetadataSettings')}
        </Link>
      }
    />
  );
}
