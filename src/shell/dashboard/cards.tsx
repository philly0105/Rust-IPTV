import { Play } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { ContentType, ItemRef, Source, SourceKind } from '@/api/types';
import { CARD_ART, CARD_ROOT, LiveBadge, Poster, ProgressBar, cn, hueOf, initialsOf } from '@/ui';

import type { RailCardProps } from './DashboardRail';

/** The focusable card; its focus ring, hover lift and press are drawn on the artwork (CARD_ART). */
const cardRoot = cn(CARD_ROOT, 'block w-full rounded-md text-start');

/**
 * The separator between short facts in a list. Intl.ListFormat's `unit` lists
 * are no use here: several locales join with a bare space (en narrow, ru, ko,
 * tr) or nothing (ja, zh), and ar adds "و" (and) that bidi pushes after a year. So
 * the separator is fixed per script: "、" (ideographic comma) for Japanese and Chinese, "، " (Arabic comma) for
 * Arabic scripts, ", " otherwise.
 */
function factSeparator(language: string): string {
  const base = language.toLowerCase();
  if (base.startsWith('ja') || base.startsWith('zh')) return '、';
  if (base.startsWith('ar') || base === 'ary' || base.startsWith('fa') || base.startsWith('ur')) return '، ';
  return ', ';
}

/** First-strong isolate (U+2068 ... U+2069): a part's own script sets its direction. */
const isolate = (part: string) => (/[\p{L}\p{N}]/u.test(part) ? `\u2068${part}\u2069` : part);

/**
 * Joins short facts ("120 channels", "40 movies") with the locale's separator,
 * each fact bidi-isolated so a Latin name or a year keeps its place in an RTL
 * list and vice versa. Falsy and empty parts are dropped. Exported for tests.
 */
export function joinList(parts: readonly (string | number | false | null | undefined)[], language: string): string {
  return parts
    .filter((p): p is string | number => p !== false && p !== null && p !== undefined && p !== '')
    .map((p) => isolate(String(p)))
    .join(factSeparator(language));
}

/** In-app path for an item's detail (movie/series) or browse (live/radio) page. */
export function itemPath(ref: ItemRef): string {
  const sid = encodeURIComponent(ref.sourceId);
  const iid = encodeURIComponent(ref.itemId);
  switch (ref.contentType) {
    case 'movie':
      return `/s/${sid}/movie/${iid}`;
    case 'series':
      return `/s/${sid}/series/${iid}`;
    case 'radio':
      return `/s/${sid}/radio`;
    default:
      return `/s/${sid}/live`;
  }
}

function PlayGlyph() {
  return (
    <span
      aria-hidden
      className="absolute inset-0 flex items-center justify-center bg-scrim/0 opacity-0 group-hover/card:bg-scrim/40 group-hover/card:opacity-100 group-focus-visible/card:opacity-100 motion-safe:transition-opacity"
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-accent text-accent-fg shadow-2 motion-safe:transition-transform motion-safe:duration-150 motion-safe:group-active/card:scale-90">
        <Play size={20} fill="currentColor" className="translate-x-px" />
      </span>
    </span>
  );
}

export interface PosterCardProps {
  rail: RailCardProps;
  title: string;
  subtitle?: string;
  posterUrl?: string;
  kind?: ContentType;
  /** 0..1 watched fraction. */
  progress?: number;
  /** Small overlay label, e.g. "S2 E4" or rating. */
  badge?: ReactNode;
  onPlay?: () => void;
  to?: string;
  ariaLabel?: string;
}

/** 2:3 artwork card; activates `onPlay` (button) or navigates to `to` (link). */
export function PosterCard({ rail, title, subtitle, posterUrl, progress, badge, onPlay, to, ariaLabel }: PosterCardProps) {
  const body = (
    <>
      <div className={CARD_ART}>
        {/* The caption below names the card; alt text would read the title twice. */}
        <Poster src={posterUrl} alt="" label={title} aspect="poster" className="after:hidden">
          {onPlay && <PlayGlyph />}
          {badge && <span className="absolute top-2 start-2">{badge}</span>}
          {progress !== undefined && progress > 0 && (
            <span className="absolute inset-x-2 bottom-2">
              <ProgressBar value={Math.min(1, progress) * 100} size="xs" className="bg-black/50" />
            </span>
          )}
        </Poster>
      </div>
      {/* dir="auto": a Latin title in an RTL UI truncates at its own end, not its start. */}
      <span dir="auto" className="mt-2 block truncate text-match-parent text-sm font-medium text-fg">{title}</span>
      {subtitle && <span dir="auto" className="block truncate text-match-parent text-sm text-fg-muted">{subtitle}</span>}
    </>
  );
  if (onPlay) {
    return (
      <button type="button" {...rail} onClick={onPlay} aria-label={ariaLabel} className={cardRoot}>
        {body}
      </button>
    );
  }
  return (
    <Link to={to ?? '#'} {...rail} aria-label={ariaLabel} className={cardRoot}>
      {body}
    </Link>
  );
}

export interface ChannelCardProps {
  rail: RailCardProps;
  name: string;
  logoUrl?: string;
  /** Current programme title. */
  now?: string;
  /** 0..1 progress through the current programme. */
  nowProgress?: number;
  sourceName?: string;
  isRadio?: boolean;
  onPlay: () => void;
  ariaLabel?: string;
}

/** 16:9 channel tile with the logo centered on a per-channel tint. */
export function ChannelCard({ rail, name, logoUrl, now, nowProgress, sourceName, isRadio, onPlay, ariaLabel }: ChannelCardProps) {
  const { t } = useTranslation('shell');
  const hue = hueOf(name);
  return (
    <button type="button" {...rail} onClick={onPlay} aria-label={ariaLabel} className={cardRoot}>
      <div
        className={cn(CARD_ART, 'aspect-video w-full')}
        style={{ background: `radial-gradient(120% 90% at 30% 20%, hsl(${hue} 35% 30% / 0.55), transparent 70%), var(--color-surface-2)` }}
      >
        <Poster src={logoUrl} alt="" label={name} aspect="wide" fit="contain" kind={isRadio ? 'radio' : 'live'} className="bg-transparent after:hidden" rounded="sm" />
        <PlayGlyph />
        <span className="absolute top-2 start-2">
          <LiveBadge />
        </span>
        {nowProgress !== undefined && (
          <span className="absolute inset-x-0 bottom-0">
            <ProgressBar value={nowProgress * 100} size="xs" className="rounded-none bg-black/40" />
          </span>
        )}
      </div>
      <span dir="auto" className="mt-2 block truncate text-match-parent text-sm font-medium text-fg">{name}</span>
      <span dir="auto" className="block truncate text-match-parent text-sm text-fg-muted">{now ?? sourceName ?? (isRadio ? t('radio') : t('liveTv'))}</span>
    </button>
  );
}

const KIND_NAMES: Record<SourceKind, string> = { m3u: 'M3U', xtream: 'Xtream', stalker: 'Stalker' };

/** Source tile: monogram, name, kind, and catalog counts. */
export function SourceCard({ rail, source }: { rail: RailCardProps; source: Source }) {
  const { t, i18n } = useTranslation('shell');
  const hue = hueOf(source.name);
  const counts = [
    source.channelCount > 0 && t('countChannels', { count: source.channelCount }),
    source.movieCount > 0 && t('countMovies', { count: source.movieCount }),
    source.seriesCount > 0 && t('countSeries', { count: source.seriesCount }),
  ];
  return (
    <Link to={`/s/${encodeURIComponent(source.id)}/live`} {...rail} className={cardRoot}>
      <div
        className={cn(CARD_ART, 'flex aspect-video w-full flex-col justify-between p-4')}
        style={{ background: `linear-gradient(150deg, hsl(${hue} 40% 30%), hsl(${(hue + 36) % 360} 46% 16%))` }}
      >
        {/* Decorative: the link's name reads the source name first, then its kind (sr-only below). */}
        <span aria-hidden className="font-display text-4xl font-semibold text-white/90">{initialsOf(source.name)}</span>
        <span aria-hidden className="self-start rounded-sm bg-black/35 px-1.5 py-0.5 text-xs font-semibold text-white">{KIND_NAMES[source.kind]}</span>
        {source.lastError && (
          <span aria-hidden className="absolute top-3 end-3 h-2.5 w-2.5 rounded-full bg-danger ring-2 ring-black/30" title={t('sourceHasError')} />
        )}
      </div>
      <span dir="auto" className="mt-2 block truncate text-match-parent text-sm font-medium text-fg">
        {source.name}
      </span>
      {/* A title alone is never read on a link; these join the card's name after the source name. */}
      <span className="sr-only" data-testid="source-card-kind">{`, ${KIND_NAMES[source.kind]}`}</span>
      {source.lastError && <span className="sr-only">{`, ${t('sourceHasError')}`}</span>}
      <span className="block truncate text-sm text-fg-muted">{joinList(counts, i18n.language) || t('emptySource')}</span>
    </Link>
  );
}
