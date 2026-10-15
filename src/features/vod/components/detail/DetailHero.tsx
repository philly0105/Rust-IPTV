import { ArrowLeft, CircleAlert, Star } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useGoBack } from '../../hooks/useBackKey';
import { useFormatRuntime } from '../../hooks/useFormatRuntime';
import { formatRating } from '../../lib/format';
import { languageName } from '../../lib/language';
import type { DetailModel } from '../../lib/merge';
import { Poster, QUARTER_BLUR, Skeleton, cn, useImageChain } from '@/ui';
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
  const { t, i18n } = useTranslation('vod');
  const [expanded, setExpanded] = useState(false);
  const formatRuntime = useFormatRuntime();
  const runtime = formatRuntime(model.durationSeconds);
  const rating = formatRating(model.rating, i18n.language);
  const language = model.language ? languageName(model.language, i18n.language, (g) => t(`languageGroup_${g}`)) : undefined;
  const plotLong = (model.plot?.length ?? 0) > 360;

  return (
    // Not `isolate`: the backdrop's -z-10 must resolve against the page's
    // stacking context (the detail pages put `isolate` on their scroll root),
    // so it paints under everything that follows the hero, positioned or not.
    // An isolated hero would paint its bleed over the season tabs below.
    <section className="relative" aria-labelledby="vod-detail-title">
      <Backdrop backdropUrl={model.backdropUrl} posterUrl={model.posterUrl} sourceId={sourceId} />
      {/* L1-vod-2: the window has no browser chrome, so Back is on the page. */}
      <div className="absolute inset-x-0 top-0 z-10 mx-auto w-full max-w-[1800px] px-4 pt-4 md:px-8">
        <BackButton fallbackHref={`/s/${encodeURIComponent(sourceId)}/${model.mediaType === 'tv' ? 'series' : 'movies'}`} />
      </div>
      <div className="relative mx-auto flex w-full max-w-[1800px] flex-col gap-6 px-4 pt-[clamp(120px,22vh,280px)] pb-8 sm:flex-row sm:items-end md:px-8">
        <div className="w-36 shrink-0 overflow-hidden rounded-lg shadow-2 ring-1 ring-border/60 sm:w-44 lg:w-56" data-testid="vod-detail-poster">
          {/* Provider artwork first (through the cache, then directly); when it fails, the TMDB poster (if any) the same way. */}
          <Poster src={model.posterUrl} fallbackSrc={model.posterFallbackUrl} sourceId={sourceId} alt={model.title} aspect="poster" priority />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex flex-col gap-2">
            <h1
              id="vod-detail-title"
              dir="auto"
              className="text-match-parent font-display text-[clamp(28px,3.4vw,56px)] leading-[1.05] font-semibold tracking-[-0.01em] text-fg"
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
              {language && (
                <span data-testid="vod-detail-language" className="inline-flex items-center gap-1.5 text-fg">
                  <span aria-hidden className="rounded-sm bg-surface-3 px-1.5 py-0.5 text-[calc(11rem/15)] font-semibold tracking-wide">
                    {model.language?.code}
                  </span>
                  {language}
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
              <p dir="auto" className={cn('text-[calc(15rem/15)] leading-relaxed text-fg-muted text-match-parent', !expanded && plotLong && 'line-clamp-4')}>{model.plot}</p>
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
 * Back to where you came from (the grid or search restores its place), or to the
 * movies/series landing when the page was opened cold. A frosted pill, so it
 * reads on any backdrop.
 */
function BackButton({ fallbackHref }: { fallbackHref: string }) {
  const { t } = useTranslation('common');
  const goBack = useGoBack(fallbackHref);
  return (
    <button
      type="button"
      onClick={goBack}
      data-testid="vod-detail-back"
      className={cn(
        'inline-flex h-9 items-center gap-1.5 rounded-full border border-glass-border bg-glass ps-2.5 pe-3.5 text-sm font-medium text-on-glass shadow-1 glass-blur',
        'hover:bg-glass-strong active:bg-glass-strong focus-visible:outline-2 focus-visible:outline-offset-2',
        'motion-safe:transition-[background-color,translate] motion-safe:duration-150 motion-safe:active:translate-y-px',
      )}
    >
      <ArrowLeft aria-hidden size={16} className="rtl:rotate-180" />
      {t('back')}
    </button>
  );
}

/**
 * Decorative only. It is taller than the hero and bleeds behind the content
 * below (season tabs, episodes), so it must never take pointer events, and
 * it relies on the page root being the stacking context (`isolate`) so the
 * -z-10 puts it under that content rather than over it.
 *
 * The backdrop loads at high priority through the image cache (then directly,
 * then the poster the same way). A poster standing in for a missing backdrop
 * is drawn quarter-size, blurred and scaled up (C5): a soft colour field for a
 * sixteenth of the filter work of a full-size blur.
 */
function Backdrop({ backdropUrl, posterUrl, sourceId }: { backdropUrl?: string; posterUrl?: string; sourceId: string }) {
  const image = useImageChain([backdropUrl, posterUrl], sourceId);
  const wide = !!image.url && image.source === backdropUrl?.trim();
  return (
    <div
      aria-hidden
      data-testid="vod-detail-backdrop"
      className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[min(78vh,760px)] overflow-hidden select-none"
    >
      {image.url && (
        <img
          key={image.url}
          src={image.url}
          alt=""
          draggable={false}
          loading="eager"
          fetchPriority="high"
          decoding="async"
          referrerPolicy="no-referrer"
          data-backdrop-kind={wide ? 'backdrop' : 'poster'}
          onError={image.onError}
          className={wide ? 'h-full w-full object-cover object-top opacity-70' : cn(QUARTER_BLUR, 'object-top opacity-40')}
        />
      )}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-bg/10 via-bg/60 to-bg" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-bg/80 rtl:bg-gradient-to-l via-bg/20 to-transparent" />
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
