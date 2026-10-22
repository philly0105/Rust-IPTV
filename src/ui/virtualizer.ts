import { useVirtualizer, type ReactVirtualizer } from '@tanstack/react-virtual';

type VirtualizerOptions<S extends Element, I extends Element> = Parameters<typeof useVirtualizer<S, I>>[0];

/** Where a scroller is now, the way react-virtual reads it (RTL counts scrollLeft down from 0). */
function currentOffset(el: Element | null, horizontal: boolean | undefined, rtl: boolean | undefined): number {
  if (!el) return 0;
  return horizontal ? el.scrollLeft * (rtl ? -1 : 1) : el.scrollTop;
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
 */
export function useListVirtualizer<S extends Element, I extends Element = Element>(
  options: VirtualizerOptions<S, I>,
): ReactVirtualizer<S, I> {
  return useVirtualizer<S, I>({
    useFlushSync: false,
    ...options,
    initialOffset: options.initialOffset ?? (() => currentOffset(options.getScrollElement(), options.horizontal, options.isRtl)),
  });
}
