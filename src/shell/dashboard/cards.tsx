import { BookmarkCheck, Play } from 'lucide-react';
import { createContext, useContext, useMemo, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { itemKey, type Channel, type ContentType, type ItemRef, type ItemSnapshot, type Source, type SourceKind } from '@/api/types';
import { MyListButton, canSave, useInMyList } from '@/features/mylist';
import { isRunningPhase, progressFraction, useImportProgressFeed, useSourceProgress } from '@/features/sources/lib/progress';
import { usePrefetchIntent, type PrefetchTarget } from '@/features/vod/hooks/prefetch';
import { intlLocale, listSeparator } from '@/lib/intl';
import { CARD_ART, CARD_ROOT, LivePill, Poster, ProgressBar, cn, hueOf, initialsOf } from '@/ui';

import type { RailCardProps } from './DashboardRail';
import { sourceHomePath } from '../railLinks';

/** The focusable card; its focus ring, hover lift and press are drawn on the artwork (CARD_ART). */
const cardRoot = cn(CARD_ROOT, 'block w-full rounded-md text-start');

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
    .join(listSeparator(language));
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

/**
 * Source kinds by source id, for hover prefetch targets (C4). The dashboard
 * provides it from `sources.list`; a card outside a provider, or of a source
 * not in it, simply does not prefetch.
 */
export const SourceKindContext = createContext<ReadonlyMap<string, SourceKind> | null>(null);

/**
 * The detail-page prefetch target for a movie or series ref, or null (no ref,
 * another content type, or an unknown source kind). Memoised on the ref's
 * fields, so a card re-rendered with an equal ref keeps the same target.
 */
export function usePrefetchTarget(ref: ItemRef | undefined, posterUrl?: string, backdropUrl?: string): PrefetchTarget | null {
  const kinds = useContext(SourceKindContext);
  const sourceId = ref?.sourceId;
  const contentType = ref?.contentType;
  const itemId = ref?.itemId;
  const sourceKind = sourceId !== undefined ? kinds?.get(sourceId) : undefined;
  return useMemo(() => {
    if (sourceId === undefined || itemId === undefined || !sourceKind) return null;
    if (contentType !== 'movie' && contentType !== 'series') return null;
    const target: PrefetchTarget = { ref: { sourceId, contentType, itemId }, sourceKind };
    if (posterUrl) target.posterUrl = posterUrl;
    if (backdropUrl) target.backdropUrl = backdropUrl;
    return target;
  }, [sourceId, contentType, itemId, sourceKind, posterUrl, backdropUrl]);
}

function PlayGlyph() {
  return (
    <span
      aria-hidden
      className="absolute inset-0 flex items-center justify-center bg-scrim/0 opacity-0 group-hover/card:bg-scrim/40 group-hover/card:opacity-100 group-focus-visible/card:opacity-100 motion-safe:transition-opacity"
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-accent-solid text-accent-solid-fg shadow-2 motion-safe:transition-transform motion-safe:duration-150 motion-safe:group-active/card:scale-90">
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
  /**
   * The movie or series My List saves (C3). A linked card gets the toggle beside its link; a play
   * card (Continue watching) gets the saved marker. Defaults to the title an `itemPath` link opens,
   * so the My List rail's cards take part too. Live, radio and search cards get neither.
   */
  myList?: { itemRef: ItemRef; snapshot: ItemSnapshot } | undefined;
  /**
   * The source the artwork belongs to, for the image cache (C3). Defaults to the source of the
   * card's title (`myList`, or the movie or series an `itemPath` link opens).
   */
  sourceId?: string;
  /** The title's backdrop, warmed with its detail page when a linked card is hovered or focused (C4). */
  backdropUrl?: string;
}

/**
 * The art's hover state driven by the wrapper of a card that has a My List toggle beside its
 * link, so moving the pointer from the poster onto the toggle keeps the card lifted. The toggle
 * layer takes the same lift, so the two move together (as on the VOD posters).
 */
const WRAPPER_HOVER_ART = 'group-hover/poster:shadow-2 group-hover/poster:ring-fg-subtle motion-safe:group-hover/poster:-translate-y-0.5';
const WRAPPER_HOVER_LAYER =
  'motion-safe:transition-[translate] motion-safe:duration-150 motion-safe:ease-out motion-safe:group-hover/poster:-translate-y-0.5 motion-safe:group-has-[a:active]/poster:translate-y-0';

const SAVED_PATH = /^\/s\/([^/]+)\/(movie|series)\/([^/?#]+)$/;

/** The movie or series an `itemPath` link opens, as a My List target; undefined for any other link. */
function linkTarget(to: string | undefined, title: string, posterUrl: string | undefined): PosterCardProps['myList'] {
  const m = to ? SAVED_PATH.exec(to) : null;
  if (!m) return undefined;
  const contentType = m[2] as 'movie' | 'series';
  const snapshot: ItemSnapshot = { title, contentType };
  if (posterUrl) snapshot.posterUrl = posterUrl;
  return { itemRef: { sourceId: decodeURIComponent(m[1]!), contentType, itemId: decodeURIComponent(m[3]!) }, snapshot };
}

/**
 * 2:3 artwork card; activates `onPlay` (button) or navigates to `to` (link). A link to a movie
 * or series prefetches its detail page when the pointer rests on it or it takes focus (C4).
 */
export function PosterCard(props: PosterCardProps) {
  const linked = props.onPlay ? undefined : linkTarget(props.to, props.title, props.posterUrl);
  const target = props.myList ?? linked;
  const withSource = { ...props, sourceId: props.sourceId ?? target?.itemRef.sourceId };
  if (!target || !canSave(target.itemRef)) return <PosterCardView {...withSource} />;
  if (props.onPlay) return <SavedMarkerCard {...withSource} itemRef={target.itemRef} />;
  return <MyListPosterCard {...withSource} myList={target} />;
}

interface PosterCardViewProps extends PosterCardProps {
  /** Drawn over the artwork's corner (the saved marker). */
  artCorner?: ReactNode;
  /** Extra classes for the artwork frame. */
  artClassName?: string;
}

function PosterCardView({
  rail,
  title,
  subtitle,
  posterUrl,
  backdropUrl,
  sourceId,
  progress,
  badge,
  onPlay,
  to,
  ariaLabel,
  artCorner,
  artClassName,
}: PosterCardViewProps) {
  // Only a link to a movie or series page prefetches; play cards and search links do not.
  const opens = onPlay ? undefined : linkTarget(to, title, posterUrl)?.itemRef;
  const intent = usePrefetchIntent(usePrefetchTarget(opens, posterUrl, backdropUrl));
  const body = (
    <>
      <div className={cn(CARD_ART, artClassName)}>
        {/* The caption below names the card; alt text would read the title twice. */}
        <Poster src={posterUrl} sourceId={sourceId} alt="" label={title} aspect="poster" className="after:hidden">
          {onPlay && <PlayGlyph />}
          {badge && <span className="absolute top-2 start-2">{badge}</span>}
          {progress !== undefined && progress > 0 && (
            <span className="absolute inset-x-2 bottom-2">
              <ProgressBar value={Math.min(1, progress) * 100} size="xs" className="bg-black/50" />
            </span>
          )}
          {artCorner}
        </Poster>
      </div>
      {/* dir="auto": a Latin title in an RTL UI truncates at its own end, not its start. The title attribute shows a cut-off line in full. */}
      <span dir="auto" title={title} className="mt-2 block truncate text-match-parent text-sm font-medium text-fg">
        {title}
      </span>
      {subtitle && (
        <span dir="auto" title={subtitle} className="block truncate text-match-parent text-sm text-fg-muted">
          {subtitle}
        </span>
      )}
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
    <Link
      to={to ?? '#'}
      {...rail}
      aria-label={ariaLabel}
      className={cardRoot}
      onPointerEnter={opens ? intent.onPointerEnter : undefined}
      onPointerLeave={opens ? intent.onPointerLeave : undefined}
      onFocus={opens ? intent.onFocus : undefined}
      onBlur={opens ? intent.onBlur : undefined}
    >
      {body}
    </Link>
  );
}

/** Above the progress bar when there is one, else in the poster's bottom corner. */
const cornerOffset = (progress: number | undefined) => (progress !== undefined && progress > 0 ? 'bottom-5' : 'bottom-1.5');

/**
 * A play card (Continue watching) of a saved title: the VOD grid's saved marker on the poster's
 * corner and "In My List" in the card's name. A toggle there would sit inside the play button.
 */
function SavedMarkerCard({ itemRef, ...props }: PosterCardProps & { itemRef: ItemRef }) {
  const { t, i18n } = useTranslation('vod');
  const inList = useInMyList([itemRef]).has(itemKey(itemRef));
  if (!inList) return <PosterCardView {...props} />;
  return (
    <PosterCardView
      {...props}
      ariaLabel={joinList([props.ariaLabel ?? props.title, t('posterInMyList')], i18n.language)}
      artCorner={
        <span
          aria-hidden
          data-testid="mylist-saved-marker"
          className={cn(
            // Saved is a state, not an action: a small glass chip, so amber stays on the play action.
            'absolute end-1.5 inline-flex h-8 w-8 items-center justify-center rounded-full border border-glass-border bg-glass-strong text-on-glass shadow-1',
            cornerOffset(props.progress),
          )}
        >
          <BookmarkCheck aria-hidden size={17} strokeWidth={2.25} />
        </span>
      }
    />
  );
}

/**
 * A linked card with the My List toggle beside the link, not inside it (a button in a link is a
 * nested interactive control). Once the title is saved the toggle stays on show in the accent
 * colour, which is the card's saved marker.
 */
function MyListPosterCard(props: PosterCardProps & { myList: { itemRef: ItemRef; snapshot: ItemSnapshot } }) {
  const { rail, myList, progress } = props;
  return (
    <div className="group/poster relative min-w-0">
      <PosterCardView {...props} artClassName={WRAPPER_HOVER_ART} />
      {/* The artwork's box (2:3 at the card's width), so the toggle sits on the poster's corner. */}
      <div className={cn('pointer-events-none absolute inset-x-0 top-0 aspect-[2/3]', WRAPPER_HOVER_LAYER)}>
        {/* The rail is one Tab stop (roving tabindex): only the card holding it also offers its toggle. */}
        <MyListButton
          tabIndex={rail.tabIndex}
          variant="icon"
          itemRef={myList.itemRef}
          snapshot={myList.snapshot}
          className={cn(
            'pointer-events-auto absolute end-1.5 opacity-0 group-hover/poster:opacity-100 focus-visible:opacity-100 data-in-list:opacity-100 [@media(hover:none)]:opacity-100',
            'motion-safe:transition-[opacity,background-color,color,transform]',
            cornerOffset(progress),
          )}
        />
      </div>
    </div>
  );
}

/** A channel card asking for its menu (Run 2 C2): where to draw it, the channel, and the card's Play. */
export interface ChannelMenuRequest {
  pos: { x: number; y: number };
  channel: Channel;
  onPlay(): void;
}

/**
 * Opens the dashboard's channel menu. `ChannelMenuHost` (ChannelCardMenu.tsx) provides it; with no
 * provider, or no `channel` on the card, a channel card has no menu.
 */
export const ChannelMenuContext = createContext<((request: ChannelMenuRequest) => void) | null>(null);

/** Anchor for a menu opened from the keyboard: near the card's inline start, low on its artwork. */
function menuAnchor(el: HTMLElement): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  const rtl = getComputedStyle(el).direction === 'rtl';
  return { x: rtl ? r.right - 48 : r.left + 48, y: r.top + Math.min(r.height - 8, 96) };
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
  /**
   * Also name the source when the programme fills the second line (more than one source on
   * Home, where the same channel can come from two of them).
   */
  showSourceWithNow?: boolean;
  isRadio?: boolean;
  onPlay: () => void;
  ariaLabel?: string;
  /**
   * The channel behind the card. With it, right click, the context-menu key and Shift+F10 open the
   * channel menu (Play, Add to multi-view, Add to list, Rename, Hide, locks) where a host provides one.
   */
  channel?: Channel;
  /** The source the logo belongs to, for the image cache (C3). Defaults to `channel`'s source. */
  sourceId?: string;
}

/** 16:9 channel tile with the logo centered on a per-channel tint. */
export function ChannelCard({
  rail,
  name,
  logoUrl,
  now,
  nowProgress,
  sourceName,
  showSourceWithNow = false,
  isRadio,
  onPlay,
  ariaLabel,
  channel,
  sourceId,
}: ChannelCardProps) {
  const { t } = useTranslation('shell');
  const openMenu = useContext(ChannelMenuContext);
  const hue = hueOf(name);
  const menu = channel && openMenu ? (pos: { x: number; y: number }) => openMenu({ pos, channel, onPlay }) : undefined;
  const onContextMenu = menu
    ? (e: MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        // Focused, so closing the menu hands focus back to this card.
        e.currentTarget.focus({ preventScroll: true });
        // A keyboard-made contextmenu event (no keydown seen) has no pointer position.
        menu(e.clientX === 0 && e.clientY === 0 ? menuAnchor(e.currentTarget) : { x: e.clientX, y: e.clientY });
      }
    : undefined;
  const onKeyDown = menu
    ? (e: KeyboardEvent<HTMLButtonElement>) => {
        if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
        e.preventDefault();
        e.stopPropagation();
        menu(menuAnchor(e.currentTarget));
      }
    : undefined;
  return (
    <button type="button" {...rail} onClick={onPlay} onContextMenu={onContextMenu} onKeyDown={onKeyDown} aria-label={ariaLabel} className={cardRoot}>
      <div
        className={cn(CARD_ART, 'aspect-video w-full')}
        style={{ background: `radial-gradient(120% 90% at 30% 20%, hsl(${hue} 35% 30% / 0.55), transparent 70%), var(--color-surface-2)` }}
      >
        <Poster
          src={logoUrl}
          sourceId={sourceId ?? channel?.ref.sourceId}
          alt=""
          label={name}
          aspect="wide"
          fit="contain"
          kind={isRadio ? 'radio' : 'live'}
          className="bg-transparent after:hidden"
          rounded="sm"
        />
        <PlayGlyph />
        <span className="absolute top-2 start-2">
          {/*
            The still dot: a rail of channel cards ran one pulse animation per card, and any running
            animation keeps the browser compositing at the display's refresh rate (about 33 % of a
            core on the idle dashboard, L3-perf-desktop-1). The red pill already says live.
          */}
          <LivePill dot="still" />
        </span>
        {nowProgress !== undefined && (
          // Visual only: a button's content is presentational, and an unnamed progressbar fails axe.
          <span className="absolute inset-x-0 bottom-0" aria-hidden>
            <ProgressBar value={nowProgress * 100} size="xs" className="rounded-none bg-black/40" />
          </span>
        )}
      </div>
      <span dir="auto" title={name} className="mt-2 block truncate text-match-parent text-sm font-medium text-fg">
        {name}
      </span>
      {now && showSourceWithNow && sourceName ? (
        // Programme first; the source keeps up to half the line, so it never truncates away.
        <span className="flex min-w-0 items-baseline gap-1.5 text-sm text-fg-muted">
          <span dir="auto" title={now} className="min-w-0 truncate text-match-parent">
            {now}
          </span>
          <span aria-hidden className="shrink-0 text-fg-subtle">·</span>
          <span dir="auto" title={sourceName} className="max-w-[50%] shrink-0 truncate text-fg-subtle" data-testid="channel-card-source">
            {sourceName}
          </span>
        </span>
      ) : (
        <span dir="auto" title={now ?? sourceName} className="block truncate text-match-parent text-sm text-fg-muted">
          {now ?? sourceName ?? (isRadio ? t('radio') : t('liveTv'))}
        </span>
      )}
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
  // A running import or refresh shows its phase and share here and as a bar on the tile, as on
  // the Sources page: "Nothing imported yet" read like a failure while the first import ran.
  useImportProgressFeed();
  const progress = useSourceProgress(source.id);
  const importing = progress && isRunningPhase(progress.phase) ? progress : undefined;
  const fraction = importing ? progressFraction(importing) : undefined;
  const phaseLabel =
    importing && (importing.phase === 'fetching' || importing.phase === 'parsing' || importing.phase === 'saving')
      ? t(`importPhase_${importing.phase}`)
      : t('sourceCardImporting');
  const caption = importing
    ? joinList([phaseLabel, fraction !== undefined && new Intl.NumberFormat(intlLocale(i18n.language), { style: 'percent' }).format(fraction)], i18n.language)
    : joinList(counts, i18n.language) || t('emptySource');
  return (
    <Link to={sourceHomePath(source)} {...rail} className={cardRoot}>
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
        {importing && (
          // Visual only: the caption below carries the same phase and share for the link's name.
          <span className="absolute inset-x-0 bottom-0" aria-hidden data-testid="source-card-progress">
            <ProgressBar value={(fraction ?? 0) * 100} indeterminate={fraction === undefined} size="xs" tone="glass" className="rounded-none" />
          </span>
        )}
      </div>
      <span dir="auto" title={source.name} className="mt-2 block truncate text-match-parent text-sm font-medium text-fg">
        {source.name}
      </span>
      {/* A title alone is never read on a link; these join the card's name after the source name. */}
      <span className="sr-only" data-testid="source-card-kind">{`, ${KIND_NAMES[source.kind]}`}</span>
      {source.lastError && <span className="sr-only">{`, ${t('sourceHasError')}`}</span>}
      <span title={caption} className={cn('block truncate text-sm tabular', importing ? 'text-fg' : 'text-fg-muted')} data-testid="source-card-caption">
        {caption}
      </span>
    </Link>
  );
}
