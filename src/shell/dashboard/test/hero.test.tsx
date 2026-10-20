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
const { DIAL_TICK_MS, HERO_IDLE_ROUNDS, HERO_SWIPE_PX, HeroCarousel, dialFill, swipeStep } = await import('../HeroCarousel');
const { CardMenuContext } = await import('../cards');
type CardMenuRequest = import('../cards').CardMenuRequest;
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

  it("a continue slide's menu holds the rotation until it closes, though it draws outside the hero", () => {
    vi.useFakeTimers();
    const requests: CardMenuRequest[] = [];
    const slides = [slide('a', { kind: 'continue', position: position('a') }), slide('b'), slide('c')];
    const menuFor = vi.fn(() => [{ id: 'remove', label: 'Remove', onSelect: () => undefined }]);
    queryClient.clear();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <CardMenuContext.Provider value={(r) => requests.push(r)}>
            <HeroCarousel slides={slides} sourceName={() => 'Home IPTV'} canPlay={() => true} onPlay={vi.fn()} menuFor={menuFor} dwellMs={DWELL} />
          </CardMenuContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const hero = screen.getByTestId('dashboard-hero');
    // Only the continue slide has the button; a new arrival has nothing to remove or mark.
    expect(within(screen.getByTestId('hero-slide')).getByRole('button', { name: 'More actions for Title a' })).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('hero-slide')).getByRole('button', { name: 'More actions for Title a' }));
    expect(menuFor).toHaveBeenCalledWith(expect.objectContaining({ key: slides[0]!.key }));
    expect(requests.map((r) => r.label)).toEqual(['Title a']);
    // The menu took focus and the pointer away from the hero: it still holds still.
    fireEvent.blur(within(hero).getByRole('button', { name: 'More actions for Title a' }));
    fireEvent.pointerLeave(hero);
    expect(hero.dataset['rotating']).toBeUndefined();
    tick(DWELL * 3);
    expect(selectedTab().getAttribute('aria-label')).toBe('Title a');
    act(() => requests[0]!.onClose?.());
    expect(hero.dataset['rotating']).toBe('true');
    tick(DWELL);
    expect(selectedTab().getAttribute('aria-label')).toBe('Title b');
    expect(within(screen.getByTestId('hero-slide')).queryByRole('button', { name: /More actions/ })).toBeNull();
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
      const dial = () => hero.querySelector<HTMLElement>('[data-hero-dial]')!.style.transform;
      tick(DWELL * 0.4);
      expect(dial()).toBe('scaleX(0.4)');

      hidden = true;
      act(() => void document.dispatchEvent(new Event('visibilitychange')));
      expect(hero.dataset['rotating']).toBeUndefined();
      tick(DWELL * 5);
      expect(dial()).toBe('scaleX(0.4)');
      expect(selectedTab().getAttribute('aria-label')).toBe('Title a');

      hidden = false;
      act(() => void document.dispatchEvent(new Event('visibilitychange')));
      act(() => report!([{ isIntersecting: false }]));
      expect(hero.dataset['rotating']).toBeUndefined();
      tick(DWELL * 5);
      expect(dial()).toBe('scaleX(0.4)');
      expect(selectedTab().getAttribute('aria-label')).toBe('Title a');

      act(() => report!([{ isIntersecting: true }]));
      expect(hero.dataset['rotating']).toBe('true');
      // It finishes the dwell it had left.
      tick(DWELL * 0.6);
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
    // The fill itself restarts on the new tick.
    expect(tickBar('Title b').querySelector<HTMLElement>('[data-hero-dial]')!.style.transform).toBe('scaleX(0)');
    fireEvent.click(screen.getByTestId('hero-next'));
    expect(selectedTab().getAttribute('aria-label')).toBe('Title c');
    expect(tickBar('Title c').className).toContain('motion-safe:transition-[width,background-color]');
  });

  it('moves the dial a few times a second from a timer, never with a CSS animation (L3-perf-desktop-1)', () => {
    vi.useFakeTimers();
    const { hero } = renderHero();
    const dial = hero.querySelector<HTMLElement>('[data-hero-dial]')!;
    // A running animation of any size made the browser draw a frame per display refresh.
    expect(dial.className).not.toMatch(/animate-/);
    expect(dial.style.animationName).toBe('');
    expect(dial.style.transform).toBe('scaleX(0)');
    tick(DIAL_TICK_MS - 1);
    expect(dial.style.transform).toBe('scaleX(0)');
    tick(1);
    expect(dial.style.transform).toBe(`scaleX(${DIAL_TICK_MS / DWELL})`);
    tick(DIAL_TICK_MS);
    expect(dial.style.transform).toBe(`scaleX(${(2 * DIAL_TICK_MS) / DWELL})`);
    expect(dialFill(DWELL, DWELL)).toBe(0);
    expect(dialFill(0, DWELL)).toBe(1);
    expect(dialFill(-5, DWELL)).toBe(1);
  });

  it('pauses while the window is unfocused (a covered desktop window stays visible)', () => {
    vi.useFakeTimers();
    const { hero } = renderHero();
    act(() => void window.dispatchEvent(new Event('blur')));
    expect(hero.dataset['rotating']).toBeUndefined();
    tick(DWELL * 3);
    expect(selectedTab().getAttribute('aria-label')).toBe('Title a');
    act(() => void window.dispatchEvent(new Event('focus')));
    expect(hero.dataset['rotating']).toBe('true');
    tick(DWELL);
    expect(selectedTab().getAttribute('aria-label')).toBe('Title b');
  });

  it('rests after its idle rounds without input, and the next input resumes it', () => {
    vi.useFakeTimers();
    const { hero } = renderHero();
    const turns = HERO_IDLE_ROUNDS * THREE.length;
    // One turn per tick: each turn's next timer is set when React commits it.
    const turn = (n: number) => {
      for (let i = 0; i < n; i++) tick(DWELL);
    };
    // Input part way through starts the count again.
    turn(turns - 1);
    fireEvent.keyDown(window, { key: 'Shift' });
    turn(turns - 1);
    expect(hero.dataset['rotating']).toBe('true');
    turn(1);
    // Nobody is watching: the rotation rests on the slide it turned to.
    expect(hero.dataset['rotating']).toBeUndefined();
    const resting = selectedTab().getAttribute('aria-label');
    turn(5);
    expect(selectedTab().getAttribute('aria-label')).toBe(resting);
    // The rotation toggle still says the slideshow plays: only the user's own pause flips it.
    expect(screen.getByTestId('hero-rotation').getAttribute('aria-label')).toBe('Pause slideshow');
    fireEvent.pointerMove(window);
    expect(hero.dataset['rotating']).toBe('true');
    tick(DWELL);
    expect(selectedTab().getAttribute('aria-label')).not.toBe(resting);
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
    // The active tick is a full bar, not a fill that never moves.
    expect(hero.querySelector<HTMLElement>('[data-hero-dial]')!.style.transform).toBe('');
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

  it('a sideways swipe turns the slide on a touch screen; a short one, a scroll and a mouse drag do not', () => {
    const { hero } = renderHero();
    const swipe = (from: number, to: number, { type = 'touch', dy = 0 } = {}) => {
      fireEvent.pointerDown(hero, { pointerId: 1, pointerType: type, isPrimary: true, clientX: from, clientY: 100 });
      fireEvent.pointerUp(hero, { pointerId: 1, pointerType: type, isPrimary: true, clientX: to, clientY: 100 + dy });
    };
    const shown = () => selectedTab().getAttribute('aria-label');
    swipe(300, 200);
    expect(shown()).toBe('Title b');
    swipe(200, 300);
    expect(shown()).toBe('Title a');
    // Wraps like previous and next.
    swipe(200, 300);
    expect(shown()).toBe('Title c');
    swipe(300, 300 - HERO_SWIPE_PX + 1);
    swipe(300, 200, { dy: 160 });
    swipe(300, 200, { type: 'mouse' });
    expect(shown()).toBe('Title c');
    // Vertical scrolling and pinch zoom stay with the browser.
    expect(hero.className).toContain('[touch-action:pan-y_pinch-zoom]');
  });

  it('swipes the other way round in RTL', () => {
    expect(swipeStep(-100, 0, false)).toBe(1);
    expect(swipeStep(100, 0, false)).toBe(-1);
    expect(swipeStep(100, 0, true)).toBe(1);
    expect(swipeStep(-100, 0, true)).toBe(-1);
    expect(swipeStep(-100, 80, false)).toBe(0);
    expect(swipeStep(-(HERO_SWIPE_PX - 1), 0, false)).toBe(0);
  });

  it('a swipe that ends on Play does not press it; the next tap does', () => {
    vi.useFakeTimers();
    const { hero, onPlay } = renderHero();
    const play = within(screen.getByTestId('hero-slide')).getByRole('button', { name: 'Play' });
    fireEvent.pointerDown(play, { pointerId: 2, pointerType: 'touch', isPrimary: true, clientX: 300, clientY: 100 });
    fireEvent.pointerUp(play, { pointerId: 2, pointerType: 'touch', isPrimary: true, clientX: 150, clientY: 100 });
    fireEvent.click(play);
    expect(onPlay).not.toHaveBeenCalled();
    expect(selectedTab().getAttribute('aria-label')).toBe('Title b');
    tick(1000);
    const next = within(hero).getByTestId('hero-slide');
    fireEvent.click(within(next).getByRole('button', { name: 'Play' }));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it('under a coarse pointer the ticks and the pill buttons are 44 px targets; the drawn dot stays small', () => {
    renderHero();
    const targets = [...screen.getAllByRole('tab'), screen.getByTestId('hero-rotation'), screen.getByTestId('hero-next')];
    for (const el of targets) {
      expect(el.className).toContain('pointer-coarse:min-h-[calc(44rem/15)]');
      expect(el.className).toContain('pointer-coarse:min-w-[calc(44rem/15)]');
    }
    expect(screen.getAllByRole('tab')[1]!.querySelector('span')!.className).toContain('w-1.5');
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

  it('keeps the copy readable with glass gradients only: no blur over a backdrop and no backdrop filter (C5)', () => {
    const { hero } = renderHero([slide('a', { backdropUrl: 'https://img.test/a-wide.jpg' })]);
    const layer = hero.querySelector('[data-hero-backdrop]')!;
    fireEvent.load(layer.querySelector('img')!);
    // The backdrop is one sharp picture: no second, blurred copy of it.
    expect(layer.querySelectorAll('img')).toHaveLength(1);
    expect(layer.querySelector('img')!.className).not.toMatch(/blur/);
    expect(hero.innerHTML).not.toMatch(/backdrop-blur|glass-blur|hero-frost/);
    expect(hero.querySelector('[class*="from-glass-strong"]')).toBeTruthy();
  });

  it('a poster-only slide also shows its poster upright at the inline end, once it has loaded', () => {
    const { hero } = renderHero([slide('a', { posterUrl: 'https://img.test/upright.jpg' })]);
    const layer = hero.querySelector('[data-hero-backdrop]')!;
    expect(layer.querySelector('[data-hero-poster]')).toBeNull();
    fireEvent.load(layer.querySelector('img')!);
    const poster = layer.querySelector<HTMLImageElement>('[data-hero-poster]')!;
    expect(poster.getAttribute('src')).toBe(layer.querySelector('img')!.getAttribute('src'));
    expect(poster.className).toContain('lg:block');
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
