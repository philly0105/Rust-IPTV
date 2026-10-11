import { UserRound } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { useRpcQuery } from '@/api/query';

import { TmdbAttribution } from '../components/TmdbAttribution';
import { TmdbRail } from '../components/TmdbRail';
import { useSettings } from '../hooks/queries';
import { usePageHeader } from '../hooks/usePageHeader';
import { EmptyState, ErrorState, Poster, Skeleton, buttonClass, cn } from '@/ui';

const BIO_CLAMP = 600;

function formatDate(iso: string | undefined, locale?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
}

/** TMDB person: portrait, facts, biography, and a known-for rail whose titles search the current source. */
export function ActorPage() {
  const { t, i18n } = useTranslation('vod');
  const { sourceId = '', personId = '' } = useParams();
  const settings = useSettings();
  const id = Number(personId);
  const valid = Number.isInteger(id) && id > 0;
  const person = useRpcQuery('tmdb.person', { personId: id }, { enabled: settings.tmdb.enabled && valid, staleTime: Infinity });
  const [expanded, setExpanded] = useState(false);

  // Mirrors the branch below that renders the visible h1 (the person's name).
  const loaded = settings.tmdb.enabled && valid && !person.isError && !!person.data;
  const pageTitle = loaded && person.data ? person.data.name : t('actor');
  usePageHeader({ title: pageTitle }, [pageTitle]);

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
    body = <ErrorState error={person.error} onRetry={() => void person.refetch()} />;
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
          <div className="w-40 shrink-0 overflow-hidden rounded-lg shadow-2 ring-1 ring-border/60 sm:w-52">
            <Poster src={p.profileUrl} alt={p.name} aspect="poster" eager />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <h1 id="vod-actor-name" className="font-display text-[clamp(28px,3vw,48px)] leading-tight font-semibold text-fg">
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
                <p className={cn('whitespace-pre-line text-[15px] leading-relaxed text-fg-muted', !expanded && long && 'line-clamp-6')}>{p.biography}</p>
                {long && (
                  <button type="button" className="mt-1 text-sm font-medium text-accent hover:underline" onClick={() => setExpanded((v) => !v)}>
                    {expanded ? t('showLess') : t('showMore')}
                  </button>
                )}
              </div>
            ) : (
              <p className="text-sm text-fg-subtle">{t('noBiography')}</p>
            )}
          </div>
        </section>
        <TmdbRail
          title={t('knownFor')}
          items={p.knownFor}
          sourceId={sourceId || undefined}
          empty={<p className="text-sm text-fg-subtle">{t('noKnownFor')}</p>}
        />
        <TmdbAttribution />
      </>
    );
  }

  return (
    <div className="h-full overflow-y-auto" data-testid="vod-actor">
      <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-10 px-4 py-8 md:px-8">
        {/* The loaded person renders a visible h1 with their name; every other state keeps one sr-only h1. */}
        {!loaded && <h1 className="sr-only">{pageTitle}</h1>}
        {body}
      </div>
    </div>
  );
}
