import { CircleAlert, Star } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useFormatRuntime } from '../../hooks/useFormatRuntime';
import { formatRating } from '../../lib/format';
import type { DetailModel } from '../../lib/merge';
import { Poster, Skeleton, cn } from '@/ui';
import { CastRow } from './CastRow';

export interface DetailHeroProps {
  model: DetailModel;
  sourceId: string;
  /** Primary and secondary actions. */
  actions: ReactNode;
  /** Small chips after the meta line (Offline, Enriched, status). */
  chips?: ReactNode;
  /** Line under the actions (e.g. "Plays from <source>"). */
  note?: ReactNode;
  /** Inline status above the actions (e.g. provider details unavailable). */
  notice?: ReactNode;
}

/**
 * Browse-state hero: the backdrop bleeds across the top and fades into the
 * page; poster and the text column sit on its lower edge. The title is the
 * one large type moment on the page.
 */
export function DetailHero({ model, sourceId, actions, chips, note, notice }: DetailHeroProps) {
  const { t } = useTranslation('vod');
  const [expanded, setExpanded] = useState(false);
  // Provider artwork first; when it fails to load, the TMDB poster (if any) takes its place.
  const [failedPoster, setFailedPoster] = useState<string | undefined>(undefined);
  const posterSrc = failedPoster !== undefined && failedPoster === model.posterUrl && model.posterFallbackUrl ? model.posterFallbackUrl : model.posterUrl;
  const formatRuntime = useFormatRuntime();
  const runtime = formatRuntime(model.durationSeconds);
  const rating = formatRating(model.rating);
  const plotLong = (model.plot?.length ?? 0) > 360;

  return (
    // Not `isolate`: the backdrop's -z-10 must resolve against the page's
    // stacking context (the detail pages put `isolate` on their scroll root),
    // so it paints under everything that follows the hero, positioned or not.
    // An isolated hero would paint its bleed over the season tabs below.
    <section className="relative" aria-labelledby="vod-detail-title">
      <Backdrop url={model.backdropUrl ?? model.posterUrl} blurred={!model.backdropUrl} />
      <div className="relative mx-auto flex w-full max-w-[1800px] flex-col gap-6 px-4 pt-[clamp(120px,22vh,280px)] pb-8 sm:flex-row sm:items-end md:px-8">
        <div
          className="w-36 shrink-0 overflow-hidden rounded-lg shadow-2 ring-1 ring-border/60 sm:w-44 lg:w-56"
          data-testid="vod-detail-poster"
          onError={() => {
            if (posterSrc === model.posterUrl) setFailedPoster(model.posterUrl);
          }}
        >
          <Poster src={posterSrc} alt={model.title} aspect="poster" eager />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex flex-col gap-2">
            <h1
              id="vod-detail-title"
              className="font-display text-[clamp(28px,3.4vw,56px)] leading-[1.05] font-semibold tracking-[-0.01em] text-fg"
            >
              {model.titleBase ?? model.title}
            </h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-muted">
              {model.year && <span className="tabular">{model.year}</span>}
              {runtime && <span className="tabular">{runtime}</span>}
              {rating && (
                <span className="tabular inline-flex items-center gap-1 text-fg">
                  <Star aria-hidden size={14} className="fill-current text-accent" />
                  {rating}
                  <span className="sr-only">{t('ratingOutOfTen')}</span>
                </span>
              )}
              {model.genres.length > 0 && <span>{model.genres.slice(0, 4).join(', ')}</span>}
              {chips}
            </div>
          </div>
          {notice && (
            <p role="status" className="inline-flex max-w-[72ch] items-start gap-2 text-sm text-fg-muted">
              <CircleAlert aria-hidden size={16} className="mt-0.5 shrink-0 text-warning" />
              {notice}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
          {note && <div className="text-xs text-fg-subtle">{note}</div>}
          {model.plot && (
            <div className="max-w-[72ch]">
              <p className={cn('text-[15px] leading-relaxed text-fg-muted', !expanded && plotLong && 'line-clamp-4')}>{model.plot}</p>
              {plotLong && (
                <button type="button" className="mt-1 text-sm font-medium text-accent hover:underline" onClick={() => setExpanded((v) => !v)}>
                  {expanded ? t('showLess') : t('showMore')}
                </button>
              )}
            </div>
          )}
          {model.director && (
            <p className="text-sm text-fg-muted">
              <span className="text-fg-subtle">{t(model.mediaType === 'tv' ? 'createdBy' : 'director')} </span>
              {model.director}
            </p>
          )}
          {model.cast.length > 0 && <CastRow cast={model.cast} sourceId={sourceId} />}
        </div>
      </div>
    </section>
  );
}

/**
 * Decorative only. It is taller than the hero and bleeds behind the content
 * below (season tabs, episodes), so it must never take pointer events, and
 * it relies on the page root being the stacking context (`isolate`) so the
 * -z-10 puts it under that content rather than over it.
 */
function Backdrop({ url, blurred }: { url?: string; blurred: boolean }) {
  const [failed, setFailed] = useState(false);
  return (
    <div
      aria-hidden
      data-testid="vod-detail-backdrop"
      className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[min(78vh,760px)] overflow-hidden select-none"
    >
      {url && !failed && (
        <img
          src={url}
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
          className={cn('h-full w-full object-cover object-top', blurred ? 'scale-110 opacity-40 blur-2xl' : 'opacity-70')}
        />
      )}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-bg/10 via-bg/60 to-bg" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-bg/80 via-bg/20 to-transparent" />
    </div>
  );
}

export function DetailHeroSkeleton() {
  const { t } = useTranslation('vod');
  return (
    <div role="status" aria-busy="true" className="mx-auto flex w-full max-w-[1800px] flex-col gap-6 px-4 pt-[clamp(120px,22vh,280px)] pb-8 sm:flex-row sm:items-end md:px-8">
      <span className="sr-only">{t('loading')}</span>
      <div className="skeleton-surface w-36 shrink-0 rounded-lg motion-safe:animate-shimmer sm:w-44 lg:w-56" style={{ aspectRatio: 2 / 3 }} />
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <Skeleton className="h-12 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <div className="flex gap-2">
          <Skeleton className="h-12 w-36 rounded-md" />
          <Skeleton className="h-12 w-28 rounded-md" />
        </div>
        <Skeleton className="h-4 w-full max-w-[72ch]" />
        <Skeleton className="h-4 w-5/6 max-w-[72ch]" />
        <Skeleton className="h-4 w-2/3 max-w-[72ch]" />
      </div>
    </div>
  );
}
