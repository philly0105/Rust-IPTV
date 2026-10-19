import { useVirtualizer, type ReactVirtualizer } from '@tanstack/react-virtual';

type VirtualizerOptions<S extends Element, I extends Element> = Parameters<typeof useVirtualizer<S, I>>[0];

/**
 * The one way to virtualize a list or grid (SH-5). react-virtual 3.14 renders every range change
 * inside the scroll event through `flushSync` unless `useFlushSync: false`; here a scroll renders
 * with the next commit instead, so a fling is not a string of synchronous renders. Pass
 * `useFlushSync: true` only for a list that must paint inside the event. Importing
 * `useVirtualizer` anywhere else fails `virtualizer-budget.test.ts`.
 */
export function useListVirtualizer<S extends Element, I extends Element = Element>(
  options: VirtualizerOptions<S, I>,
): ReactVirtualizer<S, I> {
  return useVirtualizer<S, I>({ useFlushSync: false, ...options });
}
