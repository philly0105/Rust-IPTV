/**
 * "Add to multi-view" for channel context menus (contract C4). Imports `@/ui` directly, never
 * the slice's `deps.ts`, so a channel list that imports it does not pull in the shell.
 */

import type { TFunction } from 'i18next';
import { LayoutGrid } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, type NavigateFunction } from 'react-router';

import { sameRef } from '@/api/types';
import { toast, type MenuAction } from '@/ui';

import { addToWall, wallAccepts } from './addChannel';
import { MAX_TILES } from './layout';
import { MULTIVIEW_PATH, type MultiviewLocationState } from './paths';
import { useMultiviewStore } from './store';
import type { MultiviewChannelInput } from './types';

/** Runs the add and says what happened; exported for tests and for callers without a menu. */
export async function addFromMenu(
  ch: MultiviewChannelInput,
  navigate: NavigateFunction,
  t: TFunction<'multiview'>,
): Promise<void> {
  const r = await addToWall(ch);
  const open = { label: t('openMultiview'), onClick: () => void navigate(MULTIVIEW_PATH) };
  switch (r) {
    case 'added': {
      // The user stays on the list to add the next channel; the toast counts the wall and opens
      // it. One toast id, so a run of adds updates one toast instead of stacking them.
      const { tiles } = useMultiviewStore.getState();
      // Opening from here focuses the new tile, so a keyboard user lands on what they added.
      const key = tiles.find((x) => sameRef(x.ref, ch.ref))?.key;
      const state: MultiviewLocationState = key ? { focusTile: key } : {};
      toast({
        id: 'multiview-add',
        variant: 'success',
        title: t('toastAdded', { name: ch.title }),
        description: t('subtitle', { n: tiles.length, max: MAX_TILES }),
        action: { label: t('openMultiview'), onClick: () => void navigate(MULTIVIEW_PATH, { state }) },
      });
      return;
    }
    case 'duplicate':
      toast({ id: 'multiview-add', title: t('toastDuplicate', { name: ch.title }), action: open });
      return;
    case 'full':
      toast({ id: 'multiview-add', title: t('toastFull'), description: t('toastFullHint'), action: open });
      return;
    case 'unsupported':
      toast({ id: 'multiview-add', title: t('toastUnsupported') });
      return;
    case 'gateFailed':
      toast({ id: 'multiview-add', variant: 'error', title: t('toastGateFailed'), description: t('toastGateFailedHint') });
      return;
    case 'cancelled':
      // The PIN prompt was dismissed (or the gate already said why): nothing to add.
      return;
  }
}

/**
 * The menu action for `ch`. Disabled when there is no channel or it is not live TV (radio has
 * no picture). Selecting it puts the channel on the wall through the parental gate and says so
 * in a toast ("2 of 4 on the wall") that offers to open `/multiview`, so a wall is built
 * without leaving the list; a channel already up or a full wall gets a toast with the same way
 * to the wall.
 */
export function useMultiviewMenuItem(ch: MultiviewChannelInput | null): MenuAction {
  const { t } = useTranslation('multiview');
  const navigate = useNavigate();
  const accepted = wallAccepts(ch);
  // Callers build the input inline; its fields, not its identity, decide the action.
  const sourceId = ch?.ref.sourceId;
  const itemId = ch?.ref.itemId;
  const contentType = ch?.ref.contentType;
  const title = ch?.title;
  const logo = ch?.logo;
  const number = ch?.number;
  const categoryId = ch?.categoryId;

  return useMemo((): MenuAction => {
    const action: MenuAction = {
      id: 'multiview-add',
      label: t('menuAdd'),
      icon: <LayoutGrid aria-hidden size={16} />,
      disabled: !accepted,
      onSelect: () => undefined,
    };
    if (!accepted || sourceId === undefined || itemId === undefined || contentType === undefined) return action;
    const input: MultiviewChannelInput = { ref: { sourceId, contentType, itemId }, title: title ?? itemId };
    if (logo !== undefined) input.logo = logo;
    if (number !== undefined) input.number = number;
    if (categoryId !== undefined) input.categoryId = categoryId;
    return { ...action, onSelect: () => void addFromMenu(input, navigate, t) };
  }, [t, navigate, accepted, sourceId, itemId, contentType, title, logo, number, categoryId]);
}
