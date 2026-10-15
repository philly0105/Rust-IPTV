import { useRef, useState, type FocusEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { ItemRef, ItemSnapshot } from '@/api/types';
import { useMyListToggle } from '@/features/mylist/hooks/useMyListToggle';
import { useShortcut } from '@/shell';

export type MyListTarget = { itemRef: ItemRef; snapshot: ItemSnapshot };

/**
 * Whether focus is inside the host of the My List key (L1-vod-5). Spread `onFocus`/`onBlur` on the
 * host element and pass `focused` to `<MyListKey enabled>`.
 */
export function useMyListKeyFocus() {
  const [focused, setFocused] = useState(false);
  return {
    focused,
    onFocus: () => setFocused(true),
    onBlur: (e: FocusEvent<HTMLElement>) => {
      if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setFocused(false);
    },
  };
}

/**
 * S on a focused poster of a rail saves it to My List, or takes it off (L1-vod-5). A rail is one
 * Tab stop (roving tabindex), so the poster's corner toggle stays out of the Tab order and this key
 * is its keyboard path, as on the category grid. Like the grid, the key is bound only while the
 * host holds focus (`enabled`), so S keeps its other meanings elsewhere, and the `?` overlay lists
 * it while it applies (same description as the grid's, so it shows once).
 *
 * Render it only when the host has My List targets: the toggle needs the app's router and query
 * client, which a plain rail does not. `targetAt` maps a `data-grid-index` to its title.
 */
export function MyListKey({ enabled, targetAt }: { enabled: boolean; targetAt: (index: number) => MyListTarget | undefined }): null {
  const { t } = useTranslation('vod');
  const toggle = useMyListToggle();
  const targetRef = useRef(targetAt);
  targetRef.current = targetAt;

  useShortcut(
    's',
    (e) => {
      const from = e.target instanceof Element ? e.target : document.activeElement;
      const cell = from?.closest<HTMLElement>('[data-grid-index]');
      const index = Number(cell?.dataset['gridIndex']);
      const target = cell && Number.isInteger(index) ? targetRef.current(index) : undefined;
      if (target) void toggle(target.itemRef, target.snapshot);
    },
    { description: t('shortcutMyList'), area: 'Vod', enabled },
  );
  return null;
}
