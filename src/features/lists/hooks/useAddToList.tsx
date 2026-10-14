/**
 * The two ways in to the picker from a channel: a context-menu action and
 * the `l` key on a focused channel row.
 */

import { ListPlus } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import type { Channel } from '@/api/types';

import type { MenuAction } from '../deps';
import { canList } from '../lib/cache';
import { openListPicker } from '../store';

/** "Add to list…" for a channel's menu; null for anything that is not a live channel or radio station. */
export function useAddToListMenuItem(channel: Channel | null): MenuAction | null {
  const { t } = useTranslation('lists');
  return useMemo(() => {
    if (!channel || !canList(channel.ref)) return null;
    return {
      id: 'lists.addTo',
      label: t('addToList'),
      icon: <ListPlus className="size-4" aria-hidden />,
      onSelect: () => openListPicker(channel),
    };
  }, [channel, t]);
}

/** The Live channel list's rows (ChannelList.tsx). */
const ROW_SELECTOR = '[data-testid="channel-list"] [data-row-index]';

/**
 * `l` on a focused channel row opens the picker for that row's channel.
 *
 * Bound on the document rather than through the shortcut registry: `l` is
 * also the player's "seek forward", and the registry never falls through to
 * an older entry. This listener runs before the registry's (document before
 * window in the bubble phase) and only claims the key while focus is on a
 * channel row, so everywhere else `l` keeps its playback meaning.
 *
 * `resolve` maps the row's `data-row-index` to its channel, so a press right
 * after an arrow key acts on the row under focus even before `focused`
 * (reported by ChannelList once the cursor settles) catches up.
 */
export function useAddToListShortcut(focused: Channel | undefined, resolve?: (rowIndex: number) => Channel | undefined): void {
  const latest = useRef({ focused, resolve });
  latest.current = { focused, resolve };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.repeat) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== 'l' && e.code !== 'KeyL') return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      const row = target.closest<HTMLElement>(ROW_SELECTOR);
      if (!row || document.querySelector('[aria-modal="true"]')) return;
      const index = Number(row.dataset.rowIndex);
      const { focused: current, resolve: lookup } = latest.current;
      const channel = (Number.isFinite(index) ? lookup?.(index) : undefined) ?? current;
      if (!channel || !canList(channel.ref)) return;
      e.preventDefault();
      e.stopPropagation();
      openListPicker(channel);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
}
