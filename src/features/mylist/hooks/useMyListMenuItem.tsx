import { BookmarkCheck, BookmarkPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { itemKey, type ItemRef, type ItemSnapshot } from '@/api/types';

import type { MenuAction } from '../deps';
import { canSave } from '../lib/list';
import { useMyListKeys } from './useMyList';
import { useMyListToggle } from './useMyListToggle';

/**
 * "Add to My List" / "Remove from My List" for a context menu (the
 * `src/ui/Menu` MenuAction shape), with the same toasts and Undo as
 * MyListButton. `null` for no target or a live/radio ref, so callers can
 * spread it conditionally.
 */
export function useMyListMenuItem(target: { ref: ItemRef; snapshot: ItemSnapshot } | null): MenuAction | null {
  const { t } = useTranslation('mylist');
  const keys = useMyListKeys();
  const toggle = useMyListToggle();
  if (!target || !canSave(target.ref)) return null;
  const inList = keys.has(itemKey(target.ref));
  const Icon = inList ? BookmarkCheck : BookmarkPlus;
  return {
    id: 'mylist',
    label: inList ? t('menuRemove') : t('menuAdd'),
    icon: <Icon aria-hidden size={16} />,
    onSelect: () => void toggle(target.ref, target.snapshot),
  };
}
