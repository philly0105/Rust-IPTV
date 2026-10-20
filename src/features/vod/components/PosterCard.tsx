import { Bookmark, BookmarkCheck, BookmarkPlus, Check, Lock, Star } from 'lucide-react';
import { createContext, memo, useContext, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { itemKey, type ItemRef, type ItemSnapshot, type SeriesItem, type VodItem } from '@/api/types';
import { MyListButton, MyListButtonView } from '@/features/mylist/components/MyListButton';
import { useMyListState, type MyListStatus } from '@/features/mylist/hooks/useMyList';
import { useMyListToggle } from '@/features/mylist/hooks/useMyListToggle';

import { usePrefetchIntent, type PrefetchIntent, type PrefetchTarget } from '../hooks/prefetch';
import { formatRating } from '../lib/format';
import { languageName, type ItemLanguage } from '../lib/language';
import { joinList } from '@/shell/dashboard/cards';
import { CARD_ART, CARD_ART_CURSOR, CARD_ROOT, Poster, ProgressBar, Skeleton, cn } from '@/ui';
import { listSeparator } from '@/lib/intl';

export interface PosterCardProps {
  /** Caption; pass `titleBase` so a year already in `year`/`meta` is not shown twice. */
  title: string;
  /** Full title for the tooltip when the caption is shortened (defaults to `title`). */
  fullTitle?: string;
  href: string;
  posterUrl?: string;
  year?: number;
  rating?: number;
  /** 0..1 watched fraction; shows a thin bar over the poster when > 0 (not on a watched title, which shows its tick instead). */
  progress?: number;
  /** Watched as a whole (C4): a tick on the poster's top-end corner, with the rating beside it. */
  watched?: boolean | undefined;
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
  /**
   * The link's tab index under a roving tabindex (a rail's `rail.tabIndex`). When set, the card's
   * My List corner button leaves the Tab order too, so the host stays one Tab stop; the host binds S.
   */
  tabIndex?: number | undefined;
  /** Keyboard cursor of a listbox grid (aria-activedescendant) rests here. */
  active?: boolean;
  /**
   * False inside a listbox option (VirtualGrid): render a plain block instead
   * of a link, because an interactive element inside an option is
   * `nested-interactive`. The grid's onSelect/Enter does the navigation, and
   * the card text becomes the option's accessible name.
   */
  interactive?: boolean;
  /**
   * The title to save with the My List toggle (C3) on the poster's corner. On a linked card it is
   * a real button beside the link. Inside a listbox option (`interactive={false}`) a button would be
   * a nested interactive control, so there the corner holds a pointer-only toggle and a saved
   * marker, the option's name says "In My List", and the grid binds a key (S) for the keyboard.
   */
  myList?: { itemRef: ItemRef; snapshot: ItemSnapshot } | undefined;
  /**
   * The detail page this card opens, warmed when the pointer rests on the card or it takes
   * focus (C4). Its source also routes the poster through that source's image cache rules.
   */
  prefetch?: PrefetchTarget | undefined;
  /** Ready-made intent handlers (a TMDB rail's search link); used instead of `prefetch`. */
  intent?: PrefetchIntent | undefined;
  /** The source the artwork belongs to, when `prefetch` and `myList` do not name it. */
  sourceId?: string | undefined;
  /** Parental Ask mode: the title asks for the PIN before it opens (a lock on the poster, and in its name). */
  locked?: boolean | undefined;
}

/**
 * The art's hover state driven by the wrapper of a card that has a My List toggle beside its
 * link, so moving the pointer from the poster onto the toggle keeps the card lifted. The toggle
 * layer takes the same lift, so the two move together.
 */
const WRAPPER_HOVER_ART = 'group-hover/poster:shadow-2 group-hover/poster:ring-fg-subtle motion-safe:group-hover/poster:-translate-y-0.5';
const WRAPPER_HOVER_LAYER =
  'motion-safe:transition-[translate] motion-safe:duration-150 motion-safe:ease-out motion-safe:group-hover/poster:-translate-y-0.5 motion-safe:group-has-[a:active]/poster:translate-y-0';

/** The My List target for a catalog movie or series. */
export function myListTarget(item: VodItem | SeriesItem): { itemRef: ItemRef; snapshot: ItemSnapshot } {
  const snapshot: ItemSnapshot = { title: item.titleBase || item.title, contentType: item.ref.contentType };
  if (item.posterUrl) snapshot.posterUrl = item.posterUrl;
  if (item.year) snapshot.subtitle = String(item.year);
  return { itemRef: item.ref, snapshot };
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
  /** "Watched" when the title is watched as a whole. */
  watchedLabel?: string | undefined;
  /** "Locked" when the title asks for the PIN. */
  lockedLabel?: string | undefined;
  /** UI language, for the separator between the parts (", " in English). */
  language?: string | undefined;
}): string {
  const yearText = parts.year !== undefined ? String(parts.year) : undefined;
  const name = yearText && !parts.title.includes(yearText) ? `${parts.title} (${yearText})` : parts.title;
  const out = [name];
  const meta = typeof parts.meta === 'string' || typeof parts.meta === 'number' ? String(parts.meta).trim() : '';
  if (meta && !name.includes(meta)) out.push(meta);
  if (parts.languageLabel) out.push(parts.languageLabel);
  if (parts.badgeLabel) out.push(parts.badgeLabel);
  if (parts.rating) out.push(parts.ratedLabel(parts.rating));
  if (parts.watchedLabel) out.push(parts.watchedLabel);
  if (parts.progressLabel) out.push(parts.progressLabel);
  if (parts.lockedLabel) out.push(parts.lockedLabel);
  return out.join(listSeparator(parts.language));
}

/**
 * Poster tile used by grids and rails. The poster carries the identity; the
 * caption is quiet. Hover, focus, press and the grid's keyboard cursor are the
 * shared card states (src/ui/card.ts), drawn on the artwork only.
 */
export const PosterCard = memo(function PosterCard(props: PosterCardProps) {
  // A grid cell's My List corner needs the shared list; only those cards subscribe to it.
  if (props.myList && props.interactive === false) return <GridPosterCard {...props} myList={props.myList} />;
  return <PosterCardView {...props} />;
});

/** The strings and locale a card draws with: the `vod` and `mylist` namespaces. */
interface PosterText {
  t: TFunction;
  tm: TFunction;
  language: string;
}

/**
 * My List for every card of one grid: read once by the grid, instead of three list observers per
 * card (L2-vod-1). The grid's strings come with it: three `useTranslation` calls per card made
 * every mount copy the i18n instance three times, which a fast scroll paid for in GC pauses
 * (L3-perf-ui-3). Linked cards (search results, VD-1) read it too, for their corner button.
 */
interface GridMyList {
  keys: ReadonlySet<string>;
  status: MyListStatus;
  retry: () => Promise<boolean>;
  toggle: ReturnType<typeof useMyListToggle>;
  text: PosterText;
}

const GridMyListContext = createContext<GridMyList | null>(null);

/**
 * Wrap a poster grid in this so its cards share one subscription to My List. A grid card outside
 * it subscribes on its own (slower on a large grid, same behaviour).
 */
export function GridMyListProvider({ children }: { children: ReactNode }) {
  const { keys, status, retry } = useMyListState();
  const toggle = useMyListToggle();
  const text = usePosterText();
  const value = useMemo(() => ({ keys, status, retry, toggle, text }), [keys, status, retry, toggle, text]);
  return <GridMyListContext.Provider value={value}>{children}</GridMyListContext.Provider>;
}

/** {@link PosterText} for the current language (`t` keeps its identity until the language changes). */
function usePosterText(): PosterText {
  const { t, i18n } = useTranslation('vod');
  const { t: tm } = useTranslation('mylist');
  const language = i18n.language;
  return useMemo(() => ({ t, tm, language }), [t, tm, language]);
}

interface PosterCardViewProps extends PosterCardProps {
  /** Extra part of the accessible name (e.g. "In My List"). */
  extraLabel?: string | undefined;
  /** In My List: a small glass bookmark joins the chips on the top-end corner (the toggle itself shows on hover). */
  saved?: boolean | undefined;
  /** Drawn over the artwork's corner (the grid's My List toggle). */
  artCorner?: ReactNode;
  /** A grid's shared My List and strings, for a linked card's corner button. */
  list?: GridMyList | undefined;
}

/** A linked card: inside a GridMyListProvider it shares the grid's list and strings. */
function PosterCardView(props: PosterCardViewProps) {
  const shared = useContext(GridMyListContext);
  return shared ? <PosterCardBody {...props} list={shared} t={shared.text.t} locale={shared.text.language} /> : <PosterCardOwnText {...props} />;
}

/** A card that reads its own strings (rails): one `useTranslation` per card. */
function PosterCardOwnText(props: PosterCardViewProps) {
  const { t, i18n } = useTranslation('vod');
  return <PosterCardBody {...props} t={t} locale={i18n.language} />;
}

function PosterCardBody({
  title,
  fullTitle,
  href,
  posterUrl,
  year,
  rating,
  progress,
  watched,
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
  myList,
  prefetch,
  intent,
  sourceId,
  locked,
  extraLabel,
  saved: savedProp,
  artCorner,
  list,
  t,
  locale,
}: PosterCardViewProps & { t: TFunction; locale: string }) {
  // A linked card in a shared list knows whether its title is saved; a grid cell is told (GridPosterCardWith).
  const saved = savedProp ?? (!!myList && !!list && list.status === 'ready' && list.keys.has(itemKey(myList.itemRef)));
  const ownIntent = usePrefetchIntent(intent ? null : (prefetch ?? null));
  const { onPointerEnter, onPointerLeave, onFocus, onBlur } = intent ?? ownIntent;
  const artSourceId = sourceId ?? prefetch?.ref.sourceId ?? myList?.itemRef.sourceId;
  const r = formatRating(rating, locale);
  const langName = language ? languageName(language, locale, (g) => t(`languageGroup_${g}`)) : undefined;
  const hasProgress = showsProgress(progress, watched);
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
    watchedLabel: watched ? t('watched') : undefined,
    lockedLabel: locked ? t('locked') : undefined,
    language: locale,
  });
  const fullLabel = extraLabel ? `${label}${listSeparator(locale)}${extraLabel}` : label;
  const secondary = meta ?? year;
  const content = (
    <>
      <div className={cn(CARD_ART, interactive && myList && WRAPPER_HOVER_ART, active && CARD_ART_CURSOR)}>
        {/* The frame's ring is the edge; the poster's own hairline would double it. */}
        <Poster src={posterUrl} sourceId={artSourceId} alt="" label={title} aspect="poster" className="after:hidden" />
        {(badge || locked) && (
          <div aria-hidden className="pointer-events-none absolute start-1.5 top-1.5 flex min-w-0 max-w-[calc(100%-0.75rem)] gap-1">
            {locked && (
              // The lock Live's groups carry (CategorySidebar), on the glass every poster chip uses.
              <div
                data-testid="poster-locked"
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-glass-strong text-on-glass"
              >
                <Lock aria-hidden size={12} strokeWidth={2.5} />
              </div>
            )}
            {badge}
          </div>
        )}
        {(r || watched || saved) && (
          // The state chips share the top-end corner: rating, then saved, then watched. All glass and
          // small, so amber stays on progress and play (DS amber rules); the 36 px toggle is only for hover.
          <div aria-hidden className="pointer-events-none absolute end-1.5 top-1.5 flex items-center gap-1">
            {r && (
              <div aria-hidden className="tabular inline-flex items-center gap-1 rounded-sm bg-glass-strong px-1.5 py-1 text-xs leading-none font-semibold text-on-glass">
                {/* Glass chips stay dark in every theme, so the star takes the bright glass accent, not the light theme's deep one. */}
                <Star aria-hidden size={11} className="fill-current text-glass-accent" />
                {r}
              </div>
            )}
            {saved && (
              <div aria-hidden data-testid="poster-saved" className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-glass-strong text-on-glass shadow-1">
                <BookmarkCheck aria-hidden size={12} strokeWidth={2.5} />
              </div>
            )}
            {watched && (
              // Watched is a state, not an action: a glass chip with an on-glass tick, so amber stays on progress and play.
              <div aria-hidden data-testid="poster-watched" className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-glass-strong text-on-glass shadow-1">
                <Check aria-hidden size={13} strokeWidth={3} />
              </div>
            )}
          </div>
        )}
        {language && (
          <div
            aria-hidden
            className={cn(
              'pointer-events-none absolute start-1.5 rounded-sm bg-glass-strong px-1.5 py-1 text-xs leading-none font-semibold tracking-wide text-on-glass',
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
        {artCorner}
      </div>
      <div className="min-w-0 px-0.5">
        <div dir="auto" className="line-clamp-2 text-match-parent text-sm leading-snug font-medium text-fg">
          {title}
        </div>
        <div className="tabular truncate text-xs text-fg-subtle">
          {secondary !== undefined && secondary !== null && secondary !== ''
            ? langName
              ? typeof secondary === 'string' || typeof secondary === 'number'
                ? joinList([secondary, langName], locale)
                : <>{secondary}{listSeparator(locale)}{langName}</>
              : secondary
            : (langName ?? ' ')}
        </div>
      </div>
    </>
  );
  const classes = cn(CARD_ROOT, 'flex min-w-0 flex-col gap-2 rounded-md', className);
  if (!interactive) {
    return (
      // A named, non-interactive group: its label becomes the option's accessible name.
      // Focus stays on the listbox (aria-activedescendant), so only the pointer warms the page here.
      <div
        role="group"
        aria-label={fullLabel}
        data-grid-index={index}
        data-poster-card=""
        className={classes}
        title={fullTitle ?? title}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
      >
        {content}
      </div>
    );
  }
  const link = (
    <Link
      to={href}
      onClick={onClick}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      data-grid-index={index}
      tabIndex={tabIndex}
      // The focus ring is drawn on the artwork (group-focus-visible below), not around the caption.
      className={classes}
      title={fullTitle ?? title}
      aria-label={fullLabel}
    >
      {content}
    </Link>
  );
  if (!myList) return link;
  const cornerProps = {
    variant: 'icon',
    itemRef: myList.itemRef,
    snapshot: myList.snapshot,
    // Roving host (rail): the link is the card's only Tab stop; S toggles, and the corner shows while the link has focus.
    tabIndex: tabIndex !== undefined ? -1 : undefined,
    className: cn(
      // Shown on hover and on keyboard focus only (VL-poster-chips): the saved state is the small chip
      // on the top-end corner, and touch screens save from the title's page. Outside a shared list
      // the card cannot draw that chip, so there a saved title keeps its corner up.
      'pointer-events-auto absolute end-1.5 opacity-0 group-hover/poster:opacity-100 focus-visible:opacity-100 group-has-[a:focus-visible]/poster:opacity-100',
      !list && 'data-in-list:opacity-100',
      'motion-safe:transition-[opacity,background-color,color,transform]',
      hasProgress ? 'bottom-5' : 'bottom-1.5',
    ),
  } as const;
  return (
    <div className="group/poster relative min-w-0">
      {link}
      {/*
        A layer with the artwork's box (2:3 at the card's width), so the toggle sits on the poster's
        corner while staying beside the link, not inside it. It shows on hover, on keyboard focus, on
        touch screens, and always once the title is saved.
      */}
      <div className={cn('pointer-events-none absolute inset-x-0 top-0 aspect-[2/3]', WRAPPER_HOVER_LAYER)}>
        {list ? <MyListButtonView {...cornerProps} state={list} t={list.text.tm} /> : <MyListButton {...cornerProps} />}
      </div>
    </div>
  );
}

/**
 * A grid cell's card with My List (C3): the option's name says when the title is saved, a marker
 * stays on the poster once it is, and pointer users toggle it from the corner.
 */
function GridPosterCard(props: PosterCardProps & { myList: { itemRef: ItemRef; snapshot: ItemSnapshot } }) {
  const shared = useContext(GridMyListContext);
  return shared ? <GridPosterCardWith {...props} list={shared} /> : <GridPosterCardOwn {...props} />;
}

/** Outside a GridMyListProvider: the card reads My List and its strings itself. */
function GridPosterCardOwn(props: PosterCardProps & { myList: { itemRef: ItemRef; snapshot: ItemSnapshot } }) {
  const { keys, status, retry } = useMyListState();
  const toggle = useMyListToggle();
  const text = usePosterText();
  const list = useMemo(() => ({ keys, status, retry, toggle, text }), [keys, status, retry, toggle, text]);
  return <GridPosterCardWith {...props} list={list} />;
}

function GridPosterCardWith({ list, ...props }: PosterCardProps & { myList: { itemRef: ItemRef; snapshot: ItemSnapshot }; list: GridMyList }) {
  const { t, tm, language } = list.text;
  const { itemRef, snapshot } = props.myList;
  // Until the list is known nothing counts as saved (useInMyList's rule).
  const inList = list.status === 'ready' && list.keys.has(itemKey(itemRef));
  const hasProgress = showsProgress(props.progress, props.watched);
  return (
    <PosterCardBody
      {...props}
      t={t}
      locale={language}
      saved={inList}
      extraLabel={inList ? t('posterInMyList') : undefined}
      artCorner={
        <GridMyListToggle
          itemRef={itemRef}
          snapshot={snapshot}
          inList={inList}
          status={list.status}
          toggle={list.toggle}
          raised={hasProgress}
          shown={!!props.active}
          t={tm}
        />
      }
    />
  );
}

/**
 * The My List corner of a grid poster. It cannot be a button: it sits inside a listbox option,
 * where a focusable control is a nested interactive element. So it is a pointer-only target
 * (hidden from assistive technology, out of the tab order); the option's name carries the saved
 * state and the grid's S key toggles it from the keyboard. The click stays here: it does not
 * open the title.
 */
function GridMyListToggle({
  itemRef,
  snapshot,
  inList,
  status,
  toggle,
  raised,
  shown,
  t,
}: {
  itemRef: ItemRef;
  snapshot: ItemSnapshot;
  inList: boolean;
  status: MyListStatus;
  toggle: GridMyList['toggle'];
  /** Above the progress bar. */
  raised: boolean;
  /** The grid's keyboard cursor rests on this card: show the toggle (S acts on it). */
  shown: boolean;
  /** The `mylist` namespace. */
  t: TFunction;
}) {
  const [pending, setPending] = useState(false);
  // Like MyListButton: until the shared list is known the corner is busy, neither pressed nor saved.
  const ready = status === 'ready';
  const loading = status === 'loading';
  const saved = ready && inList;
  const Icon = loading ? Bookmark : saved ? BookmarkCheck : BookmarkPlus;
  const onClick = (e: MouseEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (pending || loading) return;
    setPending(true);
    void toggle(itemRef, snapshot).finally(() => setPending(false));
  };
  return (
    <span
      aria-hidden
      aria-pressed={ready ? saved : undefined}
      aria-busy={pending || loading || undefined}
      title={loading ? t('checkingHint') : saved ? t('removeHint') : t('addHint')}
      onClick={onClick}
      data-testid="mylist-grid-toggle"
      data-state={status}
      data-in-list={saved || undefined}
      className={cn(
        'absolute end-1.5 inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border shadow-1',
        'motion-safe:transition-[opacity,background-color,color,transform] motion-safe:duration-150 motion-safe:active:scale-95',
        // C5: blur only while the corner is up on one card (hover, or the keyboard cursor).
        // Up on hover or under the keyboard cursor only; the saved state stays visible as the chip on
        // the top-end corner. Touch screens save from the poster's menu (long press) or the title's page.
        'opacity-0 group-hover/card:opacity-100',
        saved
          ? 'border-glass-border bg-glass-strong text-on-glass hover:bg-glass'
          : cn('border-glass-border bg-glass text-on-glass group-hover/card:glass-blur hover:bg-glass-strong', shown && 'glass-blur'),
        shown && 'opacity-100',
        (pending || loading) && 'cursor-progress',
        raised ? 'bottom-5' : 'bottom-1.5',
      )}
    >
      <Icon aria-hidden size={17} strokeWidth={2.25} className={cn(loading && 'motion-safe:animate-pulse')} />
    </span>
  );
}

/** A saved position draws the bar, unless the title is watched: its tick says that, and a part-filled bar would contradict it. */
function showsProgress(progress: number | undefined, watched: boolean | undefined): progress is number {
  return !watched && progress !== undefined && Number.isFinite(progress) && progress > 0;
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
