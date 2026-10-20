/**
 * L2-sources-home-1 / L1-perf-2: an out-of-view placeholder (a lazy poster
 * past a rail's edge never loads) and an out-of-view live dot stop animating.
 * L2-perf-desktop-9: a cached poster shows at once; only a slow load fades.
 * L3-perf-ui-7: the reveal is written on the DOM (data-poster-state, data-instant) and the
 * placeholder is hidden there, so a loading picture never re-renders the Poster.
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { LivePill } from '@/ui/Misc';
import { forgetRevealedPosters, INSTANT_REVEAL_MS, Poster } from '@/ui/Poster';
import { OFFSCREEN_ATTR, resetOffscreenObserver } from '@/ui/offscreen';

type Cb = (entries: { target: Element; isIntersecting: boolean }[]) => void;

class FakeIO {
  static last: FakeIO | null = null;
  /** Every observer made: offscreen.ts and the image gate (imageGate.ts) each make one. */
  static all: FakeIO[] = [];
  readonly observed = new Set<Element>();
  constructor(readonly cb: Cb) {
    FakeIO.last = this;
    FakeIO.all.push(this);
  }
  observe(el: Element) {
    this.observed.add(el);
  }
  unobserve(el: Element) {
    this.observed.delete(el);
  }
  disconnect() {
    this.observed.clear();
  }
  show(el: Element, isIntersecting: boolean) {
    act(() => this.cb([{ target: el, isIntersecting }]));
  }
}

/** The observer watching `el` (the offscreen observer for a placeholder). */
const ioFor = (el: Element) => FakeIO.all.find((io) => io.observed.has(el))!;

beforeEach(() => {
  FakeIO.all = [];
  vi.stubGlobal('IntersectionObserver', FakeIO);
  resetOffscreenObserver();
  forgetRevealedPosters();
});
afterEach(() => {
  cleanup();
  resetOffscreenObserver();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const placeholder = (c: HTMLElement) => c.querySelector<HTMLElement>('[class*="animate-shimmer"]');

describe('offscreen loops', () => {
  it('a loading poster starts paused, shimmers only while in view, and is released when it loads', () => {
    const { container } = render(<Poster src="http://cdn.example/rail-9.jpg" alt="Nine" />);
    const ph = placeholder(container)!;
    expect(ph.hasAttribute(OFFSCREEN_ATTR)).toBe(true);
    const io = ioFor(ph);
    expect(io).toBeDefined();
    io.show(ph, true);
    expect(ph.hasAttribute(OFFSCREEN_ATTR)).toBe(false);
    io.show(ph, false);
    expect(ph.hasAttribute(OFFSCREEN_ATTR)).toBe(true);
    fireEvent.load(container.querySelector('img')!);
    expect(placeholder(container)!.hidden).toBe(true);
    expect(io.observed.size).toBe(0);
  });

  it('the live dot pauses out of view and stops being watched on unmount', () => {
    const { container, unmount } = render(<LivePill />);
    const dot = container.querySelector('[class*="animate-live-pulse"]')!;
    const io = FakeIO.last!;
    expect(dot.hasAttribute(OFFSCREEN_ATTR)).toBe(true);
    io.show(dot, true);
    expect(dot.hasAttribute(OFFSCREEN_ATTR)).toBe(false);
    unmount();
    expect(io.observed.size).toBe(0);
  });

  it('without IntersectionObserver nothing is marked', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    resetOffscreenObserver();
    const { container } = render(<Poster src="http://cdn.example/plain.jpg" alt="Plain" />);
    expect(placeholder(container)!.hasAttribute(OFFSCREEN_ATTR)).toBe(false);
  });
});

describe('poster reveal', () => {
  // The fade classes are always on the <img>, scoped to :not([data-instant]).
  const fades = (img: HTMLImageElement) => img.dataset.posterState === 'loaded' && !('instant' in img.dataset);

  it('a load right after mounting (a cache hit) shows at once, without the fade', () => {
    const { container } = render(<Poster src="http://cdn.example/hit.jpg" alt="Hit" />);
    const img = container.querySelector('img')!;
    fireEvent.load(img);
    expect(img.dataset.posterState).toBe('loaded');
    expect(img.className).toContain('data-[poster-state=loaded]:opacity-100');
    expect(fades(img)).toBe(false);
  });

  it('a slow load fades in over 150 ms; the same picture remounted later shows at once', () => {
    let now = 5000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const first = render(<Poster src="http://cdn.example/slow.jpg" alt="Slow" />);
    now += INSTANT_REVEAL_MS + 400;
    const img = first.container.querySelector('img')!;
    fireEvent.load(img);
    expect(fades(img)).toBe(true);
    expect(img.className).toContain('motion-safe:not-data-instant:duration-150');
    first.unmount();

    const again = render(<Poster src="http://cdn.example/slow.jpg" alt="Slow" />);
    now += 5000;
    const img2 = again.container.querySelector('img')!;
    fireEvent.load(img2);
    expect(fades(img2)).toBe(false);
  });

  it('a picture arriving re-renders nothing (L3-perf-ui-7)', () => {
    const renders = vi.fn();
    function Probe() {
      renders();
      return <Poster src="http://cdn.example/commit.jpg" alt="Commit" />;
    }
    const { container } = render(<Probe />);
    const count = renders.mock.calls.length;
    fireEvent.load(container.querySelector('img')!);
    expect(renders.mock.calls.length).toBe(count);
    expect(container.querySelector('img')!.dataset.posterState).toBe('loaded');
  });

  it('a picture already decoded when it mounts is shown in the same commit', () => {
    const complete = vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
    const width = vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(342);
    const { container } = render(<Poster src="http://cdn.example/decoded.jpg" alt="Decoded" />);
    const img = container.querySelector('img')!;
    expect(img.dataset.posterState).toBe('loaded');
    expect(fades(img)).toBe(false);
    expect(placeholder(container)!.hidden).toBe(true);
    complete.mockRestore();
    width.mockRestore();
  });
});
