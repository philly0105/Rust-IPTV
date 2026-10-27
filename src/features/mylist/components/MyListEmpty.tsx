/**
 * The empty My List: three unset preset slots, numbered like the ranks the
 * list gives saved titles, above the one thing to do next. The slots are
 * static outlines (no shimmer), so the page never reads as still loading.
 */

import { BookmarkPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { Source } from '@/api/types';
import { NoSourcesState } from '@/features/sources/components/NoSourcesState';
import { intlLocale, numberFormat } from '@/lib/intl';

import { buttonClass, cn } from '../deps';

export interface MyListEmptyProps {
  /** Visible sources; `undefined` while they load (no action is offered yet). */
  sources: readonly Source[] | undefined;
  /** The type filter in effect, so the action leads to the right shelf. */
  kind?: 'movie' | 'series';
}

/** Where to look for something to save: the first source with titles of that kind. */
export function browseTarget(sources: readonly Source[], kind: 'movie' | 'series'): string | undefined {
  const count = (s: Source) => (kind === 'movie' ? s.movieCount : s.seriesCount);
  const source = sources.find((s) => count(s) > 0);
  return source ? `/s/${encodeURIComponent(source.id)}/${kind === 'movie' ? 'movies' : 'series'}` : undefined;
}

export function MyListEmpty({ sources, kind }: MyListEmptyProps) {
  const { t, i18n } = useTranslation('mylist');
  const nf = numberFormat(intlLocale(i18n.language));
  const movies = sources ? browseTarget(sources, 'movie') : undefined;
  const series = sources ? browseTarget(sources, 'series') : undefined;
  const noVod = sources !== undefined && !movies && !series;

  // With no source the page says what every page says then; the numbered slots would only push it
  // down the window.
  if (sources && sources.length === 0) {
    return <NoSourcesState icon={<BookmarkPlus />} title={t('emptyTitle')} description={t('emptyNoSources')} testId="mylist-empty-add-source" stateTestId="mylist-empty" />;
  }

  let actions = null;
  if (sources && !noVod) {
    // The filter in effect decides the shelf; with none, movies first and series beside them.
    const primaryKind = kind ?? (movies ? 'movie' : 'series');
    const primary = primaryKind === 'movie' ? movies : series;
    const secondary = !kind && primaryKind === 'movie' ? series : undefined;
    const label = (k: 'movie' | 'series') => (k === 'movie' ? t('browseMovies') : t('browseSeries'));
    actions = (
      <>
        {primary && (
          <Link to={primary} className={buttonClass('primary', 'md')} data-testid="mylist-empty-browse">
            {label(primaryKind)}
          </Link>
        )}
        {secondary && (
          <Link to={secondary} className={buttonClass('secondary', 'md')} data-testid="mylist-empty-browse-series">
            {label('series')}
          </Link>
        )}
      </>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-2 py-10" data-testid="mylist-empty">
      <div aria-hidden className="mb-8 flex w-full max-w-sm flex-col gap-3">
        {[1, 2, 3].map((n, i) => (
          <div key={n} className={cn('flex items-center gap-4', i === 1 && 'opacity-70', i === 2 && 'opacity-40')}>
            <span className="w-8 text-end font-numeric text-3xl leading-none font-semibold tabular text-fg-subtle/60">{nf.format(n)}</span>
            <span
              className={cn(
                'flex h-[60px] w-10 shrink-0 items-center justify-center rounded-md border border-dashed',
                i === 0 ? 'border-accent/70 text-accent' : 'border-divider text-transparent',
              )}
            >
              <BookmarkPlus size={16} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-2">
              <span className="h-2.5 w-3/4 rounded-full bg-surface-3" />
              <span className="h-2 w-1/3 rounded-full bg-surface-2" />
            </span>
          </div>
        ))}
      </div>
      <h2 className="text-center text-title text-fg">{t('emptyTitle')}</h2>
      <p className="mt-2 max-w-md text-center text-sm text-fg-muted">
        {noVod ? t('emptyNoVod') : t('emptyBody')}
      </p>
      {actions && <div className="mt-6 flex flex-wrap items-center justify-center gap-3">{actions}</div>}
    </div>
  );
}
