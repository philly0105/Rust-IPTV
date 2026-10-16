/** Dashboard hero: slide selection (heroSlides.ts) and the rotating carousel (HeroCarousel.tsx). */

import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type { ItemRef, PlaybackPosition, VodItem } from '@/api/types';

import { installDomStubs, rpcMock } from '../../test/harness';

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
}));

const { queryClient } = await import('@/api/query');
const { HeroCarousel } = await import('../HeroCarousel');
const { buildHeroSlides, wrapIndex, HERO_MAX_CONTINUE, HERO_MAX_SLIDES } = await import('../heroSlides');
type HeroSlide = import('../heroSlides').HeroSlide;

const movie = (id: string): ItemRef => ({ sourceId: 's1', contentType: 'movie', itemId: id });

function vod(id: string, over: Partial<VodItem> = {}): VodItem {
  return { ref: movie(id), title: `Movie ${id}`, posterUrl: `https://img.test/${id}.jpg`, ...over } as VodItem;
}

function position(id: string, over: Partial<PlaybackPosition> = {}): PlaybackPosition {
  return {
    ref: movie(id),
    positionSeconds: 1200,
    durationSeconds: 4800,
    updatedAt: '2026-10-10T20:00:00Z',
    watched: false,
    snapshot: { title: `Resume ${id}` },
    ...over,
  } as PlaybackPosition;
}

function slide(id: string, over: Partial<HeroSlide> = {}): HeroSlide {
  return { key: `s1|movie|${id}`, kind: 'new', ref: movie(id), title: `Title ${id}`, ...over };
}

const DWELL = 1000;
const THREE = [slide('a', { backdropUrl: 'https://img.test/a-wide.jpg' }), slide('b'), slide('c')];

/** Reduced motion is the only media query the carousel reads; everything else stays false. */
function stubReducedMotion(on: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: on && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function renderHero(slides: readonly HeroSlide[] = THREE, onPlay = vi.fn()) {
  queryClient.clear();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <HeroCarousel slides={slides} sourceName={() => 'Home IPTV'} canPlay={() => true} onPlay={onPlay} dwellMs={DWELL} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { hero: screen.getByTestId('dashboard-hero'), onPlay };
}

const selectedTab = () => screen.getByRole('tab', { selected: true });
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  stubReducedMotion(false);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('buildHeroSlides', () => {
  it('puts continue watching first, capped, then new arrivals with a backdrop before poster-only ones', () => {
    const cw = ['p1', 'p2', 'p3', 'p4'].map((id) => position(id));
    const added = [vod('n1'), vod('n2', { backdropUrl: 'https://img.test/n2-wide.jpg' }), vod('n3', { posterUrl: undefined }), vod('n4')];
    const slides = buildHeroSlides(cw, added);
    expect(slides.map((s) => s.key)).toEqual(['s1|movie|p1|', 's1|movie|p2|', 's1|movie|p3|', 's1|movie|n2', 's1|movie|n1', 's1|movie|n4']);
    expect(slides.filter((s) => s.kind === 'continue')).toHaveLength(HERO_MAX_CONTINUE);
    expect(slides).toHaveLength(HERO_MAX_SLIDES);
    // A title with no artwork at all never becomes a slide.
    expect(slides.some((s) => s.ref.itemId === 'n3')).toBe(false);
  });

  it('carries the watched share and minutes left, and never repeats a title already resuming', () => {
    const [first, second] = buildHeroSlides([position('m1')], [vod('m1'), vod('m2')]);
    expect(first).toMatchObject({ kind: 'continue', title: 'Resume m1', fraction: 0.25, minutesLeft: 60 });
    expect(second).toMatchObject({ kind: 'new', title: 'Movie m2' });
    expect(buildHeroSlides([position('m1')], [vod('m1'), vod('m2')])).toHaveLength(2);
  });

  it('is empty without data and honours a smaller cap', () => {
    expect(buildHeroSlides([], [])).toEqual([]);
    expect(buildHeroSlides([position('p1'), position('p2')], [vod('n1')], 1)).toHaveLength(1);
  });

  it('wrapIndex wraps both ways and survives an empty list', () => {
    expect(wrapIndex(2, 1, 3)).toBe(0);
    expect(wrapIndex(0, -1, 3)).toBe(2);
    expect(wrapIndex(1, 7, 3)).toBe(2);
    expect(wrapIndex(0, 1, 0)).toBe(0);
  });
});

describe('HeroCarousel', () => {
  it('is a named carousel: one tabpanel for the slide on show and a tab per slide', () => {
    const { hero } = renderHero();
    expect(hero.getAttribute('aria-roledescription')).toBe('carousel');
    expect(hero.getAttribute('aria-label')).toBe('Featured');
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-label')).toBe('1 of 3');
    expect(panel.getAttribute('aria-roledescription')).toBe('slide');
    expect(within(panel).getByRole('heading', { name: 'Title a' })).toBeTruthy();
    expect(within(panel).getByText('New in Home IPTV')).toBeTruthy();
    const tabs = within(screen.getByRole('tablist', { name: 'Slides' })).getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-label'))).toEqual(['Title a', 'Title b', 'Title c']);
    expect(selectedTab().getAttribute('aria-controls')).toBe(panel.id);
    // The slides that are not on show only hold the height.
    for (const hidden of hero.querySelectorAll('[data-hero-slide]:not([data-testid="hero-slide"])')) {
      expect(hidden.getAttribute('aria-hidden')).toBe('true');
      expect(hidden.hasAttribute('inert')).toBe(true);
    }
  });

  it('turns after the dwell and wraps back to the first slide', () => {
    vi.useFakeTimers();
    const { hero } = renderHero();
    expect(hero.dataset['rotating']).toBe('true');
    tick(DWELL);
    expect(selectedTab().getAttribute('aria-label')).toBe('Title b');
    tick(DWELL);
    tick(DWELL);
    expect(selectedTab().getAttribute('aria-label')).toBe('Title a');
  });

  it('pauses under the pointer and finishes the dwell it had left once the pointer goes', () => {
    vi.useFakeTimers();
    const { hero } = renderHero();
    tick(DWELL * 0.6);
    fireEvent.pointerEnter(hero);
    expect(hero.dataset['rotating']).toBeUndefined();
    tick(DWELL * 5);
    expect(selectedTab().getAttribute('aria-label')).toBe('Title a');
    fireEvent.pointerLeave(hero);
    tick(DWELL * 0.3);
    expect(selectedTab().getAttribute('aria-label')).toBe('Title a');
    tick(DWELL * 0.11);
    expect(selectedTab().getAttribute('aria-label')).toBe('Title b');
  });

  it('stops turning and freezes the dial while the window is hidden or the hero is scrolled away (idle CPU)', () => {
    vi.useFakeTimers();
    let report: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
    const io = vi.fn(function (this: object, cb: (entries: { isIntersecting: boolean }[]) => void) {
      report = cb;
      return Object.assign(this, { observe() {}, disconnect() {} });
    });
    vi.stubGlobal('IntersectionObserver', io);
    let hidden = false;
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => (hidden ? 'hidden' : 'visible'));
    try {
      const { hero } = renderHero();
      const dial = () => hero.querySelector<HTMLElement>('[data-hero-dial]')!;
      expect(dial().style.animationPlayState).toBe('running');

      hidden = true;
      act(() => void document.dispatchEvent(new Event('visibilitychange')));
      expect(hero.dataset['rotating']).toBeUndefined();
      expect(dial().style.animationPlayState).toBe('paused');
      tick(DWELL * 5);
      expect(selectedTab().getAttribute('aria-label')).toBe('Title a');

      hidden = false;
      act(() => void document.dispatchEvent(new Event('visibilitychange')));
      act(() => report!([{ isIntersecting: false }]));
      expect(hero.dataset['rotating']).toBeUndefined();
      expect(dial().style.animationPlayState).toBe('paused');
      tick(DWELL * 5);
      expect(selectedTab().getAttribute('aria-label')).toBe('Title a');

      act(() => report!([{ isIntersecting: true }]));
      expect(hero.dataset['rotating']).toBe('true');
      tick(DWELL);
      expect(selectedTab().getAttribute('aria-label')).toBe('Title b');
    } finally {
      visibility.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('an automatic turn swaps the ticks without their main-thread width transition; a user change keeps it', () => {
    vi.useFakeTimers();
    renderHero();
    const tickBar = (label: string) => screen.getByRole('tab', { name: label }).firstElementChild!;
    expect(tickBar('Title a').className).toContain('motion-safe:transition-[width,background-color]');
    tick(DWELL);
    expect(selectedTab().getAttribute('aria-label')).toBe('Title b');
    for (const label of ['Title a', 'Title b', 'Title c']) expect(tickBar(label).className).not.toContain('transition');
    // The fill itself still runs (a transform, on the compositor).
    expect(tickBar('Title b').querySelector<HTMLElement>('[data-hero-dial]')!.className).toContain('motion-safe:animate-dial-fill');
    fireEvent.click(screen.getByTestId('hero-next'));
    expect(selectedTab().getAttribute('aria-label')).toBe('Title c');
    expect(tickBar('Title c').className).toContain('motion-safe:transition-[width,background-color]');
  });

  it('pauses while focus is inside, and the live region speaks only then', () => {
    vi.useFakeTimers();
    const { hero } = renderHero();
    const live = hero.querySelector('[aria-live]')!;
    expect(live.getAttribute('aria-live')).toBe('off');
    act(() => selectedTab().focus());
    expect(live.getAttribute('aria-live')).toBe('polite');
    tick(DWELL * 3);
    expect(selectedTab().getAttribute('aria-label')).toBe('Title a');
  });

  it('the rotation button stops and restarts the turning', () => {
    vi.useFakeTimers();
    const { hero } = renderHero();
    const toggle = screen.getByTestId('hero-rotation');
    expect(toggle.getAttribute('aria-label')).toBe('Pause slideshow');
    fireEvent.click(toggle);
    // Clicking moved focus inside; take it out to prove the user pause alone holds.
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    fireEvent.blur(hero, { relatedTarget: null });
    expect(toggle.getAttribute('aria-label')).toBe('Play slideshow');
    tick(DWELL * 3);
    expect(selectedTab().getAttribute('aria-label')).toBe('Title a');
    fireEvent.click(toggle);
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    fireEvent.blur(hero, { relatedTarget: null });
    tick(DWELL);
    expect(selectedTab().getAttribute('aria-label')).toBe('Title b');
  });

  it('never rotates under reduced motion, and the controls still move by hand', () => {
    stubReducedMotion(true);
    vi.useFakeTimers();
    const { hero } = renderHero();
    expect(hero.dataset['rotating']).toBeUndefined();
    expect(screen.queryByTestId('hero-rotation')).toBeNull();
    expect(hero.querySelector('[data-hero-dial]')!.className).not.toContain('animate-dial-fill');
    tick(DWELL * 5);
    expect(selectedTab().getAttribute('aria-label')).toBe('Title a');
    fireEvent.click(screen.getByTestId('hero-next'));
    expect(selectedTab().getAttribute('aria-label')).toBe('Title b');
  });

  it('previous and next wrap around', () => {
    renderHero();
    fireEvent.click(screen.getByTestId('hero-prev'));
    expect(selectedTab().getAttribute('aria-label')).toBe('Title c');
    fireEvent.click(screen.getByTestId('hero-next'));
    expect(selectedTab().getAttribute('aria-label')).toBe('Title a');
  });

  it('the tabs follow the arrows, Home and End, choose on the way and keep focus with the selection', () => {
    renderHero();
    const first = selectedTab();
    act(() => first.focus());
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(selectedTab().getAttribute('aria-label')).toBe('Title b');
    expect(document.activeElement).toBe(selectedTab());
    fireEvent.keyDown(selectedTab(), { key: 'End' });
    expect(selectedTab().getAttribute('aria-label')).toBe('Title c');
    fireEvent.keyDown(selectedTab(), { key: 'ArrowRight' });
    expect(selectedTab().getAttribute('aria-label')).toBe('Title a');
    fireEvent.keyDown(selectedTab(), { key: 'ArrowLeft' });
    expect(selectedTab().getAttribute('aria-label')).toBe('Title c');
    fireEvent.keyDown(selectedTab(), { key: 'Home' });
    expect(selectedTab().getAttribute('aria-label')).toBe('Title a');
    // Roving tab stop: only the selected tab is in the tab order.
    expect(screen.getAllByRole('tab').filter((t) => t.tabIndex === 0)).toEqual([selectedTab()]);
  });

  it('clicking a tick shows that slide', () => {
    renderHero();
    fireEvent.click(screen.getByRole('tab', { name: 'Title c' }));
    expect(screen.getByRole('tabpanel').getAttribute('aria-label')).toBe('3 of 3');
  });

  it('draws the backdrop through the image cache at high priority, and a tint when there is no artwork', () => {
    vi.useFakeTimers();
    const { hero } = renderHero([slide('a', { backdropUrl: 'https://img.test/a-wide.jpg' }), slide('b')]);
    const withArt = hero.querySelector('[data-hero-backdrop="s1|movie|a"]')!;
    const img = withArt.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(`/api/img?${new URLSearchParams({ url: 'https://img.test/a-wide.jpg', sourceId: 's1' })}`);
    expect(img.getAttribute('fetchpriority')).toBe('high');
    expect(img.getAttribute('loading')).toBe('eager');
    // The next slide's layer waits for an idle moment, then mounts ahead of its turn; with no artwork it is only a tint.
    expect(hero.querySelector('[data-hero-backdrop="s1|movie|b"]')).toBeNull();
    tick(500);
    const bare = hero.querySelector<HTMLElement>('[data-hero-backdrop="s1|movie|b"]')!;
    expect(bare).not.toBeNull();
    expect(bare.querySelector('img')).toBeNull();
    expect(bare.style.background).toContain('gradient');
  });

  it('preloads the next slide at idle at low priority', () => {
    vi.useFakeTimers();
    const { hero } = renderHero([slide('a'), slide('b', { backdropUrl: 'https://img.test/b-wide.jpg' })]);
    tick(500);
    const next = hero.querySelector('[data-hero-backdrop="s1|movie|b"]')!;
    const img = next.querySelector('img')!;
    expect(img.getAttribute('src')).toContain('/api/img?url=https%3A%2F%2Fimg.test%2Fb-wide.jpg');
    expect(img.getAttribute('fetchpriority')).toBe('low');
    expect(next.getAttribute('data-active')).toBeNull();
  });

  it('retries a broken backdrop directly, then falls back to the poster (also retried), then to the tint', () => {
    const { hero } = renderHero([slide('a', { backdropUrl: 'https://img.test/broken.jpg', posterUrl: 'https://img.test/a.jpg' })]);
    const layer = hero.querySelector('[data-hero-backdrop]')!;
    const src = () => layer.querySelector('img')?.getAttribute('src');
    expect(src()).toBe(`/api/img?${new URLSearchParams({ url: 'https://img.test/broken.jpg', sourceId: 's1' })}`);
    fireEvent.error(layer.querySelector('img')!);
    expect(src()).toBe('https://img.test/broken.jpg');
    fireEvent.error(layer.querySelector('img')!);
    expect(src()).toBe(`/api/img?${new URLSearchParams({ url: 'https://img.test/a.jpg', sourceId: 's1' })}`);
    // A poster standing in for the backdrop is the cheap quarter-size blur, never a full-size one.
    expect(layer.querySelector('img')!.getAttribute('data-hero-image')).toBe('poster');
    expect(layer.querySelector('img')!.className).toContain('scale-[4.4]');
    expect(layer.querySelector('img')!.className).not.toMatch(/blur-(2xl|3xl|xl|lg)/);
    fireEvent.error(layer.querySelector('img')!);
    expect(src()).toBe('https://img.test/a.jpg');
    fireEvent.error(layer.querySelector('img')!);
    expect(layer.querySelector('img')).toBeNull();
  });

  it('frosts the copy with a tint over a cheaply blurred copy of the backdrop, not a backdrop filter', () => {
    const { hero } = renderHero([slide('a', { backdropUrl: 'https://img.test/a-wide.jpg' })]);
    const layer = hero.querySelector('[data-hero-backdrop]')!;
    expect(layer.querySelector('[data-hero-frost-art]')).toBeNull();
    fireEvent.load(layer.querySelector('img')!);
    const art = layer.querySelector('[data-hero-frost-art] img')!;
    expect(art.getAttribute('src')).toBe(layer.querySelector('img')!.getAttribute('src'));
    expect(art.className).toContain('blur-md');
    expect(hero.innerHTML).not.toMatch(/backdrop-blur|glass-blur/);
  });

  it('titles a new arrival with titleBase like its detail page, and the year line follows what is shown', () => {
    const [base] = buildHeroSlides([], [vod('d', { title: 'Dune: Part Two (2024) [MULTI]', titleBase: 'Dune: Part Two', year: 2024 })]);
    expect(base).toMatchObject({ title: 'Dune: Part Two', year: 2024 });
    renderHero([base!]);
    let panel = screen.getByRole('tabpanel');
    expect(within(panel).getByRole('heading', { name: 'Dune: Part Two' })).toBeTruthy();
    expect(panel.textContent).not.toContain('[MULTI]');
    // The shown title has no year, so the facts line carries it (joinList wraps each fact in bidi isolates).
    expect(within(panel).getByText(/^\W*2024\W*$/)).toBeTruthy();
    cleanup();

    // No titleBase from the core: the raw title shows, and its year is not repeated below it.
    const [raw] = buildHeroSlides([], [vod('e', { title: 'Summer Static (2025)', year: 2025 })]);
    renderHero([raw!]);
    panel = screen.getByRole('tabpanel');
    expect(within(panel).getByRole('heading', { name: 'Summer Static (2025)' })).toBeTruthy();
    expect(within(panel).queryByText(/^\W*2025\W*$/)).toBeNull();
  });

  it('a single slide shows no slide controls and does not rotate', () => {
    const { hero } = renderHero([slide('a')]);
    expect(screen.queryByTestId('hero-controls')).toBeNull();
    expect(hero.dataset['rotating']).toBeUndefined();
    expect(screen.getByRole('tabpanel').getAttribute('aria-label')).toBe('1 of 1');
  });

  it('plays a movie slide and links to its details', () => {
    const { onPlay } = renderHero([slide('a'), slide('b')]);
    const panel = screen.getByRole('tabpanel');
    fireEvent.click(within(panel).getByRole('button', { name: 'Play' }));
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ key: 's1|movie|a' }));
    expect(within(panel).getByRole('link', { name: 'Details' }).getAttribute('href')).toBe('/s/s1/movie/a');
  });
});
