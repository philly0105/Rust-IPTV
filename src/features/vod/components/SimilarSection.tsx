import { Clapperboard, KeyRound } from 'lucide-react';
import { useEffect, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { itemKey, type SeriesItem, type SourceKind, type TmdbBrief, type VodItem } from '@/api/types';

import { useCatalogMatches } from '../hooks/useCatalogMatches';
import { useNearViewport } from '../hooks/useNearViewport';
import { useWatchedKeys } from '../hooks/useWatched';
import { detailHref } from '../lib/search';
import { EmptyState, buttonClass, whenIdle } from '@/ui';
import { myListTarget, PosterCard } from './PosterCard';
import { PosterRail } from './PosterRail';
import { TmdbAttribution } from './TmdbAttribution';
import { TmdbErrorState } from './TmdbErrorState';

/** No scroller of its own: the window's viewport. */
const VIEWPORT: RefObject<Element | null> = { current: null };

/**
 * "More like this" on the detail pages. TMDB names the titles; only the ones this source has are
 * shown, each opening its own detail page (VL-tmdb-deadend), so no card leads to an empty search.
 * With no TMDB key it shows how to add one instead of claiming TMDB found nothing; the TMDB notice
 * shows only when something on the page came from TMDB.
 */
export function SimilarSection({
  items,
  loading,
  sourceId,
  kind = 'movie',
  sourceKind,
  error,
  onRetry,
  keyMissing,
  enriched,
  rootRef,
}: {
  items: TmdbBrief[];
  loading: boolean;
  sourceId: string;
  /** Which part of the catalog the similar titles are looked up in. */
  kind?: 'movie' | 'series';
  /** The source's kind, so resting on a card warms its detail page. */
  sourceKind?: SourceKind | undefined;
  error: unknown;
  onRetry: () => void;
  keyMissing: boolean;
  /** True when any TMDB data took part in the page. */
  enriched: boolean;
  /** The page's scroller: the catalog lookups wait until the section nears its view (default: the window). */
  rootRef?: RefObject<Element | null>;
}) {
  const { t } = useTranslation('vod');
  // The section sits below the fold: its lookups (one per TMDB title) wait until it nears the
  // screen and the page is idle, as Home's trending rail does, and a Stalker portal, whose VOD is
  // not in the local catalog, asks for none (nothing could match).
  const [nearRef, near] = useNearViewport<HTMLDivElement>(rootRef ?? VIEWPORT);
  const [idle, setIdle] = useState(false);
  useEffect(() => (near && !idle ? whenIdle(() => setIdle(true)) : undefined), [near, idle]);
  const lookups = !keyMissing && !error && sourceKind !== 'stalker';
  const matches = useCatalogMatches(items, sourceId, kind, lookups && idle);
  const watched = useWatchedKeys(matches.items);
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
    <div ref={nearRef} className="relative flex flex-col gap-4">
      <PosterRail<VodItem | SeriesItem>
        title={t('similar')}
        items={matches.items}
        loading={loading || (items.length > 0 && lookups && (!idle || matches.pending))}
        bleed
        myList={myListTarget}
        empty={
          error ? (
            <TmdbErrorState size="inline" title={t('tmdbUnavailable')} error={error} onRetry={onRetry} />
          ) : (
            // TMDB found none, or none of its titles is in this source: say which.
            <EmptyState size="inline" icon={<Clapperboard size={20} />} title={items.length > 0 ? t('noSimilarInSource') : t('noSimilar')} />
          )
        }
        render={(item, i, rail) => (
          <PosterCard
            index={i}
            tabIndex={rail.tabIndex}
            title={item.titleBase || item.title}
            fullTitle={item.title}
            href={detailHref(item.ref) ?? '#'}
            posterUrl={item.posterUrl}
            year={item.year}
            rating={item.rating}
            watched={watched.has(itemKey(item.ref))}
            myList={myListTarget(item)}
            prefetch={sourceKind ? { ref: item.ref, sourceKind, posterUrl: item.posterUrl, backdropUrl: item.backdropUrl } : undefined}
          />
        )}
      />
      {(enriched || items.length > 0) && <TmdbAttribution />}
    </div>
  );
}
