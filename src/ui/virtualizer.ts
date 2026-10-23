import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { elementScroll, observeElementRect, useVirtualizer, type ReactVirtualizer, type Rect, type Virtualizer } from '@tanstack/react-virtual';

type VirtualizerOptions<S extends Element, I extends Element> = Parameters<typeof useVirtualizer<S, I>>[0];

/** Where a scroller is now, the way react-virtual reads it (RTL counts scrollLeft down from 0). */
function currentOffset(el: Element | null, horizontal: boolean | undefined, rtl: boolean | undefined): number {
  if (!el) return 0;
  return horizontal ? el.scrollLeft * (rtl ? -1 : 1) : el.scrollTop;
}

/** Per virtualizer whose ResizeObserver has not reported yet: takes its scroller's size now. */
const sizeNow = new WeakMap<object, () => void>();
/** Virtualizers whose scrolls take the size first (see {@link useListVirtualizer}). */
const sizedScrolls = new WeakSet<object>();

/**
 * The scroller's size for react-virtual without reading layout (P2-LIVE-1). react-virtual's own
 * `observeElementRect` reads offsetWidth and offsetHeight as the virtualizer attaches, in a layout
 * effect: right after the commit that mounted a page, that read forced the whole page's layout
 * (78 ms of Live's cold open at a 4x CPU slowdown), and the rows for the size it found rendered in
 * a second commit before the paint. This one keeps `initialRect` until the ResizeObserver's first
 * callback, which comes after the browser's own layout and so forces none. When that size shows
 * more of the list than `initialRect` did, the missing rows render inside the callback, before
 * the frame paints, so a list never paints short; when it shows less, the extra rows go with the
 * next render. Without a ResizeObserver it reads the size at once, as react-virtual does. A scroll
 * asked for before the first callback reads it then (P2-LIVE-5, see {@link useListVirtualizer}).
 */
export function observeElementRectAfterLayout<S extends Element, I extends Element>(
  instance: Virtualizer<S, I>,
  cb: (rect: Rect) => void,
): (() => void) | undefined {
  const element = instance.scrollElement;
  const Observer = instance.targetWindow?.ResizeObserver;
  if (!element || !Observer) return observeElementRect(instance, cb);
  sizeNow.set(instance, () => {
    sizeNow.delete(instance);
    cb({ width: (element as unknown as HTMLElement).offsetWidth, height: (element as unknown as HTMLElement).offsetHeight });
  });
  let first = true;
  const observer = new Observer((entries) => {
    sizeNow.delete(instance);
    const box = entries[0]?.borderBoxSize?.[0];
    const rect = box
      ? { width: Math.round(box.inlineSize), height: Math.round(box.blockSize) }
      : { width: (element as unknown as HTMLElement).offsetWidth, height: (element as unknown as HTMLElement).offsetHeight };
    const axis = instance.options.horizontal ? 'width' : 'height';
    const grows = first && rect[axis] > (instance.scrollRect ?? instance.options.initialRect)[axis];
    first = false;
    if (grows) flushSync(() => cb(rect));
    else cb(rect);
  });
  observer.observe(element, { box: 'border-box' });
  return () => {
    sizeNow.delete(instance);
    observer.disconnect();
  };
}

/**
 * The one way to virtualize a list or grid (SH-5). react-virtual 3.14 renders every range change
 * inside the scroll event through `flushSync` unless `useFlushSync: false`; here a scroll renders
 * with the next commit instead, so a fling is not a string of synchronous renders. Pass
 * `useFlushSync: true` only for a list that must paint inside the event. Importing
 * `useVirtualizer` anywhere else fails `virtualizer-budget.test.ts`.
 *
 * Without an `initialOffset` the virtualizer starts where its scroller is now. react-virtual
 * starts from `initialOffset` (0 by default) and scrolls its element there when it mounts, so a
 * list that opens under other content of an already scrolled page (the VOD landing's category
 * index, a series' episodes) sent the whole page back to the top.
 *
 * Mounting reads no layout (P2-LIVE-1): the size comes from {@link observeElementRectAfterLayout},
 * and until then from `initialRect`, else the window's, which no scroller in the app exceeds. The
 * scroll to `initialOffset` as the virtualizer first attaches, which forces layout like a read,
 * is left out when the scroller is known to be there: one created in that commit is at 0, and the
 * default offset is the one just read from it.
 *
 * A `scrollToIndex` or `scrollToOffset` before the ResizeObserver's first report reads the
 * scroller's size first (P2-LIVE-5). Aligned against the seed, the live list opening on the
 * playing channel left that row under the list's bottom edge until the report came. The scroll
 * lays the page out anyway (react-virtual reads `scrollHeight` to clamp it, and the write itself
 * does), so the read adds no layout.
 */
export function useListVirtualizer<S extends Element, I extends Element = Element>(
  options: VirtualizerOptions<S, I>,
): ReactVirtualizer<S, I> {
  const [windowRect] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  /** Where the scroller is when the virtualizer first attaches, if known without asking it. */
  const known = useRef<{ el: S | null; offset: number } | null>(null);
  const mounted = useRef(false);
  const virtualizer = useVirtualizer<S, I>({
    useFlushSync: false,
    observeElementRect: observeElementRectAfterLayout,
    scrollToFn: (offset, opts, instance) => {
      const at = known.current;
      known.current = null;
      const attaching = opts.adjustments === undefined && opts.behavior === undefined;
      if (at && attaching && offset === at.offset && (at.el === null || at.el === instance.scrollElement)) return;
      elementScroll(offset, opts, instance);
    },
    ...options,
    initialRect: options.initialRect ?? windowRect,
    initialOffset: () => {
      const el = options.getScrollElement();
      const given = options.initialOffset;
      const offset = given === undefined ? currentOffset(el, options.horizontal, options.isRtl) : typeof given === 'function' ? given() : given;
      if (!mounted.current) known.current = el === null ? { el, offset: 0 } : given === undefined ? { el, offset } : null;
      return offset;
    },
  });
  if (!sizedScrolls.has(virtualizer)) {
    sizedScrolls.add(virtualizer);
    const { scrollToIndex, scrollToOffset } = virtualizer;
    virtualizer.scrollToIndex = (...args) => {
      sizeNow.get(virtualizer)?.();
      scrollToIndex(...args);
    };
    virtualizer.scrollToOffset = (...args) => {
      sizeNow.get(virtualizer)?.();
      scrollToOffset(...args);
    };
  }
  // After react-virtual's own layout effects: the first attach, if any, is over.
  useLayoutEffect(() => {
    mounted.current = true;
    known.current = null;
  }, []);
  return virtualizer;
}
