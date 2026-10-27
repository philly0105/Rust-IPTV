import type { TFunction } from 'i18next';
import { BookmarkCheck, EllipsisVertical, Play, Search } from 'lucide-react';
import { createContext, useContext, useMemo, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';

import { itemKey, type Channel, type ContentType, type ItemRef, type ItemSnapshot, type Source, type SourceKind } from '@/api/types';
import { MyListButton, canSave, useInMyList, useMyListState, useMyListToggle } from '@/features/mylist';
import { MyListButtonView, type MyListButtonProps, type MyListButtonState } from '@/features/mylist/components/MyListButton';
import { isRunningPhase, progressFraction, useImportProgressFeed, useSourceProgress } from '@/features/sources/lib/progress';
import { usePrefetchIntent, type PrefetchTarget } from '@/features/vod/hooks/prefetch';
import { intlLocale, listSeparator } from '@/lib/intl';
import { CARD_ART, CARD_ROOT, MetaLine, Poster, PosterWidthContext, ProgressBar, QUARTER_BLUR, TINT_THEME, Tooltip, cn, initialsOf, tintOf, tintVars, useImageChain, withAlpha } from '@/ui';

import type { RailCardProps } from './DashboardRail';
import { sourceHomePath } from '../railLinks';
import { kindShortKey } from '../sourceKind';

/** The focusable card; its focus ring, hover lift and press are drawn on the artwork (CARD_ART). */
const cardRoot = cn(CARD_ROOT, 'block w-full rounded-md text-start');

/**
 * A letter or a digit in any script. Tried after the ASCII class (P2-HOME-6): the Unicode property
 * test was 3 ms of a cold Home at a 4x slowdown, for its two or three parts per card, and nearly
 * every part (a Latin title, a year, a count) has an ASCII letter or digit.
 */
const ASCII_WORD = /[A-Za-z0-9]/;
const ANY_WORD = /[\p{L}\p{N}]/u;

/** First-strong isolate (U+2068 ... U+2069): a part's own script sets its direction. */
const isolate = (part: string) => (ASCII_WORD.test(part) || ANY_WORD.test(part) ? `\u2068${part}\u2069` : part);

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

/**
 * The one caption of every Home card (and the rail skeleton, DashboardRail): the title in
 * body-sm medium, one line of metadata in caption size. Two specs used to drift apart between
 * Home and the VOD rails.
 */
export const CAPTION_TITLE = 'mt-2 block truncate text-match-parent text-body-sm font-medium text-fg';
export const CAPTION_META = 'block truncate text-match-parent text-caption text-fg-muted';

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

/** A search card's hover and focus mark: a glass disc with a magnifier and what it does, not the amber play disc. */
function SearchGlyph({ label }: { label: string }) {
  return (
    <span
      aria-hidden
      className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-scrim/0 px-3 text-center opacity-0 group-hover/card:bg-scrim/60 group-hover/card:opacity-100 group-focus-visible/card:bg-scrim/60 group-focus-visible/card:opacity-100 motion-safe:transition-opacity"
    >
      <span className="flex size-12 items-center justify-center rounded-full border border-glass-border bg-glass-strong text-on-glass shadow-2">
        <Search size={20} />
      </span>
      <span className="text-caption font-medium text-on-glass">{label}</span>
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
  /**
   * The card opens a search, not a title (TMDB trending, SH-trending-dead-end): on hover and
   * focus the artwork shows a search glyph and this text instead of the play disc.
   */
  search?: string;
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
  search,
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
          {search && <SearchGlyph label={search} />}
          {badge && <span className="absolute top-2 start-2">{badge}</span>}
          {progress !== undefined && progress > 0 && (
            <span className="absolute inset-x-2 bottom-2">
              <ProgressBar value={Math.min(1, progress) * 100} size="xs" tone="glass" />
            </span>
          )}
          {artCorner}
        </Poster>
      </div>
      {/* dir="auto": a Latin title in an RTL UI truncates at its own end, not its start. The title attribute shows a cut-off line in full. */}
      <span dir="auto" title={title} className={CAPTION_TITLE}>
        {title}
      </span>
      {subtitle && (
        <span dir="auto" title={subtitle} className={CAPTION_META}>
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

/** The shared My List of a Home rail's poster corners, with the `mylist` strings. */
interface RailMyList {
  state: MyListButtonState;
  t: TFunction;
}

const RailMyListContext = createContext<RailMyList | null>(null);

/**
 * My List for every poster corner of one Home rail (P2-HOME-4): read once by the rail, instead of
 * two list observers, a toggle and three `useTranslation` calls per card (72 of those on a cold
 * Home's new arrivals rail alone). A card outside it reads the list on its own (same behaviour).
 */
export function RailMyListProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation('mylist');
  const { keys, status, retry } = useMyListState();
  const toggle = useMyListToggle();
  const value = useMemo(() => ({ state: { keys, status, retry, toggle }, t }), [keys, status, retry, toggle, t]);
  return <RailMyListContext.Provider value={value}>{children}</RailMyListContext.Provider>;
}

/** A poster corner's toggle: on the rail's shared list when there is one. Only it re-renders when the list changes. */
function CornerMyListButton(props: MyListButtonProps) {
  const shared = useContext(RailMyListContext);
  return shared ? <MyListButtonView {...props} state={shared.state} t={shared.t} /> : <MyListButton {...props} />;
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
        <CornerMyListButton
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

/**
 * Anchor for a menu a "more" button opens: just under the button, from its inline start (the
 * menu grows toward the inline end and keeps inside the window).
 */
export function buttonMenuAnchor(el: HTMLElement): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  const rtl = getComputedStyle(el).direction === 'rtl';
  return { x: rtl ? r.right : r.left, y: r.bottom + 4 };
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
  /**
   * The page a live channel opens once the card (or its menu's Play) has started it, whose stage
   * takes the player: the channel's Live TV (`itemPath`), or for a list's rail the list's page,
   * where zapping walks the list (the pages the mini player's Expand opens). Without it the
   * channel plays in the mini player over the page.
   */
  watchPath?: string;
}

/**
 * Windows' default double-click time: long enough for the second click of a double click, short
 * enough not to eat a deliberate click on the page that opened.
 */
const FOLLOW_UP_CLICK_MS = 500;

/**
 * Drops the rest of a double click on a card that opened another page. The new page is drawn
 * under the pointer before the second click lands, which would otherwise press whatever sits there
 * on Live TV (a group, or another channel's row). Capture on the window runs before React's own
 * listeners.
 */
function swallowFollowUpClicks(): void {
  const swallow = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
    window.removeEventListener(e.type, swallow, true);
  };
  window.addEventListener('click', swallow, true);
  window.addEventListener('dblclick', swallow, true);
  window.setTimeout(() => {
    window.removeEventListener('click', swallow, true);
    window.removeEventListener('dblclick', swallow, true);
  }, FOLLOW_UP_CLICK_MS);
}

/**
 * What a live channel's card (and its menu's Play) does with a page to open (`path`): play the
 * channel and open that page, whose stage takes the player, so one press gives a big picture with
 * the channel list and the guide ribbon for zapping. The page opens at once, so the player starts
 * in the stage instead of flashing up in the mini player first. Without a path, and for a radio
 * station, the channel plays in the mini player over Home. Nothing opens for a source Home does
 * not list (SourceKindContext holds the same sources Home's play looks the channel up in): that
 * play only says the source is gone, and the page would show the source's error.
 */
function useWatchChannel(onPlay: () => void, channel: Channel | undefined, path: string | undefined): () => void {
  const navigate = useNavigate();
  const kinds = useContext(SourceKindContext);
  const ref = channel?.ref;
  return () => {
    onPlay();
    if (!path || ref?.contentType !== 'live' || !kinds?.has(ref.sourceId)) return;
    void navigate(path);
    swallowFollowUpClicks();
  };
}

/** Right click, the context-menu key and Shift+F10 on a card, as one pair of handlers (`open` gets where to draw the menu). */
function menuHandlers<E extends HTMLElement>(open: ((pos: { x: number; y: number }) => void) | undefined) {
  if (!open) return {};
  return {
    onContextMenu: (e: MouseEvent<E>) => {
      e.preventDefault();
      // Focused, so closing the menu hands focus back to this card.
      e.currentTarget.focus({ preventScroll: true });
      // A keyboard-made contextmenu event (no keydown seen) has no pointer position.
      open(e.clientX === 0 && e.clientY === 0 ? menuAnchor(e.currentTarget) : { x: e.clientX, y: e.clientY });
    },
    onKeyDown: (e: KeyboardEvent<E>) => {
      if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
      e.preventDefault();
      e.stopPropagation();
      open(menuAnchor(e.currentTarget));
    },
  };
}

/**
 * Poster's initials tile, drawn as a logo-sized mark in the middle of the frame instead of across
 * all of it. A channel with no logo, or one whose logo fails, then looks like a channel with one:
 * a small mark on the channel's glow. Filled edge to edge, every logo-less card was a saturated block, and a
 * rail of them (a provider without logos fills Home with them) read as a wall of colour.
 */
const LOGO_MARK = cn(
  // Sized by the card's height, not fixed: a 4rem mark filled two thirds of a phone card and crowded
  // its progress bar, while 46% keeps the room it has on a desktop card at every size.
  '[&>[data-poster-fallback]]:m-auto [&>[data-poster-fallback]]:h-[46%] [&>[data-poster-fallback]]:w-auto [&>[data-poster-fallback]]:aspect-square',
  '[&>[data-poster-fallback]]:rounded-[22%]',
  '[&>[data-poster-fallback]]:shadow-1 [&>[data-poster-fallback]]:ring-1 [&>[data-poster-fallback]]:ring-white/10 [&>[data-poster-fallback]]:ring-inset',
);

/**
 * The channel's glow over `surface-2`, in the channel's tint (src/ui/tint.ts), the colour its mark
 * has here and its monogram has in Live TV. The dark themes take the tint's deep top stop
 * (`--logo-glow-dark`); the light theme its pale one (`--logo-glow-light`), because the deep tint
 * showed on a pale card as a grey smudge in its corner.
 */
const LOGO_GLOW = cn(
  'absolute inset-0 bg-surface-2',
  'bg-[radial-gradient(120%_90%_at_30%_20%,var(--logo-glow-dark),transparent_70%)]',
  'light:bg-[radial-gradient(120%_90%_at_30%_20%,var(--logo-glow-light),transparent_70%)]',
);

/** The custom properties {@link LOGO_GLOW} reads for a channel. */
function logoGlowVars(name: string): CSSProperties {
  const tint = tintOf(name);
  return { '--logo-glow-dark': withAlpha(tint.dark[0], 0.55), '--logo-glow-light': withAlpha(tint.light[1], 0.6) } as CSSProperties;
}

/** A channel logo centred on the channel's own tint: the art of a channel with no programme picture. */
function LogoArt({ name, logoUrl, sourceId, isRadio }: { name: string; logoUrl?: string; sourceId?: string; isRadio?: boolean }) {
  return (
    <div className={LOGO_GLOW} style={logoGlowVars(name)}>
      <Poster
        src={logoUrl}
        sourceId={sourceId}
        alt=""
        label={name}
        aspect="wide"
        fit="contain"
        kind={isRadio ? 'radio' : 'live'}
        className={cn('h-full bg-transparent after:hidden', LOGO_MARK)}
        rounded="sm"
      />
    </div>
  );
}

/**
 * A thin bar flush with the artwork's bottom edge: watched share, or how far the programme on air
 * has run. `glass` (the default) is the bright dial amber on the dark glass track, for the user's
 * own resume progress. A programme's progress is quiet: a neutral fill, on glass over a programme
 * picture (`glass-quiet`) and on the theme's track over a channel's logo card (`quiet`). Four or
 * five channel rails put about twenty amber bars on one screen, which read as stripes (Live TV's
 * list keeps them quiet for the same reason) and left amber meaning nothing in particular.
 * `accent` is resume progress over a title with no artwork: the theme's amber on the theme's
 * track, since the initials tile under it is pale in the light theme and a dark glass track drew
 * a black line along its foot.
 */
function EdgeProgress({ value, tone = 'glass' }: { value: number; tone?: 'glass' | 'glass-quiet' | 'quiet' | 'accent' }) {
  return (
    // Visual only: a button's content is presentational, and an unnamed progressbar fails axe.
    <span className="absolute inset-x-0 bottom-0" aria-hidden>
      <ProgressBar value={Math.min(1, value) * 100} size="xs" tone={tone} className="h-1 rounded-none [&>div]:rounded-none" />
    </span>
  );
}

/**
 * 16:9 channel tile with the logo centered on a per-channel tint. No LIVE pill: a channel tile
 * is live by definition, and a dozen identical red pills drowned out the programme and its
 * progress bar (SH-live-pill-noise); the quiet bar along the bottom is the live cue.
 */
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
  watchPath,
}: ChannelCardProps) {
  const { t } = useTranslation('shell');
  const openMenu = useContext(ChannelMenuContext);
  const watch = useWatchChannel(onPlay, channel, watchPath);
  const menu = channel && openMenu ? (pos: { x: number; y: number }) => openMenu({ pos, channel, onPlay: watch }) : undefined;
  return (
    <button type="button" {...rail} onClick={watch} {...menuHandlers<HTMLButtonElement>(menu)} aria-label={ariaLabel} className={cardRoot}>
      <div className={cn(CARD_ART, 'aspect-video w-full')}>
        <LogoArt name={name} logoUrl={logoUrl} sourceId={sourceId ?? channel?.ref.sourceId} isRadio={isRadio} />
        <PlayGlyph />
        {nowProgress !== undefined && <EdgeProgress value={nowProgress} tone="quiet" />}
      </div>
      <span dir="auto" title={name} className={CAPTION_TITLE}>
        {name}
      </span>
      {now && showSourceWithNow && sourceName ? (
        // Programme first; the source keeps up to half the line, so it never truncates away.
        <span className="flex min-w-0 items-baseline gap-1.5 text-caption text-fg-muted">
          <span dir="auto" title={now} className="min-w-0 truncate text-match-parent">
            {now}
          </span>
          <span aria-hidden className="shrink-0 text-fg-subtle">·</span>
          <span dir="auto" title={sourceName} className="max-w-[50%] shrink-0 truncate text-fg-subtle" data-testid="channel-card-source">
            {sourceName}
          </span>
        </span>
      ) : (
        <span dir="auto" title={now ?? sourceName} className={CAPTION_META}>
          {now ?? sourceName ?? (isRadio ? t('radio') : t('liveTv'))}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Wide (16:9) cards: Continue watching and On now.

/** A card asking for a menu of plain actions (Continue watching): where to draw it, its name and its items. */
export interface CardMenuRequest {
  pos: { x: number; y: number };
  label: string;
  items: CardMenuItem[];
  /** Called once the menu closes (an item ran, Escape, a click elsewhere, another menu opened). */
  onClose?(): void;
}

export interface CardMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect(): void;
}

/** Opens a card's action menu. `ChannelMenuHost` provides it; without it a card has no menu. */
export const CardMenuContext = createContext<((request: CardMenuRequest) => void) | null>(null);

/**
 * 16:9 artwork for a title that may only have a poster: the backdrop when there is one; else
 * the poster stands upright at the inline start over a soft field made from its own colours,
 * the cheap quarter-size blur (C5), so a resume rail of posters still reads as one row of
 * stills. With neither, the title's initials tile, as its poster card shows it elsewhere: a bare
 * tint left a blank frame that only the caption named.
 */
function WideArt({ title, backdropUrl, posterUrl, sourceId }: { title: string; backdropUrl?: string; posterUrl?: string; sourceId?: string }) {
  const railWidth = useContext(PosterWidthContext);
  // The upright poster is the frame's height at 2:3: 3/8 of the card's width.
  const posterWidth = railWidth ? Math.round((railWidth * 3) / 8) : undefined;
  const field = useImageChain([backdropUrl ? undefined : posterUrl], sourceId, posterWidth);
  if (backdropUrl || !posterUrl) {
    return <Poster src={backdropUrl} fallbackSrc={posterUrl} sourceId={sourceId} alt="" label={title} aspect="wide" className="h-full after:hidden" rounded="sm" />;
  }
  const tint = tintOf(title);
  return (
    <div aria-hidden className="absolute inset-0 overflow-hidden" style={{ background: `linear-gradient(160deg, ${tint.dark[1]}, ${tint.deep})` }}>
      {field.url && (
        <img src={field.url} alt="" loading="lazy" decoding="async" draggable={false} referrerPolicy="no-referrer" onError={field.onError} className={cn(QUARTER_BLUR, 'opacity-70 saturate-150')} />
      )}
      <span className="absolute inset-0 bg-gradient-to-r from-black/45 to-transparent rtl:bg-gradient-to-l" />
      {posterUrl && (
        <Poster
          src={posterUrl}
          sourceId={sourceId}
          width={posterWidth}
          alt=""
          label={title}
          aspect="poster"
          className="absolute inset-y-0 start-0 h-full w-auto shadow-2"
          rounded="sm"
        />
      )}
    </div>
  );
}

/**
 * The visible "more" button of a wide card, beside the card's own button (a button inside a
 * button is a nested control). It shows on hover and on the focused card, and always on touch
 * screens, where there is no hover and no reliable long press.
 */
function CardMenuButton({ label, tabIndex, onOpen }: { label: string; tabIndex: number; onOpen: (anchor: HTMLElement) => void }) {
  return (
    <Tooltip content={label} side="top" describe={false}>
      <button
        type="button"
        tabIndex={tabIndex}
        aria-label={label}
        aria-haspopup="menu"
        onClick={(e) => onOpen(e.currentTarget)}
        data-card-menu=""
        className={cn(
          'absolute top-1.5 end-1.5 z-[1] inline-flex size-8 items-center justify-center rounded-full border border-glass-border bg-glass-strong text-on-glass shadow-1',
          'opacity-0 group-hover/wide:opacity-100 group-focus-within/wide:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
          'hover:bg-glass active:scale-95 motion-safe:transition-[opacity,transform] motion-safe:duration-(--duration-fast)',
        )}
      >
        <EllipsisVertical aria-hidden size={16} />
      </button>
    </Tooltip>
  );
}

/**
 * "S2 E4 · Calm Before" as its code and its title. A line without the separator is a title
 * alone, unless it is only a code ("S2 E4"). Exported for tests.
 */
export function splitEpisodeLine(line: string | undefined): [code: string | undefined, title: string | undefined] {
  if (!line) return [undefined, undefined];
  const at = line.indexOf(' · ');
  if (at >= 0) return [line.slice(0, at).trim() || undefined, line.slice(at + 3).trim() || undefined];
  return /^S\d+\s*E\d+$/i.test(line.trim()) ? [line.trim(), undefined] : [undefined, line];
}

export interface ContinueCardProps {
  rail: RailCardProps;
  title: string;
  /** The episode line of a series ("S2 E4 · Calm Before"); it moves off the artwork into the caption. */
  episode?: string;
  /** "16 minutes left". */
  left?: string;
  progress?: number;
  posterUrl?: string;
  backdropUrl?: string;
  sourceId?: string;
  ariaLabel: string;
  onPlay(): void;
  /** Go to details, Mark watched, Remove (CB-CONTINUE-MENU). */
  menu: CardMenuItem[];
  /** Shown on the art's corner when the title is in My List. */
  saved?: boolean;
}

/**
 * Continue watching as 16:9 stills (Netflix, Apple TV Up Next, Plex): the episode is what
 * matters when resuming, and it sets resume apart from the poster rails. The watched share is
 * a bar flush with the bottom edge; the episode and the time left are the caption.
 */
export function ContinueCard({ rail, title, episode, left, progress, posterUrl, backdropUrl, sourceId, ariaLabel, onPlay, menu, saved }: ContinueCardProps) {
  const { t } = useTranslation('shell');
  const openMenu = useContext(CardMenuContext);
  const open = openMenu ? (pos: { x: number; y: number }) => openMenu({ pos, label: title, items: menu }) : undefined;
  const [episodeCode, episodeTitle] = splitEpisodeLine(episode);
  return (
    <div className="group/wide relative min-w-0">
      <button type="button" {...rail} onClick={onPlay} {...menuHandlers<HTMLButtonElement>(open)} aria-label={ariaLabel} className={cardRoot}>
        <div className={cn(CARD_ART, 'aspect-video w-full bg-surface-2')}>
          <WideArt title={title} backdropUrl={backdropUrl} posterUrl={posterUrl} sourceId={sourceId} />
          <PlayGlyph />
          {saved && (
            <span
              aria-hidden
              data-testid="mylist-saved-marker"
              className="absolute bottom-2.5 end-1.5 inline-flex size-7 items-center justify-center rounded-full border border-glass-border bg-glass-strong text-on-glass shadow-1"
            >
              <BookmarkCheck aria-hidden size={14} strokeWidth={2.25} />
            </span>
          )}
          {progress !== undefined && progress > 0 && <EdgeProgress value={progress} tone={backdropUrl || posterUrl ? 'glass' : 'accent'} />}
        </div>
        <span dir="auto" title={title} className={CAPTION_TITLE}>
          {title}
        </span>
        {(episode || left) && (
          // One line, every separator MetaLine's drawn dot: the episode line's own "·" (the snapshot
          // subtitle, "S2 E4 · Calm Before") is split into its code and its title. Only the
          // episode title gives way, so the code and the time left always show whole.
          <MetaLine
            as="span"
            className="flex-nowrap whitespace-nowrap [&>span]:shrink-0 [&>span:has(>[data-shrink])]:shrink"
            items={[
              episodeCode,
              episodeTitle && (
                <span data-shrink="" dir="auto" title={episodeTitle} className="block truncate text-match-parent">
                  {episodeTitle}
                </span>
              ),
              left && (
                <span data-shrink={episode ? undefined : ''} className={cn('tabular', !episode && 'block truncate')}>
                  {left}
                </span>
              ),
            ]}
          />
        )}
      </button>
      {open && <CardMenuButton label={t('moreActionsFor', { title })} tabIndex={rail.tabIndex} onOpen={(el) => open(buttonMenuAnchor(el))} />}
    </div>
  );
}

export interface OnNowCardProps {
  rail: RailCardProps;
  /** The programme on air. */
  programme: string;
  /** The programme's own picture (XMLTV icon), when the guide has one. */
  programmeArt?: string;
  channelName: string;
  logoUrl?: string;
  /** "12 minutes left". */
  left?: string;
  progress?: number;
  sourceId: string;
  isRadio?: boolean;
  ariaLabel: string;
  onPlay(): void;
  channel?: Channel;
}

/**
 * What is on air now, as a wall of art (CB-PROGRAM-ART, Channels DVR "On Now"): the
 * programme's own picture through the image cache, or the channel logo on its tint, the
 * programme title and the channel under it, and how far it has run along the bottom edge.
 */
export function OnNowCard({ rail, programme, programmeArt, channelName, logoUrl, left, progress, sourceId, isRadio, ariaLabel, onPlay, channel }: OnNowCardProps) {
  const openMenu = useContext(ChannelMenuContext);
  // On now is only ever Home's own rail, so its cards open the channel's Live TV. Played in the mini
  // player over Home, the pressed card left On now (its channel joins Recently watched) and the
  // rail shifted under the pointer.
  const watch = useWatchChannel(onPlay, channel, channel && itemPath(channel.ref));
  const menu = channel && openMenu ? (pos: { x: number; y: number }) => openMenu({ pos, channel, onPlay: watch }) : undefined;
  return (
    <button type="button" {...rail} onClick={watch} {...menuHandlers<HTMLButtonElement>(menu)} aria-label={ariaLabel} className={cardRoot} data-on-now="">
      <div className={cn(CARD_ART, 'aspect-video w-full bg-surface-2')}>
        {programmeArt ? (
          <>
            <Poster src={programmeArt} sourceId={sourceId} alt="" label={programme} aspect="wide" className="h-full after:hidden" rounded="sm" />
            {/* The channel stays recognisable on the programme's picture: its logo on a glass chip. */}
            {logoUrl && (
              <span aria-hidden className="absolute top-2 start-2 flex h-7 w-11 items-center justify-center rounded-sm border border-glass-border bg-glass-strong p-1">
                <Poster src={logoUrl} sourceId={sourceId} width={44} alt="" label={channelName} aspect="wide" fit="contain" kind="live" className="h-full bg-transparent after:hidden [&_img]:p-0" rounded="sm" />
              </span>
            )}
          </>
        ) : (
          <LogoArt name={channelName} logoUrl={logoUrl} sourceId={sourceId} isRadio={isRadio} />
        )}
        <PlayGlyph />
        {progress !== undefined && <EdgeProgress value={progress} tone={programmeArt ? 'glass-quiet' : 'quiet'} />}
      </div>
      <span dir="auto" title={programme} className={CAPTION_TITLE}>
        {programme}
      </span>
      <span className="flex min-w-0 items-baseline gap-1.5 text-caption text-fg-muted">
        <span dir="auto" title={channelName} className="min-w-0 truncate text-match-parent">
          {channelName}
        </span>
        {left && (
          <>
            <span aria-hidden className="shrink-0 text-fg-subtle">·</span>
            <span className="shrink-0 tabular">{left}</span>
          </>
        )}
      </span>
    </button>
  );
}

/** Source tile: monogram, name, kind, and catalog counts. */
export function SourceCard({ rail, source }: { rail: RailCardProps; source: Source }) {
  const { t, i18n } = useTranslation('shell');
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
        // The source's tint, pale in the light theme, as its monogram in the rail.
        className={cn(CARD_ART, TINT_THEME, 'flex aspect-video w-full flex-col justify-between p-4')}
        style={tintVars(source.name)}
      >
        {/* Decorative: the link's name reads the source name first, then its kind (sr-only below). */}
        <span aria-hidden className="font-display text-4xl font-semibold">{initialsOf(source.name)}</span>
        <span aria-hidden className="self-start rounded-sm bg-black/35 px-1.5 py-0.5 text-xs font-semibold text-white light:bg-white/70 light:text-fg">
          {t(kindShortKey(source.kind))}
        </span>
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
      <span dir="auto" title={source.name} className={CAPTION_TITLE}>
        {source.name}
      </span>
      {/* A title alone is never read on a link; these join the card's name after the source name. */}
      <span className="sr-only" data-testid="source-card-kind">{`, ${t(kindShortKey(source.kind))}`}</span>
      {source.lastError && <span className="sr-only">{`, ${t('sourceHasError')}`}</span>}
      <span title={caption} className={cn('block truncate text-caption tabular', importing ? 'text-fg' : 'text-fg-muted')} data-testid="source-card-caption">
        {caption}
      </span>
    </Link>
  );
}
