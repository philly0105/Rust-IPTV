import { useCallback, useState, type FocusEvent } from 'react';

/**
 * Whether keyboard or pointer focus has gone into the channel list (`[data-testid="channel-list"]`)
 * since the list `key` opened. Until then the list's cursor row is not marked, so the idle stage
 * and the ribbon under it describe the channel last watched; from then on they follow the cursor.
 * It stays true when focus moves on (to the ribbon's buttons, say), so the column does not jump
 * back while the user acts on the row they picked. A new list (search, group, source) resets it.
 *
 * Put the returned handler on an ancestor of the list as `onFocus` (React's focus events bubble).
 */
export function useListEngaged(key: string): [boolean, (e: FocusEvent) => void] {
  const [engagedKey, setEngagedKey] = useState<string | null>(null);
  const onFocus = useCallback(
    (e: FocusEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-testid="channel-list"]')) setEngagedKey(key);
    },
    [key],
  );
  return [engagedKey === key, onFocus];
}
