import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { SearchX, Unplug } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { RpcError } from '@/api/transport';
import { sameRef, type ItemRef, type ItemSnapshot } from '@/api/types';
import { EmptyState, buttonClass } from '@/ui';

import { searchHref } from './TmdbRail';

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

/**
 * The title's name as the app saved it (My List, Continue watching, Recently watched), from what
 * those lists already hold in the cache: the provider no longer knows it.
 */
function savedTitle(qc: QueryClient, ref: ItemRef): string | undefined {
  for (const key of ['watchlist.list', 'positions.continueWatching', 'recent.list']) {
    for (const [, rows] of qc.getQueriesData<{ ref: ItemRef; snapshot?: ItemSnapshot }[]>({ queryKey: [key] })) {
      const title = Array.isArray(rows) ? rows.find((r) => sameRef(r.ref, ref))?.snapshot?.title?.trim() : undefined;
      if (title) return title;
    }
  }
  return undefined;
}

/**
 * The page body for a movie or series the provider no longer lists (`not_found`): catalogues churn,
 * so this is not an error with nothing to do but a way on, to the section's landing and, when the
 * app remembers the title's name, to a search for it (vod-detail-09).
 */
export function TitleGone({ itemRef }: { itemRef: ItemRef }) {
  const { t } = useTranslation('vod');
  const title = savedTitle(useQueryClient(), itemRef);
  const movie = itemRef.contentType === 'movie';
  return (
    <EmptyState
      icon={<SearchX size={28} />}
      title={t('titleGoneTitle')}
      description={t('titleGoneBody')}
      action={
        <>
          <Link to={`/s/${encodeURIComponent(itemRef.sourceId)}/${movie ? 'movies' : 'series'}`} className={buttonClass('primary', 'md')}>
            {t(movie ? 'browseMovies' : 'browseSeries')}
          </Link>
          {title && (
            <Link to={searchHref(title, itemRef.sourceId)} className={buttonClass('secondary', 'md')}>
              {t('searchForTitle')}
            </Link>
          )}
        </>
      }
    />
  );
}
