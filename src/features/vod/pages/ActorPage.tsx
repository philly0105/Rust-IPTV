import { UserRound } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { useRpcQuery } from '@/api/query';
import { itemKey, type SeriesItem, type TmdbBrief, type VodItem } from '@/api/types';
import { useHeaderTitleAnchor } from '@/shell/store';
import { useMediaQuery } from '@/shell/useMediaQuery';

import { myListTarget, PosterCard } from '../components/PosterCard';
import { PosterRail } from '../components/PosterRail';
import { TmdbErrorState } from '../components/TmdbErrorState';
import { TmdbAttribution } from '../components/TmdbAttribution';
import { useSettings, useSource } from '../hooks/queries';
import { useGoBack } from '../hooks/useBackKey';
import { useCatalogMatches } from '../hooks/useCatalogMatches';
import { usePageHeader } from '../hooks/usePageHeader';
import { useWatchedKeys } from '../hooks/useWatched';
import { detailHref } from '../lib/search';
import { EmptyState, Page, Poster, PosterCellWidthContext, Skeleton, TEXT_LINK, buttonClass, cn, usePosterWidthBox, useScaledPx } from '@/ui';
import { intlLocale } from '@/lib/intl';

const BIO_CLAMP = 600;

function formatDate(iso: string | undefined, locale?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(intlLocale(locale), { year: 'numeric', month: 'long', day: 'numeric' });
}

const NO_BRIEFS: TmdbBrief[] = [];

/** The portrait's box, `w-40 sm:w-52`: spacing steps of 3.75 px at 100 % scale. */
const PORTRAIT_PX = 150;
const PORTRAIT_SM_PX = 195;
/** Tailwind's `sm` breakpoint. */
const SM_QUERY = '(min-width: 40rem)';

/**
 * TMDB person: portrait, facts, biography, and a "Known for" rail of the person's titles that this
 * source has, each opening its own detail page (VL-tmdb-deadend).
 */
export function ActorPage() {
  const { t, i18n } = useTranslation('vod');
  const { sourceId = '', personId = '' } = useParams();
  const settings = useSettings();
  const id = Number(personId);
  const valid = Number.isInteger(id) && id > 0;
  const person = useRpcQuery('tmdb.person', { personId: id }, { enabled: settings.tmdb.enabled && valid, staleTime: Infinity });
  const [expanded, setExpanded] = useState(false);
  // P2-POSTERS-4: the portrait's width is known (w-40, sm:w-52), so it does not read its frame as it mounts.
  const portraitWidth = usePosterWidthBox(useScaledPx(useMediaQuery(SM_QUERY) ? PORTRAIT_SM_PX : PORTRAIT_PX, true));

  // Mirrors the branch below that renders the visible h1 (the person's name).
  const loaded = settings.tmdb.enabled && valid && !person.isError && !!person.data;
  // The person's name once known; before that "Cast", the row the page was opened from.
  const pageTitle = loaded && person.data ? person.data.name : t('cast');
  // Back to the title the person was opened from, or the movies landing when opened cold. The
  // header names the cast until the name's own h1 scrolls away, so the name is not shown twice.
  const goBack = useGoBack(`/s/${encodeURIComponent(sourceId)}/movies`);
  usePageHeader({ title: pageTitle, section: t('cast'), back: { onClick: goBack } }, [pageTitle, t]);
  const nameRef = useHeaderTitleAnchor();
  const knownFor = person.data?.knownFor ?? NO_BRIEFS;
  const movieBriefs = useMemo(() => knownFor.filter((b) => b.mediaType === 'movie'), [knownFor]);
  const tvBriefs = useMemo(() => knownFor.filter((b) => b.mediaType === 'tv'), [knownFor]);
  const sourceKind = useSource(sourceId || undefined).data?.kind;
  // A Stalker portal's VOD is not in the local catalog: nothing could match, so nothing is asked.
  const lookups = loaded && sourceKind !== 'stalker';
  const movies = useCatalogMatches(movieBriefs, sourceId || undefined, 'movie', lookups);
  const shows = useCatalogMatches(tvBriefs, sourceId || undefined, 'series', lookups);
  const known = useMemo(() => [...movies.items, ...shows.items], [movies.items, shows.items]);
  const knownWatched = useWatchedKeys(known);

  let body;
  if (!settings.tmdb.enabled) {
    body = (
      <EmptyState
        icon={<UserRound size={28} />}
        title={t('tmdbOffTitle')}
        description={t('tmdbOffHint')}
        action={
          <Link to="/settings/metadata" className={buttonClass('primary', 'md')}>
            {t('openMetadataSettings')}
          </Link>
        }
      />
    );
  } else if (person.isError) {
    body = <TmdbErrorState error={person.error} onRetry={() => void person.refetch()} />;
  } else if (!valid || person.data === null) {
    body = <EmptyState icon={<UserRound size={28} />} title={t('personNotFound')} />;
  } else if (!person.data) {
    body = (
      <div role="status" aria-busy="true" className="flex flex-col gap-6 sm:flex-row">
        <span className="sr-only">{t('loading')}</span>
        <div className="skeleton-surface w-40 shrink-0 rounded-lg motion-safe:animate-shimmer sm:w-52" style={{ aspectRatio: 2 / 3 }} />
        <div className="flex flex-1 flex-col gap-3">
          <Skeleton className="h-10 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-full max-w-[72ch]" />
          <Skeleton className="h-4 w-5/6 max-w-[72ch]" />
        </div>
      </div>
    );
  } else {
    const p = person.data;
    const born = formatDate(p.birthday, i18n.language);
    const long = (p.biography?.length ?? 0) > BIO_CLAMP;
    body = (
      <>
        <section aria-labelledby="vod-actor-name" className="flex flex-col gap-6 sm:flex-row sm:items-start">
          <div className="w-40 shrink-0 overflow-hidden rounded-lg shadow-2 ring-1 ring-edge sm:w-52">
            <PosterCellWidthContext.Provider value={portraitWidth}>
              <Poster src={p.profileUrl} alt={p.name} aspect="poster" eager />
            </PosterCellWidthContext.Provider>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            {/* On a phone the movie and series heroes' size, the largest type under a header that is just Back. */}
            <h1 ref={nameRef} id="vod-actor-name" className="text-display text-fg max-sm:text-headline">
              {p.name}
            </h1>
            {(born || p.placeOfBirth) && (
              <p className="text-sm text-fg-muted">
                {born && t('bornOn', { date: born })}
                {born && p.placeOfBirth && ', '}
                {p.placeOfBirth && t('bornIn', { place: p.placeOfBirth })}
              </p>
            )}
            {p.biography ? (
              <div className="max-w-[72ch]">
                <p className={cn('whitespace-pre-line text-[calc(15rem/15)] leading-relaxed text-fg-muted', !expanded && long && 'line-clamp-6')}>{p.biography}</p>
                {long && (
                  <button type="button" className={cn(TEXT_LINK, 'mt-1 text-sm')} onClick={() => setExpanded((v) => !v)}>
                    {expanded ? t('showLess') : t('showMore')}
                  </button>
                )}
              </div>
            ) : (
              <p className="text-sm text-fg-subtle">{t('noBiography')}</p>
            )}
          </div>
        </section>
        <PosterRail<VodItem | SeriesItem>
          title={t('knownFor')}
          items={known}
          loading={known.length === 0 && (movies.pending || shows.pending)}
          bleed
          myList={myListTarget}
          empty={<p className="text-sm text-fg-subtle">{p.knownFor.length > 0 ? t('knownForNoneHere') : t('noKnownFor')}</p>}
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
              watched={knownWatched.has(itemKey(item.ref))}
              myList={myListTarget(item)}
              prefetch={sourceKind ? { ref: item.ref, sourceKind, posterUrl: item.posterUrl, backdropUrl: item.backdropUrl } : undefined}
            />
          )}
        />
        <TmdbAttribution />
      </>
    );
  }

  return (
    <div className="h-full overflow-x-hidden overflow-y-auto" data-testid="vod-actor">
      <Page width="wide" className="flex flex-col gap-10">
        {/* The loaded person renders a visible h1 with their name; every other state keeps one sr-only h1. */}
        {!loaded && <h1 className="sr-only">{pageTitle}</h1>}
        {body}
      </Page>
    </div>
  );
}
