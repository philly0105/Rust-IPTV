import { Bookmark, BookmarkCheck, BookmarkPlus, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { itemKey, type ItemRef, type ItemSnapshot } from '@/api/types';

import type { MenuAction } from '../deps';
import { canSave } from '../lib/list';
import { useMyListState } from './useMyList';
import { useMyListToggle } from './useMyListToggle';

/**
 * "Add to My List" / "Remove from My List" for a context menu (the
 * `src/ui/Menu` MenuAction shape), with the same toasts and Undo as
 * MyListButton. `null` for no target or a live/radio ref, so callers can
 * spread it conditionally. Until the shared list has loaded the item is
 * disabled ("Checking My List…"); when it failed, the item reads it again
 * instead of toggling from an unknown state.
 */
export function useMyListMenuItem(target: { ref: ItemRef; snapshot: ItemSnapshot } | null): MenuAction | null {
  const { t } = useTranslation('mylist');
  const { keys, status, retry } = useMyListState();
  const toggle = useMyListToggle();
  if (!target || !canSave(target.ref)) return null;
  if (status === 'loading') {
    return { id: 'mylist', label: t('menuChecking'), icon: <Bookmark aria-hidden size={16} />, disabled: true, onSelect: () => undefined };
  }
  if (status === 'error') {
    return { id: 'mylist', label: t('menuRetry'), icon: <RefreshCw aria-hidden size={16} />, onSelect: () => void retry() };
  }
  const inList = keys.has(itemKey(target.ref));
  const Icon = inList ? BookmarkCheck : BookmarkPlus;
  return {
    id: 'mylist',
    label: inList ? t('menuRemove') : t('menuAdd'),
    icon: <Icon aria-hidden size={16} />,
    onSelect: () => void toggle(target.ref, target.snapshot),
  };
}
