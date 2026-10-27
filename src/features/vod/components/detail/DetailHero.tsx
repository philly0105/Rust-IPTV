import { CircleAlert, Star } from 'lucide-react';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

// The store module, not the barrel: pages that mock '@/shell' in their tests still render the hero.
import { useHeaderTitleAnchor } from '@/shell/store';

import { useFormatRuntime } from '../../hooks/useFormatRuntime';
import { formatRating } from '../../lib/format';
import { languageName } from '../../lib/language';
import type { DetailModel } from '../../lib/merge';
import { MetaLine, Poster, ProgressBar, QUARTER_BLUR, Skeleton, TEXT_LINK, cn, hueOf, useImageChain } from '@/ui';
import { formatList } from '@/lib/intl';
import { CastRow } from './CastRow';

/** The column grid of the hero: poster beside the title on every width, the body under the title from sm. */
const HERO_GRID =
  'relative grid w-full max-w-[120rem] grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-5 px-(--page-gutter) pb-8 ' +
  'sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-x-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-x-8';

/**
 * Space above the poster: room for the artwork when there is a backdrop, little when there is none.
 * Back lives in the shell header, so nothing sits in that space: on a phone the poster starts a
 * little way into the artwork, so the first screen holds the title, Play and the plot rather than
 * a band of empty gradient (critique: phone detail).
 */
const HERO_TOP_WITH_ART = 'pt-[clamp(88px,20vh,240px)] max-sm:pt-10';
const HERO_TOP_PLAIN = 'pt-10 max-sm:pt-6';
/** The same with a Back pill of the page's own in the hero's top corner (`back`). */
const HERO_TOP_WITH_ART_BACK = 'pt-[clamp(88px,20vh,240px)] max-sm:pt-20';
const HERO_TOP_PLAIN_BACK = 'pt-[clamp(56px,9vh,112px)] max-sm:pt-20';

export interface DetailHeroProps {
  model: DetailModel;
  sourceId: string;
  /**
   * The text buttons of the action row: the one primary button (Play or Resume) and at most one
   * more (Trailer), in a `HeroActionGroup`.
   */
  actions: ReactNode;
  /**
   * The round icon buttons after them (VL-hero-actions): IconButton lg secondary `rounded-full`,
   * each in a `HeroIcon` with its caption, ending in a More menu (HERO_MENU_TRIGGER). They form
   * their own group, so a narrow column breaks the row between the text and the icons, never
   * inside either; on a phone they are a row of captioned tiles under the progress.
   */
  icons?: ReactNode;
  /**
   * How far the resume point is, drawn as a bar with its caption ("42 min left"). It sits under
   * the whole row, and on a phone right under the full-width Resume button it describes.
   */
  progress?: { fraction: number; label: string } | undefined;
  /** More facts at the end of the meta line (series status, Downloaded). */
  chips?: ReactNode[];
  /** Line under the actions (e.g. "Plays from <source>"). */
  note?: ReactNode;
  /** Inline status above the actions (e.g. provider details unavailable). */
  notice?: ReactNode;
  /**
   * The provider's details are still coming (a catalog row stands in): the hero keeps the
   * artwork's room above the poster, as the skeleton does, so it does not drop when a backdrop
   * arrives with them.
   */
  pending?: boolean;
  /** Cast names link to their actor pages only when TMDB can show them (VL-tmdb-deadend). */
  castLinks?: boolean;
  /**
   * A Back control of the page's own in the hero's top corner. The catalogue pages put Back in the
   * shell header instead (usePageHeader `back`), so by default the hero has none.
   */
  back?: ReactNode;
}

/**
 * Browse-state hero (VL-hero-chrome): the backdrop runs full bleed across the top at full strength
 * and fades into the page only at its lower part and its leading edge, where the text sits, so the
 * artwork reads and the title and buttons stay legible on any image. Poster and title sit on its
 * lower edge; the title is the one large type moment on the page.
 */
export function DetailHero({ model, sourceId, actions, icons, progress, chips, note, notice, pending, castLinks = true, back }: DetailHeroProps) {
  const { t, i18n } = useTranslation('vod');
  const [expanded, setExpanded] = useState(false);
  const formatRuntime = useFormatRuntime();
  const runtime = formatRuntime(model.durationSeconds);
  const rating = formatRating(model.rating, i18n.language);
  const language = model.language ? languageName(model.language, i18n.language, (g) => t(`languageGroup_${g}`)) : undefined;
  const plotLong = (model.plot?.length ?? 0) > 360;
  // The header names the section until this h1 scrolls away, then fades the title in.
  const titleRef = useHeaderTitleAnchor();
  const top = model.backdropUrl || pending ? (back ? HERO_TOP_WITH_ART_BACK : HERO_TOP_WITH_ART) : back ? HERO_TOP_PLAIN_BACK : HERO_TOP_PLAIN;

  return (
    // Not `isolate`: the backdrop's -z-10 must resolve against the page's
    // stacking context (the detail pages put `isolate` on their scroll root),
    // so it paints under everything that follows the hero, positioned or not.
    // An isolated hero would paint its bleed over the season tabs below.
    <section className="relative" aria-labelledby="vod-detail-title">
      <Backdrop backdropUrl={model.backdropUrl} posterUrl={model.posterUrl} sourceId={sourceId} title={model.title} />
      {back && <div className="absolute inset-x-0 top-0 z-10 w-full max-w-[120rem] px-(--page-gutter) pt-4">{back}</div>}
      <div className={cn(HERO_GRID, top)}>
        <div
          className="self-end overflow-hidden rounded-lg shadow-2 ring-1 ring-edge sm:row-span-2 sm:self-start"
          data-testid="vod-detail-poster"
        >
          {/* Provider artwork first (through the cache, then directly); when it fails, the TMDB poster (if any) the same way. */}
          <Poster src={model.posterUrl} fallbackSrc={model.posterFallbackUrl} sourceId={sourceId} alt={model.title} aspect="poster" priority />
        </div>
        <div className="flex min-w-0 flex-col gap-2 self-end">
          {/* Focusable from script only: a title opened without a primary action lands here (useFocusOnOpen). */}
          <h1 ref={titleRef} id="vod-detail-title" dir="auto" tabIndex={-1} className="text-match-parent outline-none text-display text-fg max-sm:text-headline">
            {model.titleBase ?? model.title}
          </h1>
          <MetaLine
            data-testid="vod-detail-meta"
            className="text-body-sm text-fg-muted"
            items={[
              model.year && <span className="tabular">{model.year}</span>,
              runtime && <span className="tabular">{runtime}</span>,
              rating && (
                <span className="tabular inline-flex items-center gap-1 text-fg">
                  <Star aria-hidden size={14} className="fill-current text-accent" />
                  {rating}
                  <span className="sr-only">{t('ratingOutOfTen')}</span>
                </span>
              ),
              language && (
                <span data-testid="vod-detail-language" className="inline-flex items-center gap-1.5 text-fg">
                  <span aria-hidden className="rounded-xs bg-surface-3 px-1.5 py-0.5 text-2xs font-semibold tracking-wide">
                    {model.language?.code}
                  </span>
                  {language}
                </span>
              ),
              model.genres.length > 0 && formatList(model.genres.slice(0, 3), i18n.language),
              ...(chips ?? []),
            ]}
          />
        </div>
        <div className="col-span-2 flex min-w-0 flex-col gap-4 sm:col-span-1 sm:col-start-2">
          {notice && (
            <p role="status" className="inline-flex max-w-[72ch] items-start gap-2 text-sm text-fg-muted">
              <CircleAlert aria-hidden size={16} className="mt-0.5 shrink-0 text-warning" />
              {notice}
            </p>
          )}
          {/* Two groups (the text buttons, the icon buttons): a narrow column breaks between them, never
              inside one. The progress line follows the buttons in the DOM, Resume first; from sm it is
              drawn under the whole row, on a phone between Resume and the icon tiles. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="vod-hero-actions">
            {actions}
            {progress && (
              <div className="flex basis-full items-center gap-2 text-caption text-fg-muted sm:order-last" data-testid="vod-hero-progress">
                <ProgressBar value={progress.fraction} max={1} size="xs" className="w-32 max-sm:w-auto max-sm:flex-1" label={progress.label} />
                <span className="tabular">{progress.label}</span>
              </div>
            )}
            {icons && <HeroIconGroup>{icons}</HeroIconGroup>}
          </div>
          {note && <div className="text-xs text-fg-subtle">{note}</div>}
          {model.plot && (
            <div className="max-w-[72ch]">
              <p dir="auto" className={cn('text-body leading-relaxed text-fg-muted text-match-parent', !expanded && plotLong && 'line-clamp-4')}>{model.plot}</p>
              {plotLong && (
                <button type="button" className={cn(TEXT_LINK, 'mt-1 text-sm')} onClick={() => setExpanded((v) => !v)}>
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
          {model.cast.length > 0 && <CastRow cast={model.cast} sourceId={sourceId} links={castLinks} />}
        </div>
      </div>
    </section>
  );
}

/**
 * The text buttons of the hero's action row: they stay on one line together, and on a phone the
 * primary takes the whole width. The icon buttons are a `HeroIconGroup` (DetailHero's `icons`).
 */
export function HeroActionGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex min-w-0 items-center gap-2', className)}>{children}</div>;
}

/**
 * The round icon buttons of the hero, and of the row under the player in watch state. From sm
 * they sit in a line beside the text buttons. Touch shows no tooltips, so on a phone they are a
 * grid of equal tiles across the width, each circle over its caption (the Netflix mobile row).
 */
export function HeroIconGroup({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 items-start gap-2 max-sm:grid max-sm:w-full max-sm:auto-cols-fr max-sm:grid-flow-col max-sm:gap-1', className)} data-testid="vod-hero-icons">
      {children}
    </div>
  );
}

/**
 * One round icon button of a `HeroIconGroup` with its caption, which shows on a phone only. The
 * button keeps its accessible name; the caption is a shorter form of it ("Watched" for "Mark as
 * watched"), hidden from assistive tech so the name is not read twice.
 */
export function HeroIcon({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-1">
      {children}
      <span aria-hidden className="max-w-full truncate text-caption text-fg-muted sm:hidden">
        {caption}
      </span>
    </div>
  );
}

/** The hero's More menu trigger: the Menu's own icon button, drawn as the other round secondaries. */
export const HERO_MENU_TRIGGER =
  'h-12 w-12 rounded-full border border-edge bg-surface-2 text-fg hover:bg-surface-3 hover:text-fg active:bg-pressed active:text-fg';

/**
 * The hero's Back pill, for a page that passes its own `back`: the kit back button on a frosted
 * page surface, so it reads on any backdrop, and in the light theme it is a light pill instead of
 * a dark glass capsule over pale artwork (critique: light detail).
 */
export const HERO_BACK = 'border border-edge bg-surface/80 text-fg shadow-1 glass-blur hover:bg-surface hover:text-fg active:bg-surface-2';

/**
 * The title's tint as two soft washes from the top edge, for a hero with no artwork at all: one
 * in the poster fallback's hue towards the far side, one in its second hue at the leading corner.
 * Pale in the light theme, deep in the dark one. The hue is the Poster fallback's (`hueOf` of the
 * same title), so the page reads as the title the poster tile stands for.
 */
export function heroWash(title: string, dark: boolean): string {
  const hue = hueOf(title);
  const second = (hue + 40) % 360;
  return dark
    ? `radial-gradient(60% 100% at 78% 0%, hsl(${hue} 45% 34% / 0.75), transparent 72%), radial-gradient(50% 80% at 8% 0%, hsl(${second} 50% 24% / 0.6), transparent 70%)`
    : `radial-gradient(60% 100% at 78% 0%, hsl(${hue} 55% 84% / 0.9), transparent 72%), radial-gradient(50% 80% at 8% 0%, hsl(${second} 45% 88% / 0.8), transparent 70%)`;
}

function Backdrop({ backdropUrl, posterUrl, sourceId, title }: { backdropUrl?: string; posterUrl?: string; sourceId: string; title: string }) {
  const image = useImageChain([backdropUrl, posterUrl], sourceId);
  const wide = !!image.url && image.source === backdropUrl?.trim();
  return (
    <div
      aria-hidden
      data-testid="vod-detail-backdrop"
      className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[min(78vh,760px)] overflow-hidden select-none"
    >
      {/* No picture at all (none given, or every attempt failed): the title's tint instead of a flat
          page, as Home's hero does. Only once the chain has run out, so a loading backdrop never
          flashes from the tint's colour to its own. Under the fades, so the text keeps its contrast. */}
      {image.failed && (
        <div
          data-testid="vod-detail-wash"
          className="pointer-events-none absolute inset-0 [background-image:var(--wash-light)] dark:[background-image:var(--wash-dark)]"
          style={{ '--wash-light': heroWash(title, false), '--wash-dark': heroWash(title, true) } as CSSProperties}
        />
      )}
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
          // A real backdrop shows at full strength; a poster standing in is only a blurred colour field.
          className={wide ? 'h-full w-full object-cover object-top' : cn(QUARTER_BLUR, 'object-top opacity-50')}
        />
      )}
      {/* The top quarter stays clear; below it the art fades into the page, where the title and buttons sit. */}
      <div className="pointer-events-none absolute inset-0 bg-linear-to-b from-transparent from-25% via-bg/75 via-60% to-bg" />
      {/* The leading edge darkens behind the text column only; the far side of the artwork stays clear. */}
      <div className="pointer-events-none absolute inset-0 bg-linear-to-r from-bg/90 via-bg/50 via-40% to-transparent to-75% rtl:bg-linear-to-l" />
    </div>
  );
}

export function DetailHeroSkeleton() {
  const { t } = useTranslation('vod');
  return (
    <div role="status" aria-busy="true" className={cn(HERO_GRID, HERO_TOP_WITH_ART)}>
      <span className="sr-only">{t('loading')}</span>
      <div className="skeleton-surface w-full self-end rounded-lg motion-safe:animate-shimmer sm:row-span-2 sm:self-start" style={{ aspectRatio: 2 / 3 }} />
      <div className="flex min-w-0 flex-col gap-3 self-end">
        <Skeleton className="h-12 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
      </div>
      <div className="col-span-2 flex min-w-0 flex-col gap-4 sm:col-span-1 sm:col-start-2">
        <div className="flex gap-2">
          <Skeleton className="h-12 w-36 rounded-md" />
          <Skeleton className="h-12 w-12 rounded-full" />
          <Skeleton className="h-12 w-12 rounded-full" />
          <Skeleton className="h-12 w-12 rounded-full" />
        </div>
        <Skeleton className="h-4 w-full max-w-[72ch]" />
        <Skeleton className="h-4 w-5/6 max-w-[72ch]" />
        <Skeleton className="h-4 w-2/3 max-w-[72ch]" />
      </div>
    </div>
  );
}
