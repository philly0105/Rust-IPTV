import { Play } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { ContentType, ItemRef, Source, SourceKind } from '@/api/types';
import { LiveBadge, Poster, ProgressBar, cn, hueOf, initialsOf } from '@/ui';

import type { RailCardProps } from './DashboardRail';

const cardFocus =
  'group/card block w-full rounded-md text-left outline-offset-4 focus-visible:outline-2';

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

function Lift({ children }: { children: ReactNode }) {
  return (
    <div className="relative motion-safe:transition-transform motion-safe:duration-200 group-hover/card:-translate-y-0.5 group-focus-visible/card:-translate-y-0.5">
      {children}
    </div>
  );
}

function PlayGlyph() {
  return (
    <span
      aria-hidden
      className="absolute inset-0 flex items-center justify-center bg-scrim/0 opacity-0 group-hover/card:bg-scrim/40 group-hover/card:opacity-100 group-focus-visible/card:opacity-100 motion-safe:transition-opacity"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent text-accent-fg shadow-2">
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
      <Lift>
        <Poster src={posterUrl} alt={title} aspect="poster" className="shadow-1">
          {onPlay && <PlayGlyph />}
          {badge && <span className="absolute top-2 left-2">{badge}</span>}
          {progress !== undefined && progress > 0 && (
            <span className="absolute inset-x-2 bottom-2">
              <ProgressBar value={Math.min(1, progress) * 100} size="xs" className="bg-black/50" />
            </span>
          )}
        </Poster>
      </Lift>
      <span className="mt-2 block truncate text-sm font-medium text-fg">{title}</span>
      {subtitle && <span className="block truncate text-[13px] text-fg-muted">{subtitle}</span>}
    </>
  );
  if (onPlay) {
    return (
      <button type="button" {...rail} onClick={onPlay} aria-label={ariaLabel} className={cardFocus}>
        {body}
      </button>
    );
  }
  return (
    <Link to={to ?? '#'} {...rail} aria-label={ariaLabel} className={cardFocus}>
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
    <button type="button" {...rail} onClick={onPlay} aria-label={ariaLabel} className={cardFocus}>
      <Lift>
        <div
          className="relative aspect-video w-full overflow-hidden rounded-md border border-border shadow-1"
          style={{ background: `radial-gradient(120% 90% at 30% 20%, hsl(${hue} 35% 30% / 0.55), transparent 70%), var(--color-surface-2)` }}
        >
          <Poster src={logoUrl} alt={name} aspect="wide" fit="contain" kind={isRadio ? 'radio' : 'live'} className="bg-transparent" rounded="sm" />
          <PlayGlyph />
          <span className="absolute top-2 left-2">
            <LiveBadge />
          </span>
          {nowProgress !== undefined && (
            <span className="absolute inset-x-0 bottom-0">
              <ProgressBar value={nowProgress * 100} size="xs" className="rounded-none bg-black/40" />
            </span>
          )}
        </div>
      </Lift>
      <span className="mt-2 block truncate text-sm font-medium text-fg">{name}</span>
      <span className="block truncate text-[13px] text-fg-muted">{now ?? sourceName ?? (isRadio ? t('radio') : t('liveTv'))}</span>
    </button>
  );
}

const KIND_NAMES: Record<SourceKind, string> = { m3u: 'M3U', xtream: 'Xtream', stalker: 'Stalker' };

/** Source tile: monogram, name, kind, and catalog counts. */
export function SourceCard({ rail, source }: { rail: RailCardProps; source: Source }) {
  const { t } = useTranslation('shell');
  const hue = hueOf(source.name);
  const counts = [
    source.channelCount > 0 && t('countChannels', { count: source.channelCount }),
    source.movieCount > 0 && t('countMovies', { count: source.movieCount }),
    source.seriesCount > 0 && t('countSeries', { count: source.seriesCount }),
  ].filter(Boolean) as string[];
  return (
    <Link to={`/s/${encodeURIComponent(source.id)}/live`} {...rail} className={cardFocus}>
      <Lift>
        <div
          className="relative flex aspect-video w-full flex-col justify-between overflow-hidden rounded-md border border-border p-4 shadow-1"
          style={{ background: `linear-gradient(150deg, hsl(${hue} 40% 30%), hsl(${(hue + 36) % 360} 46% 16%))` }}
        >
          <span className="font-display text-4xl font-semibold text-white/90">{initialsOf(source.name)}</span>
          <span className="self-start rounded-sm bg-black/35 px-1.5 py-0.5 text-[11px] font-semibold text-white">{KIND_NAMES[source.kind]}</span>
          {source.lastError && <span className="absolute top-3 right-3 h-2.5 w-2.5 rounded-full bg-danger ring-2 ring-black/30" title={t('sourceHasError')} />}
        </div>
      </Lift>
      <span className="mt-2 block truncate text-sm font-medium text-fg">{source.name}</span>
      <span className={cn('block truncate text-[13px] text-fg-muted')}>{counts.join(', ') || t('emptySource')}</span>
    </Link>
  );
}
