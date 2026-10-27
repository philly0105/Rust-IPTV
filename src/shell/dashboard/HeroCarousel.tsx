/**
 * The dashboard hero: a rotating carousel of continue-watching entries and new
 * arrivals over their backdrops (docs/architecture/appearance.md).
 *
 * Pattern: the WAI-ARIA "auto-rotating carousel with tabs for slide control".
 * A small on-screen-display pill holds the rotation toggle, previous/next and
 * one dial tick per slide (a tablist: arrows move and choose, Home/End jump):
 * beside the button row from lg up, in the top corner below it. On a phone
 * there is no pill: the toggle and the ticks are a plain row centred under the
 * buttons, and previous/next go (a sideways swipe turns the slide). On a touch
 * screen the toggle and the ticks grow to 44 px targets; the drawn dots stay
 * small. Rotation pauses while the pointer is over the hero or focus is inside it, while the
 * window is hidden, unfocused or the hero is scrolled away, and never starts
 * under prefers-reduced-motion. It also rests after
 * HERO_IDLE_ROUNDS full rounds without any pointer, key or wheel input in the
 * window (nobody is watching), and the next input resumes it.
 *
 * The active tick fills over the dwell time and freezes with the timer, so it
 * always shows how long is left. The fill is a transform that a timer sets a
 * few times a second (DIAL_TICK_MS), not a CSS animation: a running animation,
 * even a tiny one on the compositor, makes the browser produce a frame at the
 * display's refresh rate, and on a 240 Hz screen that kept an idle dashboard
 * at 38 % of a core (L3-perf-desktop-1). The tick's grow from dot to bar
 * animates width, which lays out and repaints on the main thread every frame,
 * so it plays only when the user changes slides: an automatic turn swaps the
 * ticks at once (idle Home 3.2% -> 0.8% main-thread time, L2 XB2-22).
 *
 * The hero runs edge to edge under the header (the cinematic full-bleed hero):
 * the artwork fills the frame, and two glass gradients, from the bottom and from
 * the inline start, keep the copy readable on any picture in every theme; a
 * slide with no artwork gets a per-title tint instead, with the title's initials tile upright at
 * the inline end from lg up (where a poster would stand). Gradients only, no blur
 * over the picture and no backdrop filter (C5), so nothing re-samples the page
 * while the hero is on screen. A slide that has only a poster shows it upright
 * at the inline end over a soft field made from its own colours (the cheap
 * quarter-size blur). Artwork loads through the image cache; the visible slide's pictures
 * load at high priority, and the next slide's backdrop is mounted (and so
 * fetched at low priority) once the main thread is idle. Every slide body is laid into one grid cell, so the
 * hero keeps the height of its tallest slide and nothing below it moves when
 * the rotation turns.
 */

import { ChevronLeft, ChevronRight, EllipsisVertical, Info, Pause, Play, Star } from 'lucide-react';
import { memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useRpcQuery } from '@/api/query';
import type { ItemRef } from '@/api/types';
import { usePrefetchIntent } from '@/features/vod/hooks/prefetch';
import { MetaLine, Poster, ProgressBar, QUARTER_BLUR, TOUCH_TARGET, Tooltip, cn, tintOf, useImageChain, whenIdle } from '@/ui';
import { intlLocale, numberFormat } from '@/lib/intl';

import { useReducedMotion } from '../theme';
import { buttonMenuAnchor, CardMenuContext, itemPath, usePrefetchTarget, type CardMenuItem } from './cards';
import { HERO_BODY, HERO_FRAME, HERO_PAGE_FADE } from './HeroSkeleton';
import { HERO_DWELL_MS, titleEndsWithYear, wrapIndex, type HeroSlide } from './heroSlides';

export interface HeroCarouselProps {
  slides: readonly HeroSlide[];
  /** Display name of a slide's source, for "New in …". */
  sourceName: (sourceId: string) => string | undefined;
  /** The source still exists, so the slide can play. */
  canPlay: (ref: ItemRef) => boolean;
  onPlay: (slide: HeroSlide) => void;
  /**
   * The actions of a continue-watching slide (Go to details, Mark watched, Remove): the same
   * menu as its card in the rail below (CB-CONTINUE-MENU), behind a third button. Asked for
   * on the press, with the slide as shown (its catalog title). Stable, like the other props.
   */
  menuFor?: (slide: HeroSlide) => CardMenuItem[] | undefined;
  /** Dwell per slide; tests shorten it. */
  dwellMs?: number;
}

const isVod = (ref: ItemRef) => ref.contentType === 'movie' || ref.contentType === 'series';

/** A continue slide of a movie or series: the only kind that reads its catalog item (useSlideDetails). */
const readsDetails = (slide: HeroSlide) => slide.kind === 'continue' && isVod(slide.ref);

/**
 * Continue-watching positions carry only a snapshot (title, poster). The
 * catalog item adds the backdrop, plot, year, genres and rating. Shared by the
 * backdrop layer and the slide body through the query cache.
 */
function useSlideDetails(slide: HeroSlide, enabled: boolean): HeroSlide {
  const wanted = enabled && readsDetails(slide);
  const item = useRpcQuery('catalog.item', { ref: slide.ref }, { enabled: wanted, staleTime: 10 * 60_000 });
  return useMemo(() => {
    const d = wanted ? item.data : undefined;
    if (!d || !('title' in d)) return slide;
    const vod = d as { titleBase?: string; backdropUrl?: string; posterUrl?: string; plot?: string; year?: number; genres?: string[]; rating?: number };
    return {
      ...slide,
      // The detail page's title: the catalog's base title wins over the playback snapshot's.
      title: vod.titleBase || slide.title,
      backdropUrl: slide.backdropUrl ?? vod.backdropUrl,
      posterUrl: slide.posterUrl ?? vod.posterUrl,
      plot: slide.plot ?? vod.plot,
      year: slide.year ?? vod.year,
      genres: slide.genres ?? vod.genres,
      rating: slide.rating ?? vod.rating,
    };
  }, [slide, wanted, item.data]);
}

/** `document.visibilityState === 'visible'`, live. */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

/**
 * Whether the window has focus, live. It starts true: a page cannot learn reliably that it was
 * opened in the background, and the idle rest (useInputRest) covers a window nobody returns to.
 */
function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    const on = () => setFocused(true);
    const off = () => setFocused(false);
    window.addEventListener('focus', on);
    window.addEventListener('blur', off);
    return () => {
      window.removeEventListener('focus', on);
      window.removeEventListener('blur', off);
    };
  }, []);
  return focused;
}

/** Input that shows someone is at the window: any of these ends the hero's idle rest. */
const INPUT_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * Counts the hero's automatic turns since the last input in the window. `resting` turns true
 * after `limit` of them and false again on the next input. The listeners only reset a counter
 * (state changes on the two transitions alone), so a moving mouse costs no renders.
 */
function useInputRest(limit: number, enabled: boolean): { resting: boolean; countTurn: () => void } {
  const [resting, setResting] = useState(false);
  const turns = useRef(0);
  const restingRef = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    const onInput = () => {
      turns.current = 0;
      if (restingRef.current) {
        restingRef.current = false;
        setResting(false);
      }
    };
    for (const type of INPUT_EVENTS) window.addEventListener(type, onInput, { capture: true, passive: true });
    return () => {
      for (const type of INPUT_EVENTS) window.removeEventListener(type, onInput, true);
    };
  }, [enabled]);
  const countTurn = useCallback(() => {
    turns.current += 1;
    if (turns.current >= limit && !restingRef.current) {
      restingRef.current = true;
      setResting(true);
    }
  }, [limit]);
  return { resting: enabled && resting, countTurn };
}

/** Whether the element is at least partly on screen (true where IntersectionObserver is missing). */
function useOnScreen(ref: RefObject<HTMLElement | null>): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => setOn(entries.some((e) => e.isIntersecting)), { threshold: 0.1 });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return on;
}

/**
 * How often the dial's fill moves while a slide dwells: 40 steps over the default 8 s on a
 * 28 px bar, under a pixel each, so it reads as a smooth fill at 5 frames a second.
 */
export const DIAL_TICK_MS = 200;

/** Automatic rounds through every slide, with no input in the window, before the rotation rests. */
export const HERO_IDLE_ROUNDS = 2;

/** The dial's fill for `left` ms of `dwell` remaining: 0 at the start, 1 when it turns. */
export function dialFill(left: number, dwell: number): number {
  return dwell > 0 ? Math.min(1, Math.max(0, 1 - left / dwell)) : 1;
}

/** The least sideways travel, in CSS px, that turns the slide (a tap wobbles a few px). */
export const HERO_SWIPE_PX = 48;
/** How long after a swipe's lift its click may still arrive (and is dropped). */
const SWIPE_CLICK_MS = 400;

/**
 * The slide step a touch that travelled (dx, dy) asks for: 1 (next), -1 (previous) or 0 (not a
 * swipe). It has to be mostly sideways, so a scroll down the page that drifts never turns the
 * hero. The next slide comes in from the inline end: a swipe to the left in LTR, to the right
 * in RTL. Exported for tests.
 */
export function swipeStep(dx: number, dy: number, rtl: boolean): -1 | 0 | 1 {
  if (Math.abs(dx) < HERO_SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  return (rtl ? dx > 0 : dx < 0) ? 1 : -1;
}

/**
 * Advances `onAdvance` every `dwell` ms while `running`. Pausing keeps the
 * time already spent on the current slide, so resuming finishes the dwell
 * rather than restarting it; the dial (`dial`, when `fill`) shows that share,
 * moved every DIAL_TICK_MS while running and frozen with the timer. A new
 * `activeKey` starts a full dwell.
 */
function useRotation(
  activeKey: string | undefined,
  running: boolean,
  dwell: number,
  onAdvance: () => void,
  dial: RefObject<HTMLElement | null>,
  fill: boolean,
) {
  const left = useRef<{ key: string | undefined; ms: number }>({ key: undefined, ms: dwell });
  const advance = useRef(onAdvance);
  advance.current = onAdvance;
  // A layout effect, so a new slide's dial is set before it first paints (no full-bar flash).
  useLayoutEffect(() => {
    if (activeKey === undefined) return;
    const ms = left.current.key === activeKey ? left.current.ms : dwell;
    const paint = (remaining: number) => {
      const el = dial.current;
      // Four places: no float noise in the style, and finer than a pixel on any tick.
      if (el) el.style.transform = fill ? `scaleX(${+dialFill(remaining, dwell).toFixed(4)})` : '';
    };
    paint(ms);
    if (!running) return;
    const started = Date.now();
    const elapsed = () => Date.now() - started;
    const tick = fill ? setInterval(() => paint(ms - elapsed()), DIAL_TICK_MS) : undefined;
    const id = setTimeout(() => {
      left.current = { key: undefined, ms: dwell };
      advance.current();
    }, ms);
    return () => {
      clearTimeout(id);
      if (tick !== undefined) clearInterval(tick);
      left.current = { key: activeKey, ms: Math.max(0, ms - elapsed()) };
    };
  }, [activeKey, running, dwell, dial, fill]);
}

/**
 * Background for a slide with no usable artwork: the title's tint (src/ui/tint.ts), the colour its
 * poster tile has, glowing from the far corner into the tint's deepest stop. The hero is glass in
 * every theme, so it takes the deep stops in light too.
 */
function tint(title: string): string {
  const t = tintOf(title);
  return `radial-gradient(120% 140% at 85% 10%, ${t.dark[0]}, transparent 60%), linear-gradient(160deg, ${t.dark[1]}, ${t.deep})`;
}

interface BackdropProps {
  slide: HeroSlide;
  active: boolean;
  title: string;
}

/**
 * One slide's backdrop. The incoming layer animates in on top (z-index 1);
 * the outgoing one stays opaque underneath for the length of that fade and
 * then drops out, so the crossfade never dips through to the frame colour.
 *
 * The backdrop loads through the image cache, then directly once, then the
 * poster the same way, then the tint stays. A poster standing in for a
 * missing backdrop is drawn quarter-size, blurred and scaled up (C5), so it
 * reads as colour, not as a picture.
 *
 * Only a slide that reads its catalog item mounts the query for it (P2-HOME-5): a new arrival
 * carries its own artwork, and a disabled query still built and cached a query per slide.
 */
const Backdrop = memo(function Backdrop(props: BackdropProps) {
  return readsDetails(props.slide) ? <DetailedBackdrop {...props} /> : <BackdropView {...props} s={props.slide} />;
});

function DetailedBackdrop(props: BackdropProps) {
  return <BackdropView {...props} s={useSlideDetails(props.slide, true)} />;
}

/**
 * The upright poster at the hero's inline end (lg up): from near the top to above the slide
 * controls, which sit level with the button row at the same end. It shares the controls' end
 * inset (the page gutter), so the two stack on one edge the way the copy and the buttons share
 * their start edge.
 */
const HERO_UPRIGHT =
  'absolute end-(--page-gutter) top-[8%] z-[3] hidden aspect-[2/3] h-[56%] w-auto rounded-lg object-cover shadow-3 ring-1 ring-glass-border lg:block';

function BackdropView({ slide, active, title, s }: BackdropProps & { s: HeroSlide }) {
  const image = useImageChain([s.backdropUrl, s.posterUrl], s.ref.sourceId);
  const [loaded, setLoaded] = useState<string | null>(null);
  const url = image.url;
  const wide = !!url && image.source === s.backdropUrl?.trim();
  const shown = !!url && loaded === url;
  const fetchPriority = active ? 'high' : 'low';
  return (
    <div
      aria-hidden
      data-hero-backdrop={slide.key}
      data-active={active || undefined}
      className={cn(
        'absolute inset-0 overflow-hidden',
        active
          ? 'z-[1] opacity-100 motion-safe:animate-hero-in'
          : 'z-0 opacity-0 motion-safe:transition-opacity motion-safe:delay-700 motion-safe:duration-0',
      )}
      // The title's tint only once the artwork chain has run out. While a picture loads the
      // layer stays clear (the frame's neutral glass, or the outgoing slide), so the colour
      // never jumps from the tint's hue to the artwork's.
      style={image.failed ? { background: tint(title) } : undefined}
    >
      {url && (
        <img
          key={url}
          src={url}
          alt=""
          draggable={false}
          loading="eager"
          decoding="async"
          referrerPolicy="no-referrer"
          fetchPriority={fetchPriority}
          data-hero-image={wide ? 'backdrop' : 'poster'}
          onLoad={() => setLoaded(url)}
          onError={image.onError}
          className={cn(
            'motion-safe:transition-opacity motion-safe:duration-500',
            wide ? 'absolute inset-0 h-full w-full object-cover object-[center_20%]' : cn(QUARTER_BLUR, 'saturate-150'),
            shown ? (wide ? 'opacity-100' : 'opacity-60') : 'opacity-0',
          )}
        />
      )}
      {/*
        A poster standing in for the backdrop also stands upright at the inline end, from lg
        up, so the wide frame is not an empty colour field. Mounted once the picture has
        loaded, so it comes from the memory cache and never shows a broken image. It ends above
        the slide controls, which sit level with the buttons in that corner.
      */}
      {!wide && shown && (
        <img
          src={url}
          alt=""
          draggable={false}
          decoding="async"
          referrerPolicy="no-referrer"
          data-hero-poster=""
          className={HERO_UPRIGHT}
        />
      )}
      {/*
        No artwork at all: the title's own initials tile stands there instead, the one its card
        shows in the rails, so the slide reads as that title rather than as an empty field. In its
        deep stops in every theme: the hero is glass, and a pale tile there read as a hole in it.
      */}
      {image.failed && (
        <div data-hero-poster-fallback="" className={cn(HERO_UPRIGHT, 'overflow-hidden')}>
          <Poster alt="" label={title} aspect="poster" kind={posterKind(s.ref)} rounded="lg" tint="dark" className="h-full after:hidden" />
        </div>
      )}
    </div>
  );
}

/** The glyph of a title's initials tile. */
function posterKind(ref: ItemRef): 'movie' | 'live' | 'radio' {
  return ref.contentType === 'live' ? 'live' : ref.contentType === 'radio' ? 'radio' : 'movie';
}

/** The hero's secondary buttons on glass: Details and the slide's menu. */
const GLASS_BUTTON = cn(
  'inline-flex h-12 shrink-0 items-center justify-center rounded-md border border-glass-border bg-on-glass/10 text-on-glass select-none',
  'hover:bg-on-glass/20 active:bg-on-glass/25 motion-safe:transition-[background-color,translate] motion-safe:duration-150 motion-safe:active:translate-y-px',
);

interface SlideBodyProps {
  slide: HeroSlide;
  active: boolean;
  panelId: string;
  sourceName: string | undefined;
  canPlay: boolean;
  onPlay: HeroCarouselProps['onPlay'];
  menuFor: HeroCarouselProps['menuFor'];
  /** The slide's menu opened (true) or closed (false): the rotation holds still meanwhile. */
  onMenuOpen: (open: boolean) => void;
  index: number;
  count: number;
}

/**
 * Memoized with the carousel's stable props (P2-HOME-3): a hover, a focus, the rotation's pause
 * and the next backdrop's mount re-rendered all six bodies; a turn now re-renders the two whose
 * `active` changes. Only a slide that reads its catalog item mounts the query (P2-HOME-5).
 */
const SlideBody = memo(function SlideBody(props: SlideBodyProps) {
  return readsDetails(props.slide) ? <DetailedSlideBody {...props} /> : <SlideBodyView {...props} s={props.slide} />;
});

function DetailedSlideBody(props: SlideBodyProps) {
  return <SlideBodyView {...props} s={useSlideDetails(props.slide, props.active)} />;
}

function SlideBodyView({ slide, active, panelId, sourceName, canPlay, onPlay, menuFor, onMenuOpen, index, count, s }: SlideBodyProps & { s: HeroSlide }) {
  const { t, i18n } = useTranslation('shell');
  const openMenu = useContext(CardMenuContext);
  const title = s.title || t('untitled');
  const vod = isVod(s.ref);
  const continuing = s.kind === 'continue';
  const playable = continuing || s.ref.contentType === 'movie';
  const rating = s.rating ? numberFormat(intlLocale(i18n.language), { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(s.rating) : undefined;
  // A displayed title that still ends with "(2025)" (no titleBase from the core, or an older
  // continue-watching snapshot) does not get the year again below it.
  const year = !titleEndsWithYear(title, s.year) ? s.year : undefined;
  const genres = s.genres?.slice(0, 2).join(' / ');
  const eyebrow = continuing ? t('heroEyebrow') : sourceName ? t('heroNewIn', { source: sourceName }) : t('heroNew');
  const titleId = `${panelId}-title-${index}`;
  // Details warms the detail page (query, route chunk, artwork) on hover or focus (C4).
  const details = usePrefetchIntent(usePrefetchTarget(vod && active ? s.ref : undefined, s.posterUrl, s.backdropUrl));
  const hasMenu = continuing && vod && !!menuFor && !!openMenu;
  const moreLabel = t('moreActionsFor', { title });

  return (
    <div
      // Inactive slides only hold the height: hidden from sight, the keyboard and assistive tech.
      {...(active
        ? { id: panelId, role: 'tabpanel', 'aria-roledescription': t('heroSlide'), 'aria-label': t('heroSlideOf', { index: index + 1, total: count }), 'data-testid': 'hero-slide' }
        : { 'aria-hidden': true, inert: true })}
      data-hero-slide={s.key}
      className={cn('col-start-1 row-start-1 min-w-0', HERO_BODY, !active && 'invisible')}
    >
      {/* The copy column grows with wide heroes, so a title is not wrapped into a corner of an empty frame. */}
      <div className={cn('flex w-full min-w-0 max-w-[36rem] flex-col gap-3 text-on-glass min-[1440px]:max-w-[42rem]', active && 'motion-safe:animate-hero-copy')}>
        <p dir="auto" title={eyebrow} className="truncate text-caption font-semibold tracking-wider text-on-glass-muted uppercase">
          {eyebrow}
        </p>
        <h2 id={titleId} dir="auto" className="line-clamp-2 text-match-parent text-display text-on-glass [text-shadow:0_2px_24px_rgb(0_0_0/0.35)]">
          {title}
        </h2>
        <MetaLine
          className="text-body-sm text-on-glass-muted tabular [&>span[aria-hidden]]:text-on-glass-muted"
          items={[
            continuing && s.subtitle ? (
              <span dir="auto" className="block truncate">
                {s.subtitle}
              </span>
            ) : null,
            year,
            genres,
            rating ? (
              <span className="inline-flex items-center gap-1">
                <Star aria-hidden size={13} className="fill-current text-glass-accent" />
                <span aria-hidden>{rating}</span>
                <span className="sr-only">{t('ratedLabel', { rating })}</span>
              </span>
            ) : null,
          ]}
        />
        {s.plot && !continuing && (
          <p dir="auto" className="line-clamp-2 max-w-[60ch] text-match-parent text-body text-on-glass-muted max-sm:hidden">
            {s.plot}
          </p>
        )}
        {continuing && s.fraction !== undefined && (
          <div className="flex max-w-md items-center gap-3">
            <ProgressBar value={s.fraction * 100} tone="glass" label={t('watchedPercent', { percent: Math.round(s.fraction * 100) })} />
            {s.minutesLeft !== undefined && <span className="shrink-0 text-sm text-on-glass-muted tabular">{t('minutesLeft', { count: s.minutesLeft })}</span>}
          </div>
        )}
        {/*
          On a phone Play takes the row and Details (and the slide's menu) fold into square icon
          buttons beside it; a slide with nothing to play keeps Details labelled across the row.
        */}
        <div className="mt-2 flex gap-3 sm:flex-wrap">
          {playable && (
            <button
              type="button"
              onClick={() => onPlay(slide)}
              disabled={!canPlay}
              aria-describedby={titleId}
              className={cn(
                'inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-md bg-glass-accent px-6 text-base font-semibold text-glass-accent-fg shadow-2 select-none max-sm:min-w-0 max-sm:flex-1',
                'hover:brightness-110 active:brightness-90 disabled:cursor-not-allowed disabled:opacity-50',
                'motion-safe:transition-[filter,translate] motion-safe:duration-150 motion-safe:active:translate-y-px',
              )}
            >
              <Play aria-hidden size={18} fill="currentColor" />
              {continuing && s.fraction ? t('resume') : t('play')}
            </button>
          )}
          {vod && (
            <Link
              to={itemPath(s.ref)}
              aria-describedby={titleId}
              onPointerEnter={details.onPointerEnter}
              onPointerLeave={details.onPointerLeave}
              onFocus={details.onFocus}
              onBlur={details.onBlur}
              className={cn(GLASS_BUTTON, 'gap-2 px-5 text-base font-medium', playable ? 'max-sm:w-12 max-sm:px-0' : 'max-sm:flex-1')}
            >
              <Info aria-hidden size={18} />
              <span className={cn(playable && 'max-sm:sr-only')}>{t('details')}</span>
            </Link>
          )}
          {hasMenu && (
            <Tooltip content={moreLabel} tone="glass" side="top" describe={false}>
              <button
                type="button"
                aria-label={moreLabel}
                aria-haspopup="menu"
                data-hero-menu=""
                onClick={(e) => {
                  const items = menuFor?.(s);
                  if (!items?.length || !openMenu) return;
                  onMenuOpen(true);
                  openMenu({ pos: buttonMenuAnchor(e.currentTarget), label: title, items, onClose: () => onMenuOpen(false) });
                }}
                className={cn(GLASS_BUTTON, 'w-12')}
              >
                <EllipsisVertical aria-hidden size={18} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Under a coarse pointer the pill's buttons and ticks grow to 44 px square, like the kit's
 * buttons (TOUCH_TARGET): a 17 x 30 px tick was the only way to another slide on a phone. The
 * drawn dot keeps its size; six slides still fit a 360 px phone.
 */
const OSC_TOUCH = cn(TOUCH_TARGET, 'pointer-coarse:min-w-[calc(44rem/15)]');

const oscButton = cn(
  'inline-flex size-8 shrink-0 items-center justify-center rounded-full text-on-glass-muted hover:bg-on-glass/15 hover:text-on-glass active:bg-on-glass/25 motion-safe:transition-colors',
  OSC_TOUCH,
);

/** Memoized (SH-4): Home passes stable props, so another rail's answer does not re-render the hero. */
export const HeroCarousel = memo(function HeroCarousel({ slides, sourceName, canPlay, onPlay, menuFor, dwellMs = HERO_DWELL_MS }: HeroCarouselProps) {
  const { t } = useTranslation('shell');
  const baseId = useId();
  const panelId = `${baseId}-slide`;
  const sectionRef = useRef<HTMLElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const count = slides.length;

  const [activeKey, setActiveKey] = useState<string | undefined>(slides[0]?.key);
  // The last change came from the rotation timer, not the user: the ticks then switch without their
  // width/colour transition, which would cost main-thread frames on an otherwise idle page.
  const [autoTurn, setAutoTurn] = useState(false);
  const found = slides.findIndex((s) => s.key === activeKey);
  // A refresh that drops the active slide falls back to the first.
  const index = found >= 0 ? found : 0;
  const active = slides[index];

  const reducedMotion = useReducedMotion();
  const visible = useDocumentVisible();
  const windowFocused = useWindowFocused();
  const onScreen = useOnScreen(sectionRef);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  // A slide's menu draws outside the hero, so neither hover nor focus holds the slide under it.
  const [menuOpen, setMenuOpen] = useState(false);
  const canRotate = count > 1 && !reducedMotion;
  const rest = useInputRest(HERO_IDLE_ROUNDS * count, canRotate);
  const running = canRotate && !userPaused && !hovered && !focused && !menuOpen && visible && windowFocused && onScreen && !rest.resting;
  const dialRef = useRef<HTMLSpanElement>(null);
  // The touch a swipe may come from, and when the last swipe ended (the click its lift may fire is dropped).
  const swipeFrom = useRef<{ id: number; x: number; y: number } | null>(null);
  const swipedAt = useRef(-Infinity);

  const go = useCallback(
    (step: number, auto = false) => {
      if (count === 0) return;
      setAutoTurn(auto);
      setActiveKey(slides[wrapIndex(index, step, count)]!.key);
    },
    [slides, index, count],
  );
  useRotation(
    active?.key,
    running,
    dwellMs,
    () => {
      rest.countTurn();
      go(1, true);
    },
    dialRef,
    canRotate,
  );

  // Backdrops mount once visited. The next one mounts when the main thread is idle, so it
  // is fetched (at low priority, through the image cache) and decoded before its turn
  // without competing with the visible slide's pictures.
  // The first slide's from the start (P2-HOME-3): the effect below adding it re-rendered the whole
  // hero right after it mounted, for a backdrop that was already drawn.
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set(slides[0] ? [slides[0].key] : []));
  const nextKey = count > 1 ? slides[wrapIndex(index, 1, count)]?.key : undefined;
  const visibleKey = active?.key;
  useEffect(() => {
    if (!visibleKey) return;
    setSeen((prev) => (prev.has(visibleKey) ? prev : new Set([...prev, visibleKey])));
  }, [visibleKey]);
  useEffect(() => {
    if (!nextKey) return;
    return whenIdle(() => setSeen((prev) => (prev.has(nextKey) ? prev : new Set([...prev, nextKey]))));
  }, [nextKey]);

  if (!active) return null;

  const choose = (i: number, focusTab: boolean) => {
    const key = slides[i]!.key;
    setAutoTurn(false);
    setActiveKey(key);
    if (focusTab) tabsRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[i]?.focus();
  };

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    let next: number | null = null;
    if (e.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) next = wrapIndex(index, 1, count);
    else if (e.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) next = wrapIndex(index, -1, count);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = count - 1;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    choose(next, true);
  };

  const titleOf = (s: HeroSlide) => s.title || t('untitled');

  return (
    <section
      ref={sectionRef}
      aria-roledescription={t('heroCarousel')}
      aria-label={t('heroLabel')}
      data-testid="dashboard-hero"
      data-rotating={running || undefined}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      // Swipe (touch and pen; a mouse has the chevrons): measured from press to lift, with no
      // drag that follows the finger, so nothing lays out while it moves. touch-action below
      // keeps vertical scrolling and pinch zoom with the browser and leaves sideways moves to
      // these handlers, so the browser does not cancel the touch (pointercancel) to pan.
      onPointerDown={(e) => {
        swipeFrom.current = count > 1 && e.pointerType !== 'mouse' && e.isPrimary ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null;
      }}
      onPointerUp={(e) => {
        const from = swipeFrom.current;
        swipeFrom.current = null;
        if (!from || from.id !== e.pointerId) return;
        const step = swipeStep(e.clientX - from.x, e.clientY - from.y, getComputedStyle(e.currentTarget).direction === 'rtl');
        if (step === 0) return;
        swipedAt.current = e.timeStamp;
        go(step);
      }}
      onPointerCancel={() => {
        swipeFrom.current = null;
      }}
      // A swipe that starts and ends on Play or Details is not a press of it. Only the click
      // right after the lift: a later one (a key, the next tap) goes through.
      onClickCapture={(e) => {
        if (e.timeStamp - swipedAt.current > SWIPE_CLICK_MS) return;
        swipedAt.current = -Infinity;
        e.preventDefault();
        e.stopPropagation();
      }}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      className={cn(
        HERO_FRAME,
        '[touch-action:pan-y_pinch-zoom]',
        // Over artwork the focus ring is the glass text colour in every theme (the light accent would vanish on it).
        'isolate [--color-focus:var(--color-on-glass)] [--color-glow:transparent]',
      )}
    >
      {slides.map((s, i) =>
        seen.has(s.key) || i === index ? <Backdrop key={s.key} slide={s} active={i === index} title={titleOf(s)} /> : null,
      )}
      {/*
        The scrims: glass from the inline start behind the copy column (from sm, where the copy
        has a side), and from the bottom, taller on phones where the copy runs edge to edge
        under the picture. Then, in the dark themes, the fade into the page.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 start-0 z-[2] w-[72%] bg-gradient-to-r from-glass-strong via-glass/55 to-transparent max-sm:hidden rtl:bg-gradient-to-l"
      />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] h-[72%] bg-gradient-to-t from-glass-strong via-glass/60 to-transparent sm:h-3/5" />
      <div aria-hidden className={HERO_PAGE_FADE} />

      {count > 1 && (
        // Top corner on smaller screens, beside the button row from lg up (the copy column has
        // the room then). On a phone the capsule goes: a 270 px dark pill of six dots over the
        // artwork read as a broken field and outweighed the title. There the toggle and the dots
        // are a plain row under the buttons (HERO_BODY leaves the room), the chevrons go, and the
        // ticks keep 44 px each: a swipe over the hero moves (onPointerUp on the section) and the
        // ticks choose. The toggle stays: a rotation that runs by itself needs a way to stop it.
        <div
          className={cn(
            'absolute end-3 top-3 z-[4] flex items-center gap-0.5 rounded-full border border-glass-border glass p-0.5 shadow-1 lg:top-auto lg:end-(--page-gutter) lg:bottom-14',
            'max-sm:inset-x-0 max-sm:top-auto max-sm:bottom-1 max-sm:justify-center max-sm:rounded-none max-sm:border-0 max-sm:bg-transparent max-sm:p-0 max-sm:shadow-none',
          )}
          data-testid="hero-controls"
        >
          {canRotate && (
            <Tooltip content={userPaused ? t('heroPlayRotation') : t('heroPause')} tone="glass" side="bottom" describe={false}>
              <button
                type="button"
                onClick={() => setUserPaused((p) => !p)}
                aria-label={userPaused ? t('heroPlayRotation') : t('heroPause')}
                data-testid="hero-rotation"
                className={oscButton}
              >
                {userPaused ? <Play aria-hidden size={14} fill="currentColor" /> : <Pause aria-hidden size={14} fill="currentColor" />}
              </button>
            </Tooltip>
          )}
          <Tooltip content={t('heroPrevious')} tone="glass" side="bottom" describe={false}>
            <button type="button" onClick={() => go(-1)} aria-label={t('heroPrevious')} className={cn(oscButton, 'max-sm:hidden')} data-testid="hero-prev">
              <ChevronLeft aria-hidden size={16} className="rtl:rotate-180" />
            </button>
          </Tooltip>
          <div ref={tabsRef} role="tablist" aria-label={t('heroControls')} className="flex items-center">
            {slides.map((s, i) => {
              const on = i === index;
              return (
                <button
                  key={s.key}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  aria-controls={on ? panelId : undefined}
                  aria-label={titleOf(s)}
                  tabIndex={on ? 0 : -1}
                  data-hero-tab={s.key}
                  onClick={() => choose(i, false)}
                  onKeyDown={onTabKeyDown}
                  className={cn('group/tick flex h-8 items-center justify-center rounded-full px-1.5', OSC_TOUCH)}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'relative block h-1.5 overflow-hidden rounded-full',
                      !autoTurn && 'motion-safe:transition-[width,background-color] motion-safe:duration-300',
                      on ? 'w-7 bg-on-glass/25' : 'w-1.5 bg-on-glass/45 group-hover/tick:bg-on-glass/80',
                    )}
                  >
                    {on && (
                      <span
                        // Keyed by slide, so the fill restarts on every turn. useRotation sets its
                        // transform (frozen, not reset, while paused, like the timer behind it).
                        key={s.key}
                        ref={dialRef}
                        data-hero-dial=""
                        className="absolute inset-0 origin-left rounded-full bg-glass-accent rtl:origin-right"
                      />
                    )}
                  </span>
                </button>
              );
            })}
          </div>
          <Tooltip content={t('heroNext')} tone="glass" side="bottom" describe={false}>
            <button type="button" onClick={() => go(1)} aria-label={t('heroNext')} className={cn(oscButton, 'max-sm:hidden')} data-testid="hero-next">
              <ChevronRight aria-hidden size={16} className="rtl:rotate-180" />
            </button>
          </Tooltip>
        </div>
      )}

      {/* Live region: quiet while rotating (no announcement every few seconds), polite once the user drives it. */}
      {/*
        One column that may shrink below its content (minmax(0,1fr)): an auto column let the
        widest slide's button row set the width, so on phones it overflowed the frame and the
        frame clipped the Details button.
      */}
      <div className="relative z-[3] grid grid-cols-[minmax(0,1fr)]" aria-live={running ? 'off' : 'polite'} aria-atomic="false">
        {slides.map((s, i) => (
          <SlideBody
            key={s.key}
            slide={s}
            active={i === index}
            index={i}
            count={count}
            panelId={panelId}
            sourceName={sourceName(s.ref.sourceId)}
            canPlay={canPlay(s.ref)}
            onPlay={onPlay}
            menuFor={menuFor}
            onMenuOpen={setMenuOpen}
          />
        ))}
      </div>
    </section>
  );
});
