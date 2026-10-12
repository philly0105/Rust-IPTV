import { Star } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { formatRating } from '../lib/format';
import { languageName, type ItemLanguage } from '../lib/language';
import { joinList } from '@/shell/dashboard/cards';
import { Poster, ProgressBar, Skeleton, cn } from '@/ui';

export interface PosterCardProps {
  /** Caption; pass `titleBase` so a year already in `year`/`meta` is not shown twice. */
  title: string;
  /** Full title for the tooltip when the caption is shortened (defaults to `title`). */
  fullTitle?: string;
  href: string;
  posterUrl?: string;
  year?: number;
  rating?: number;
  /** 0..1 watched fraction; shows a thin bar over the poster when > 0. */
  progress?: number;
  /** Small overlay in the top-left corner (source badge, "New"). */
  badge?: ReactNode;
  /** Text of `badge` for the card's accessible name (the overlay itself is decorative). */
  badgeLabel?: string;
  /** Secondary line under the title (overrides year). */
  meta?: ReactNode;
  /** Audio language from the provider title or category (`itemLanguage`): a code badge on the poster and the name in the caption. */
  language?: ItemLanguage | undefined;
  index?: number;
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
  className?: string;
  /** Hold focus by keyboard without being in the tab order (roving). */
  tabIndex?: number;
  /** Keyboard cursor of a listbox grid (aria-activedescendant) rests here. */
  active?: boolean;
  /**
   * False inside a listbox option (VirtualGrid): render a plain block instead
   * of a link, because an interactive element inside an option is
   * `nested-interactive`. The grid's onSelect/Enter does the navigation, and
   * the card text becomes the option's accessible name.
   */
  interactive?: boolean;
}

/**
 * Accessible name for a poster card: the full title, the year once (unless the
 * title already carries it), a plain-text secondary line, the badge text, and
 * the rating as a sentence. Without it the name read "8.2Black Harbor (2026)2026".
 */
export function posterCardLabel(parts: {
  title: string;
  year?: number | undefined;
  meta?: ReactNode;
  badgeLabel?: string | undefined;
  languageLabel?: string | undefined;
  rating?: string | undefined;
  ratedLabel: (rating: string) => string;
  /** "40% watched" when the title has a saved position. */
  progressLabel?: string | undefined;
}): string {
  const yearText = parts.year !== undefined ? String(parts.year) : undefined;
  const name = yearText && !parts.title.includes(yearText) ? `${parts.title} (${yearText})` : parts.title;
  const out = [name];
  const meta = typeof parts.meta === 'string' || typeof parts.meta === 'number' ? String(parts.meta).trim() : '';
  if (meta && !name.includes(meta)) out.push(meta);
  if (parts.languageLabel) out.push(parts.languageLabel);
  if (parts.badgeLabel) out.push(parts.badgeLabel);
  if (parts.rating) out.push(parts.ratedLabel(parts.rating));
  if (parts.progressLabel) out.push(parts.progressLabel);
  return out.join(', ');
}

/**
 * Poster tile used by grids and rails. The poster carries the identity; the
 * caption is quiet. Focus draws the amber ring around the artwork only.
 */
export function PosterCard({
  title,
  fullTitle,
  href,
  posterUrl,
  year,
  rating,
  progress,
  badge,
  badgeLabel,
  meta,
  language,
  index,
  onClick,
  className,
  tabIndex,
  active,
  interactive = true,
}: PosterCardProps) {
  const { t, i18n } = useTranslation('vod');
  const r = formatRating(rating, i18n.language);
  const langName = language ? languageName(language, i18n.language, (g) => t(`languageGroup_${g}`)) : undefined;
  const hasProgress = progress !== undefined && Number.isFinite(progress) && progress > 0;
  const progressLabel = hasProgress ? t('percentWatched', { percent: Math.max(1, Math.round(Math.min(1, progress) * 100)) }) : undefined;
  const label = posterCardLabel({
    title: fullTitle ?? title,
    year,
    meta,
    badgeLabel,
    languageLabel: langName,
    rating: r ?? undefined,
    ratedLabel: (v) => t('posterRated', { rating: v }),
    progressLabel,
  });
  const secondary = meta ?? year;
  const content = (
    <>
      <div
        className={cn(
          'relative overflow-hidden rounded-md shadow-1 ring-1 ring-border/60',
          'group-hover:ring-fg-subtle group-focus-visible:ring-2 group-focus-visible:ring-focus',
          active && 'ring-2 ring-focus',
          'motion-safe:transition-[box-shadow,transform] motion-safe:duration-150 motion-safe:group-hover:-translate-y-0.5',
        )}
      >
        <Poster src={posterUrl} alt="" label={title} aspect="poster" />
        {badge && (
          <div aria-hidden className="pointer-events-none absolute start-1.5 top-1.5 flex gap-1">
            {badge}
          </div>
        )}
        {r && (
          <div aria-hidden className="tabular pointer-events-none absolute end-1.5 top-1.5 inline-flex items-center gap-1 rounded-sm bg-scrim px-1.5 py-0.5 text-[11px] font-semibold text-white">
            <Star aria-hidden size={11} className="fill-current text-accent" />
            {r}
          </div>
        )}
        {language && (
          <div
            aria-hidden
            className={cn(
              'pointer-events-none absolute start-1.5 rounded-sm bg-scrim px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-white',
              hasProgress ? 'bottom-5' : 'bottom-1.5',
            )}
          >
            {language.code}
          </div>
        )}
        {hasProgress && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-scrim/60 px-1.5 pb-1.5 pt-1">
            <ProgressBar value={progress} max={1} />
          </div>
        )}
      </div>
      <div className="min-w-0 px-0.5">
        <div dir="auto" className="line-clamp-2 text-match-parent text-[13px] leading-snug font-medium text-fg group-hover:text-fg">
          {title}
        </div>
        <div className="tabular truncate text-xs text-fg-subtle">
          {secondary !== undefined && secondary !== null && secondary !== ''
            ? langName
              ? typeof secondary === 'string' || typeof secondary === 'number'
                ? joinList([secondary, langName], i18n.language)
                : <>{secondary}{listSeparator(i18n.language)}{langName}</>
              : secondary
            : (langName ?? ' ')}
        </div>
      </div>
    </>
  );
  const classes = cn('group flex min-w-0 flex-col gap-2 rounded-md outline-none', className);
  if (!interactive) {
    return (
      // A named, non-interactive group: its label becomes the option's accessible name.
      <div role="group" aria-label={label} data-grid-index={index} data-poster-card="" className={classes} title={fullTitle ?? title}>
        {content}
      </div>
    );
  }
  return (
    <Link
      to={href}
      onClick={onClick}
      data-grid-index={index}
      tabIndex={tabIndex}
      // The focus ring is drawn on the artwork (group-focus-visible below), not around the caption.
      className={classes}
      title={fullTitle ?? title}
      aria-label={label}
    >
      {content}
    </Link>
  );
}

/** Placeholder with the same footprint as `PosterCard`. */
export function PosterCardSkeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn('flex min-w-0 flex-col gap-2', className)}>
      <div className="skeleton-surface w-full rounded-md motion-safe:animate-shimmer" style={{ aspectRatio: 2 / 3 }} />
      <Skeleton className="h-3.5 w-4/5" />
      <Skeleton className="h-3 w-2/5 opacity-70" />
    </div>
  );
}

/** The locale's list separator ("、" in Japanese, "، " in Arabic), for a rich node followed by text. */
function listSeparator(language: string): string {
  return joinList(['\u0001', '\u0002'], language).slice(1, -1);
}
