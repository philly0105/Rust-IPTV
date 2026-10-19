/**
 * The dashboard hero: a rotating carousel of continue-watching entries and new
 * arrivals over their backdrops (docs/architecture/appearance.md).
 *
 * Pattern: the WAI-ARIA "auto-rotating carousel with tabs for slide control".
 * A small on-screen-display pill in the top corner holds the rotation toggle,
 * previous/next and one dial tick per slide (a tablist: arrows move and choose,
 * Home/End jump). Rotation pauses while the pointer is over the hero or focus
 * is inside it, while the window is hidden, unfocused or the hero is scrolled
 * away, and never starts under prefers-reduced-motion. It also rests after
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
 * Text sits on frosted glass (C8 tokens) that clears toward the inline end, so
 * it stays readable on any artwork in every theme; a slide with no artwork gets
 * a per-title tint instead. The frost is not a backdrop filter (C5): it is a
 * glass tint over a quarter-size, lightly blurred copy of the artwork, masked
 * to the text column, so nothing re-samples the page while the hero is on
 * screen. Artwork loads through the image cache; the visible slide's pictures
 * load at high priority, and the next slide's backdrop is mounted (and so
 * fetched at low priority) once the main thread is idle. Every slide body is laid into one grid cell, so the
 * hero keeps the height of its tallest slide and nothing below it moves when
 * the rotation turns.
 */

import { ChevronLeft, ChevronRight, Info, Pause, Play, Star } from 'lucide-react';
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useRpcQuery } from '@/api/query';
import type { ItemRef } from '@/api/types';
import { usePrefetchIntent } from '@/features/vod/hooks/prefetch';
import { Poster, ProgressBar, QUARTER_BLUR, cn, hueOf, useImageChain, whenIdle } from '@/ui';
import { intlLocale } from '@/lib/intl';

import { useReducedMotion } from '../theme';
import { itemPath, joinList, usePrefetchTarget } from './cards';
import { HERO_BODY, HERO_FRAME } from './HeroSkeleton';
import { HERO_DWELL_MS, titleEndsWithYear, wrapIndex, type HeroSlide } from './heroSlides';

export interface HeroCarouselProps {
  slides: readonly HeroSlide[];
  /** Display name of a slide's source, for "New in …". */
  sourceName: (sourceId: string) => string | undefined;
  /** The source still exists, so the slide can play. */
  canPlay: (ref: ItemRef) => boolean;
  onPlay: (slide: HeroSlide) => void;
  /** Dwell per slide; tests shorten it. */
  dwellMs?: number;
}

const isVod = (ref: ItemRef) => ref.contentType === 'movie' || ref.contentType === 'series';

/**
 * Continue-watching positions carry only a snapshot (title, poster). The
 * catalog item adds the backdrop, plot, year, genres and rating. Shared by the
 * backdrop layer and the slide body through the query cache.
 */
function useSlideDetails(slide: HeroSlide, enabled: boolean): HeroSlide {
  const wanted = enabled && slide.kind === 'continue' && isVod(slide.ref);
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

/** Background tint for a slide with no usable artwork: the title's hue, like the poster fallback. */
function tint(title: string): string {
  const hue = hueOf(title);
  return `radial-gradient(120% 140% at 85% 10%, hsl(${hue} 45% 34%), transparent 60%), linear-gradient(150deg, hsl(${(hue + 40) % 360} 40% 16%), hsl(${hue} 30% 8%))`;
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
 */
function Backdrop({ slide, active, title }: { slide: HeroSlide; active: boolean; title: string }) {
  const s = useSlideDetails(slide, true);
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
            wide ? 'absolute inset-0 h-full w-full object-cover object-[center_25%]' : cn(QUARTER_BLUR, 'saturate-150'),
            shown ? (wide ? 'opacity-100' : 'opacity-70') : 'opacity-0',
          )}
        />
      )}
      {/*
        The frost's texture: the same backdrop, quarter-size and blurred, under the
        glass tint and masked like it. Mounted once the picture has loaded, so it
        comes from the memory cache and never shows a broken image.
      */}
      {wide && shown && (
        <div data-hero-frost-art="" className="absolute inset-0 overflow-hidden hero-frost">
          <img src={url} alt="" draggable={false} decoding="async" referrerPolicy="no-referrer" className={cn(QUARTER_BLUR, 'object-[center_25%] saturate-125')} />
        </div>
      )}
    </div>
  );
}

function SlideBody({
  slide,
  active,
  panelId,
  sourceName,
  canPlay,
  onPlay,
  index,
  count,
}: {
  slide: HeroSlide;
  active: boolean;
  panelId: string;
  sourceName: string | undefined;
  canPlay: boolean;
  onPlay: () => void;
  index: number;
  count: number;
}) {
  const { t, i18n } = useTranslation('shell');
  const s = useSlideDetails(slide, active);
  const title = s.title || t('untitled');
  const vod = isVod(s.ref);
  const continuing = s.kind === 'continue';
  const playable = continuing || s.ref.contentType === 'movie';
  const rating = s.rating ? new Intl.NumberFormat(intlLocale(i18n.language), { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(s.rating) : undefined;
  // A displayed title that still ends with "(2025)" (no titleBase from the core, or an older
  // continue-watching snapshot) does not get the year again below it.
  const facts = joinList([!titleEndsWithYear(title, s.year) && s.year, s.genres?.slice(0, 2).join(' / ')], i18n.language);
  const eyebrow = continuing ? t('heroEyebrow') : sourceName ? t('heroNewIn', { source: sourceName }) : t('heroNew');
  const titleId = `${panelId}-title-${index}`;
  // Details warms the detail page (query, route chunk, artwork) on hover or focus (C4).
  const details = usePrefetchIntent(usePrefetchTarget(vod && active ? s.ref : undefined, s.posterUrl, s.backdropUrl));

  return (
    <div
      // Inactive slides only hold the height: hidden from sight, the keyboard and assistive tech.
      {...(active
        ? { id: panelId, role: 'tabpanel', 'aria-roledescription': t('heroSlide'), 'aria-label': t('heroSlideOf', { index: index + 1, total: count }), 'data-testid': 'hero-slide' }
        : { 'aria-hidden': true, inert: true })}
      data-hero-slide={s.key}
      // Room above the copy for the slide controls in the top corner.
      className={cn('col-start-1 row-start-1 min-w-0', HERO_BODY, count > 1 && 'pt-14 sm:pt-14', !active && 'invisible')}
    >
      <div className="hidden w-[10rem] shrink-0 lg:block">
        {active || s.posterUrl ? (
          <Poster
            src={s.posterUrl}
            alt=""
            label={title}
            aspect="poster"
            sourceId={s.ref.sourceId}
            priority={active}
            className="shadow-2 ring-1 ring-glass-border"
          />
        ) : (
          <div className="aspect-[2/3] w-full" />
        )}
      </div>
      {/* The copy column grows with wide heroes, so a title is not wrapped into a corner of an empty frame. */}
      <div className={cn('flex min-w-0 max-w-[28rem] flex-1 flex-col gap-2.5 text-on-glass min-[1440px]:max-w-[40rem]', active && 'motion-safe:animate-hero-copy')}>
        <p className="flex items-center gap-2 text-sm font-semibold text-on-glass-muted">
          <span aria-hidden className="h-3.5 w-[3px] shrink-0 rounded-full bg-glass-accent shadow-[0_0_10px_var(--color-glass-accent)]" />
          <span dir="auto" title={eyebrow} className="truncate">
            {eyebrow}
          </span>
        </p>
        <h2
          id={titleId}
          dir="auto"
          className="line-clamp-2 text-match-parent font-display text-[clamp(1.75rem,3.2vw,3rem)] leading-[1.05] font-semibold text-on-glass"
        >
          {title}
        </h2>
        {(facts || rating || (continuing && s.subtitle)) && (
          <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-on-glass-muted tabular">
            {continuing && s.subtitle && <span dir="auto" className="truncate">{s.subtitle}</span>}
            {facts && <span>{facts}</span>}
            {rating && (
              <span className="inline-flex items-center gap-1">
                <Star aria-hidden size={13} className="fill-current text-glass-accent" />
                <span aria-hidden>{rating}</span>
                <span className="sr-only">{t('ratedLabel', { rating })}</span>
              </span>
            )}
          </p>
        )}
        {s.plot && !continuing && (
          <p dir="auto" className="line-clamp-2 max-w-[60ch] text-match-parent text-sm text-on-glass-muted">
            {s.plot}
          </p>
        )}
        {continuing && s.fraction !== undefined && (
          <div className="flex max-w-md items-center gap-3">
            <ProgressBar value={s.fraction * 100} tone="glass" label={t('watchedPercent', { percent: Math.round(s.fraction * 100) })} />
            {s.minutesLeft !== undefined && <span className="shrink-0 text-sm text-on-glass-muted tabular">{t('minutesLeft', { count: s.minutesLeft })}</span>}
          </div>
        )}
        <div className="mt-1.5 flex flex-wrap gap-3">
          {playable && (
            <button
              type="button"
              onClick={onPlay}
              disabled={!canPlay}
              aria-describedby={titleId}
              className={cn(
                'inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-md bg-glass-accent px-5 text-base font-semibold text-glass-accent-fg shadow-2 select-none',
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
              className={cn(
                'inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-md border border-glass-border bg-on-glass/10 px-5 text-base font-medium text-on-glass select-none',
                'hover:bg-on-glass/20 active:bg-on-glass/25 motion-safe:transition-[background-color,translate] motion-safe:duration-150 motion-safe:active:translate-y-px',
              )}
            >
              <Info aria-hidden size={18} />
              {t('details')}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

const oscButton =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-full text-on-glass-muted hover:bg-on-glass/15 hover:text-on-glass active:bg-on-glass/25 motion-safe:transition-colors';

/** Memoized (SH-4): Home passes stable props, so another rail's answer does not re-render the hero. */
export const HeroCarousel = memo(function HeroCarousel({ slides, sourceName, canPlay, onPlay, dwellMs = HERO_DWELL_MS }: HeroCarouselProps) {
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
  const canRotate = count > 1 && !reducedMotion;
  const rest = useInputRest(HERO_IDLE_ROUNDS * count, canRotate);
  const running = canRotate && !userPaused && !hovered && !focused && visible && windowFocused && onScreen && !rest.resting;
  const dialRef = useRef<HTMLSpanElement>(null);

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
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
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
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      className={cn(
        HERO_FRAME,
        // Over artwork the focus ring is the glass text colour in every theme (the light accent would vanish on it).
        'isolate [--color-focus:var(--color-on-glass)] [--color-glow:transparent]',
      )}
    >
      {slides.map((s, i) =>
        seen.has(s.key) || i === index ? <Backdrop key={s.key} slide={s} active={i === index} title={titleOf(s)} /> : null,
      )}
      {/*
        Frosted glass over the artwork: solid behind the text column, clearing toward
        the inline end so the picture shows. Narrow screens frost the whole frame,
        because the text runs edge to edge there.
      */}
      <div aria-hidden className="pointer-events-none absolute inset-0 z-[2] bg-glass hero-frost" />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] h-1/3 bg-gradient-to-t from-glass to-transparent" />

      {count > 1 && (
        <div className="absolute end-3 top-3 z-[4] flex items-center gap-0.5 rounded-full border border-glass-border glass p-0.5 shadow-1" data-testid="hero-controls">
          {canRotate && (
            <button
              type="button"
              onClick={() => setUserPaused((p) => !p)}
              aria-label={userPaused ? t('heroPlayRotation') : t('heroPause')}
              title={userPaused ? t('heroPlayRotation') : t('heroPause')}
              data-testid="hero-rotation"
              className={oscButton}
            >
              {userPaused ? <Play aria-hidden size={14} fill="currentColor" /> : <Pause aria-hidden size={14} fill="currentColor" />}
            </button>
          )}
          <button type="button" onClick={() => go(-1)} aria-label={t('heroPrevious')} title={t('heroPrevious')} className={oscButton} data-testid="hero-prev">
            <ChevronLeft aria-hidden size={16} className="rtl:rotate-180" />
          </button>
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
                  className="group/tick flex h-8 items-center justify-center rounded-full px-1.5"
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
          <button type="button" onClick={() => go(1)} aria-label={t('heroNext')} title={t('heroNext')} className={oscButton} data-testid="hero-next">
            <ChevronRight aria-hidden size={16} className="rtl:rotate-180" />
          </button>
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
            onPlay={() => onPlay(s)}
          />
        ))}
      </div>
    </section>
  );
});
