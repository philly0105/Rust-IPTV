/**
 * The dashboard hero: a rotating carousel of continue-watching entries and new
 * arrivals over their backdrops (docs/architecture/appearance.md).
 *
 * Pattern: the WAI-ARIA "auto-rotating carousel with tabs for slide control".
 * A small on-screen-display pill in the top corner holds the rotation toggle,
 * previous/next and one dial tick per slide (a tablist: arrows move and choose,
 * Home/End jump). Rotation pauses while the pointer is over the hero or focus
 * is inside it, while the window is hidden or the hero is scrolled away, and
 * never starts under prefers-reduced-motion. The active tick fills over the
 * dwell time and freezes with the timer, so it always shows how long is left.
 *
 * Text sits on frosted glass (C8 tokens) that clears toward the inline end, so
 * it stays readable on any artwork in every theme; a slide with no artwork gets
 * a per-title tint instead. Every slide body is laid into one grid cell, so the
 * hero keeps the height of its tallest slide and nothing below it moves when
 * the rotation turns.
 */

import { ChevronLeft, ChevronRight, Info, Pause, Play, Star } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useRpcQuery } from '@/api/query';
import type { ItemRef } from '@/api/types';
import { Poster, ProgressBar, cn, hueOf } from '@/ui';

import { useReducedMotion } from '../theme';
import { itemPath, joinList } from './cards';
import { HERO_BODY, HERO_FRAME } from './HeroSkeleton';
import { HERO_DWELL_MS, wrapIndex, type HeroSlide } from './heroSlides';

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
    const vod = d as { backdropUrl?: string; posterUrl?: string; plot?: string; year?: number; genres?: string[]; rating?: number };
    return {
      ...slide,
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
 * Advances `onAdvance` every `dwell` ms while `running`. Pausing keeps the
 * time already spent on the current slide, so resuming finishes the dwell
 * rather than restarting it (the dial tick, paused with it, agrees).
 * A new `activeKey` starts a full dwell.
 */
function useRotation(activeKey: string | undefined, running: boolean, dwell: number, onAdvance: () => void) {
  const left = useRef<{ key: string | undefined; ms: number }>({ key: undefined, ms: dwell });
  const advance = useRef(onAdvance);
  advance.current = onAdvance;
  useEffect(() => {
    if (!running || activeKey === undefined) return;
    const ms = left.current.key === activeKey ? left.current.ms : dwell;
    const started = Date.now();
    const id = setTimeout(() => {
      left.current = { key: undefined, ms: dwell };
      advance.current();
    }, ms);
    return () => {
      clearTimeout(id);
      left.current = { key: activeKey, ms: Math.max(0, ms - (Date.now() - started)) };
    };
  }, [activeKey, running, dwell]);
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
 */
function Backdrop({ slide, active, title }: { slide: HeroSlide; active: boolean; title: string }) {
  const s = useSlideDetails(slide, true);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [loaded, setLoaded] = useState<string | null>(null);
  const backdrop = s.backdropUrl && !failed.has(s.backdropUrl) ? s.backdropUrl : undefined;
  const poster = !backdrop && s.posterUrl && !failed.has(s.posterUrl) ? s.posterUrl : undefined;
  const src = backdrop ?? poster;
  const fail = (url: string) => setFailed((prev) => new Set(prev).add(url));
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
      style={{ background: tint(title) }}
    >
      {src && (
        <img
          src={src}
          alt=""
          draggable={false}
          decoding="async"
          referrerPolicy="no-referrer"
          fetchPriority={active ? 'high' : 'low'}
          onLoad={() => setLoaded(src)}
          onError={() => fail(src)}
          className={cn(
            'absolute inset-0 h-full w-full object-cover motion-safe:transition-opacity motion-safe:duration-500',
            // A poster stands in for a missing backdrop: blown up and softened, it reads as colour, not as a picture.
            backdrop ? 'object-[center_25%]' : 'scale-125 blur-2xl saturate-150',
            loaded === src ? (backdrop ? 'opacity-100' : 'opacity-70') : 'opacity-0',
          )}
        />
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
  const rating = s.rating ? new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(s.rating) : undefined;
  const facts = joinList([s.year, s.genres?.slice(0, 2).join(' / ')], i18n.language);
  const eyebrow = continuing ? t('heroEyebrow') : sourceName ? t('heroNewIn', { source: sourceName }) : t('heroNew');
  const titleId = `${panelId}-title-${index}`;

  return (
    <div
      // Inactive slides only hold the height: hidden from sight, the keyboard and assistive tech.
      {...(active
        ? { id: panelId, role: 'tabpanel', 'aria-roledescription': t('heroSlide'), 'aria-label': t('heroSlideOf', { index: index + 1, total: count }), 'data-testid': 'hero-slide' }
        : { 'aria-hidden': true, inert: true })}
      data-hero-slide={s.key}
      // Room above the copy for the slide controls in the top corner.
      className={cn('col-start-1 row-start-1', HERO_BODY, count > 1 && 'pt-14 sm:pt-14', !active && 'invisible')}
    >
      <div className="hidden w-[10rem] shrink-0 lg:block">
        {active || s.posterUrl ? (
          <Poster src={s.posterUrl} alt="" label={title} aspect="poster" eager={active} className="shadow-2 ring-1 ring-glass-border" />
        ) : (
          <div className="aspect-[2/3] w-full" />
        )}
      </div>
      <div className={cn('flex min-w-0 max-w-[28rem] flex-1 flex-col gap-2.5 text-on-glass', active && 'motion-safe:animate-hero-copy')}>
        <p className="flex items-center gap-2 text-sm font-semibold text-on-glass-muted">
          <span aria-hidden className="h-3.5 w-[3px] shrink-0 rounded-full bg-glass-accent shadow-[0_0_10px_var(--color-glass-accent)]" />
          <span dir="auto" className="truncate">{eyebrow}</span>
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

export function HeroCarousel({ slides, sourceName, canPlay, onPlay, dwellMs = HERO_DWELL_MS }: HeroCarouselProps) {
  const { t } = useTranslation('shell');
  const baseId = useId();
  const panelId = `${baseId}-slide`;
  const sectionRef = useRef<HTMLElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const count = slides.length;

  const [activeKey, setActiveKey] = useState<string | undefined>(slides[0]?.key);
  const found = slides.findIndex((s) => s.key === activeKey);
  // A refresh that drops the active slide falls back to the first.
  const index = found >= 0 ? found : 0;
  const active = slides[index];

  const reducedMotion = useReducedMotion();
  const visible = useDocumentVisible();
  const onScreen = useOnScreen(sectionRef);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const canRotate = count > 1 && !reducedMotion;
  const running = canRotate && !userPaused && !hovered && !focused && visible && onScreen;

  const go = useCallback(
    (step: number) => {
      if (count === 0) return;
      setActiveKey(slides[wrapIndex(index, step, count)]!.key);
    },
    [slides, index, count],
  );
  useRotation(active?.key, running, dwellMs, () => go(1));

  // Backdrops mount once visited, plus the next one so it has loaded before its turn.
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  const nextKey = count > 1 ? slides[wrapIndex(index, 1, count)]?.key : undefined;
  useEffect(() => {
    setSeen((prev) => {
      const add = [active?.key, nextKey].filter((k): k is string => !!k && !prev.has(k));
      return add.length ? new Set([...prev, ...add]) : prev;
    });
  }, [active?.key, nextKey]);

  if (!active) return null;

  const choose = (i: number, focusTab: boolean) => {
    const key = slides[i]!.key;
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
        'isolate border-glass-border bg-glass-strong [--color-focus:var(--color-on-glass)] [--color-glow:transparent]',
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
      <div aria-hidden className="pointer-events-none absolute inset-0 z-[2] glass hero-frost" />
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
                      'relative block h-1.5 overflow-hidden rounded-full motion-safe:transition-[width,background-color] motion-safe:duration-300',
                      on ? 'w-7 bg-on-glass/25' : 'w-1.5 bg-on-glass/45 group-hover/tick:bg-on-glass/80',
                    )}
                  >
                    {on && (
                      <span
                        // Keyed by slide, so the fill restarts on every turn.
                        key={s.key}
                        data-hero-dial=""
                        // Frozen (not reset) while paused, like the timer behind it.
                        className={cn('absolute inset-0 origin-left rounded-full bg-glass-accent rtl:origin-right', canRotate && 'motion-safe:animate-dial-fill')}
                        style={canRotate ? { animationDuration: `${dwellMs}ms`, animationPlayState: running ? 'running' : 'paused' } : undefined}
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
      <div className="relative z-[3] grid" aria-live={running ? 'off' : 'polite'} aria-atomic="false">
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
}
