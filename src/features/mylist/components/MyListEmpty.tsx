/**
 * The empty My List: the kit's empty state, as Favorites and Recently watched draw theirs, with the
 * way to save a title and where channels go instead (Favorites or a channel list), since the three
 * collections sit side by side in the rail.
 */

import { BookmarkPlus } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { Source } from '@/api/types';
import { NoSourcesState, useNoSourcesAdding } from '@/features/sources/components/NoSourcesState';

import { EmptyState, TEXT_LINK, buttonClass } from '../deps';

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
  const { t } = useTranslation('mylist');
  const adding = useNoSourcesAdding();
  const movies = sources ? browseTarget(sources, 'movie') : undefined;
  const series = sources ? browseTarget(sources, 'series') : undefined;
  const noVod = sources !== undefined && !movies && !series;

  // With no source the page says what every page says then. It stays while its add dialog is open, which the new source's listing would
  // otherwise close mid-import.
  if (sources && (sources.length === 0 || adding)) {
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
    <div className="flex flex-col" data-testid="mylist-empty">
      <EmptyState
        icon={<BookmarkPlus />}
        title={t('emptyTitle')}
        description={
          <>
            {noVod ? t('emptyNoVod') : t('emptyBody')}{' '}
            <Trans
              t={t}
              i18nKey="channelsElsewhere"
              components={{ fav: <Link to="/favorites" className={TEXT_LINK} />, lists: <Link to="/lists" className={TEXT_LINK} /> }}
            />
          </>
        }
        action={actions && <div className="flex flex-wrap items-center justify-center gap-3">{actions}</div>}
      />
    </div>
  );
}
