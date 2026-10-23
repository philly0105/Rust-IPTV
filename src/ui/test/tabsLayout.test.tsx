/**
 * P2-RAILS-5: a tab row reads no layout while it mounts. Its overflow fade and the reveal of the
 * selected tab wait for a ResizeObserver callback, which comes after the browser's own layout and
 * before paint; a read in the commit forced the new page's layout (search opens on its tabs).
 * jsdom has no layout: the test calls the observers back where the browser would have laid out.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Tabs } from '../Tabs';

const items = ['Top', 'Movies', 'Series', 'Channels', 'Programmes'].map((label) => ({ id: label.toLowerCase(), label }));

let callbacks: { cb: ResizeObserverCallback; targets: Element[] }[] = [];
const original = globalThis.ResizeObserver;
beforeEach(() => {
  callbacks = [];
  globalThis.ResizeObserver = class {
    private entry: { cb: ResizeObserverCallback; targets: Element[] };
    constructor(cb: ResizeObserverCallback) {
      this.entry = { cb, targets: [] };
      callbacks.push(this.entry);
    }
    observe(el: Element) {
      this.entry.targets.push(el);
    }
    unobserve() {}
    disconnect() {
      this.entry.targets = [];
    }
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = original;
});

/** Calls back every observer still watching something, as the browser does after its layout. */
function layOut() {
  for (const o of callbacks) {
    if (o.targets.length > 0) o.cb(o.targets.map((target) => ({ target }) as ResizeObserverEntry), {} as ResizeObserver);
  }
}

describe('P2-RAILS-5: Tabs measure after layout', () => {
  it('mounts on a later tab without reading layout, then fades the hidden edge and brings the tab into view', () => {
    const reads = [
      vi.spyOn(Element.prototype, 'scrollWidth', 'get'),
      vi.spyOn(Element.prototype, 'clientWidth', 'get'),
      vi.spyOn(Element.prototype, 'scrollLeft', 'get'),
      vi.spyOn(Element.prototype, 'getBoundingClientRect'),
    ];
    render(<Tabs items={items} value="programmes" onChange={() => {}} label="Kind" />);
    expect(reads.reduce((n, s) => n + s.mock.calls.length, 0)).toBe(0);

    const list = screen.getByRole('tablist');
    let left = 0;
    Object.defineProperty(list, 'scrollWidth', { configurable: true, value: 500 });
    Object.defineProperty(list, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(list, 'scrollLeft', { configurable: true, get: () => left, set: (v: number) => void (left = v) });
    const rect = (l: number, r: number) => ({ left: l, right: r, top: 0, bottom: 40, width: r - l, height: 40, x: l, y: 0, toJSON: () => ({}) }) as DOMRect;
    vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(function (this: Element) {
      if (this === list) return rect(0, 300);
      return this.textContent === 'Programmes' ? rect(380 - left, 460 - left) : rect(0, 0);
    });
    act(() => layOut());
    // The selected tab ends 24 px clear of the right edge's fade; both edges now hide tabs.
    expect(left).toBe(460 - (300 - 24));
    expect(list.style.maskImage).toContain('transparent 0');
    expect(list.style.maskImage).toContain('transparent 100%');
  });
});
