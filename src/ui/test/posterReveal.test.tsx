/**
 * L2-sources-home-1 / L1-perf-2: an out-of-view placeholder (a lazy poster
 * past a rail's edge never loads) and an out-of-view live dot stop animating.
 * L2-perf-desktop-9: a cached poster shows at once; only a slow load fades.
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { LiveBadge } from '@/ui/Misc';
import { forgetRevealedPosters, INSTANT_REVEAL_MS, Poster } from '@/ui/Poster';
import { OFFSCREEN_ATTR, resetOffscreenObserver } from '@/ui/offscreen';

type Cb = (entries: { target: Element; isIntersecting: boolean }[]) => void;

class FakeIO {
  static last: FakeIO | null = null;
  readonly observed = new Set<Element>();
  constructor(readonly cb: Cb) {
    FakeIO.last = this;
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

beforeEach(() => {
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
    const io = FakeIO.last!;
    expect(io.observed.has(ph)).toBe(true);
    io.show(ph, true);
    expect(ph.hasAttribute(OFFSCREEN_ATTR)).toBe(false);
    io.show(ph, false);
    expect(ph.hasAttribute(OFFSCREEN_ATTR)).toBe(true);
    fireEvent.load(container.querySelector('img')!);
    expect(placeholder(container)).toBeNull();
    expect(io.observed.size).toBe(0);
  });

  it('the live dot pauses out of view and stops being watched on unmount', () => {
    const { container, unmount } = render(<LiveBadge />);
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
  const fadeClasses = (img: HTMLImageElement) => img.className.split(/\s+/).filter((c) => /transition|duration/.test(c));

  it('a load right after mounting (a cache hit) shows at once, without the fade', () => {
    const { container } = render(<Poster src="http://cdn.example/hit.jpg" alt="Hit" />);
    const img = container.querySelector('img')!;
    fireEvent.load(img);
    expect(img.dataset.posterState).toBe('loaded');
    expect(img.className).toContain('opacity-100');
    expect(fadeClasses(img)).toEqual([]);
  });

  it('a slow load fades in over 150 ms; the same picture remounted later shows at once', () => {
    let now = 5000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const first = render(<Poster src="http://cdn.example/slow.jpg" alt="Slow" />);
    now += INSTANT_REVEAL_MS + 400;
    const img = first.container.querySelector('img')!;
    fireEvent.load(img);
    expect(fadeClasses(img)).toEqual(['motion-safe:transition-opacity', 'motion-safe:duration-150']);
    first.unmount();

    const again = render(<Poster src="http://cdn.example/slow.jpg" alt="Slow" />);
    now += 5000;
    const img2 = again.container.querySelector('img')!;
    fireEvent.load(img2);
    expect(fadeClasses(img2)).toEqual([]);
  });

  it('a picture already decoded when it mounts is shown in the same commit', () => {
    const complete = vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
    const width = vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(342);
    const { container } = render(<Poster src="http://cdn.example/decoded.jpg" alt="Decoded" />);
    const img = container.querySelector('img')!;
    expect(img.dataset.posterState).toBe('loaded');
    expect(fadeClasses(img)).toEqual([]);
    expect(placeholder(container)).toBeNull();
    complete.mockRestore();
    width.mockRestore();
  });
});
