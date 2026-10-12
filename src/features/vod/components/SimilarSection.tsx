import { Clapperboard, KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { TmdbBrief } from '@/api/types';

import { EmptyState, buttonClass } from '@/ui';
import { TmdbAttribution } from './TmdbAttribution';
import { TmdbErrorState } from './TmdbErrorState';
import { TmdbRail } from './TmdbRail';

/**
 * "More like this" on the detail pages. With no TMDB key it shows how to add
 * one instead of claiming TMDB found nothing; the TMDB notice shows only when
 * something on the page came from TMDB.
 */
export function SimilarSection({
  items,
  loading,
  sourceId,
  error,
  onRetry,
  keyMissing,
  enriched,
}: {
  items: TmdbBrief[];
  loading: boolean;
  sourceId: string;
  error: unknown;
  onRetry: () => void;
  keyMissing: boolean;
  /** True when any TMDB data took part in the page. */
  enriched: boolean;
}) {
  const { t } = useTranslation('vod');
  if (keyMissing) {
    return (
      <section aria-label={t('similar')} data-testid="vod-tmdb-key-missing" className="relative">
        <EmptyState
          size="inline"
          icon={<KeyRound size={20} />}
          title={t('tmdbKeyMissingTitle')}
          description={t('tmdbKeyMissingHint')}
          action={
            <Link to="/settings/metadata" className={buttonClass('secondary', 'sm')}>
              {t('addTmdbKey')}
            </Link>
          }
        />
      </section>
    );
  }
  return (
    <div className="relative flex flex-col gap-4">
      <TmdbRail
        title={t('similar')}
        items={items}
        loading={loading}
        sourceId={sourceId}
        empty={
          error ? (
            <TmdbErrorState size="inline" title={t('tmdbUnavailable')} error={error} onRetry={onRetry} />
          ) : (
            <EmptyState size="inline" icon={<Clapperboard size={20} />} title={t('noSimilar')} />
          )
        }
      />
      {(enriched || items.length > 0) && <TmdbAttribution />}
    </div>
  );
}
