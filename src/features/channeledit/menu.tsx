import { Eye, EyeOff, Pencil, RotateCcw } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { Channel } from '@/api/types';
import { comboKeys, type MenuAction } from '@/ui';

import { hideChannel, resetName, unhideChannel } from './actions';
import { findEdit, isEditable, prefetchSourceEdits, useDisplayName, useSourceEdits } from './edits';
import { openRenameDialog } from './store';

/** Combos bound by {@link useChannelEditShortcuts}, shown as menu hints. */
export const RENAME_COMBO = 'f2';
export const HIDE_COMBO = 'shift+delete';

const hint = (combo: string) => comboKeys(combo).join('+');

/**
 * Channel edit entries for a channel or station context menu (C2):
 * "Rename...", "Reset name" (only while renamed) and "Hide channel" (a toast
 * with Undo). A channel that is hidden already (the player's, or one opened
 * from the hidden list) offers "Unhide" instead. Null channel, or one that is
 * not live or radio, gives [].
 *
 * Whether a channel is renamed comes from the source's shared
 * `channels.edits` query; until it answers, "Reset name" is left out. The
 * array keeps its identity while nothing it shows changes, so callers can
 * memoize their menus on it.
 */
export function useChannelEditMenuItems(channel: Channel | null): MenuAction[] {
  const { t } = useTranslation('channels');
  const display = useDisplayName();
  const editable = channel !== null && isEditable(channel.ref);
  const edits = useSourceEdits(editable ? channel.ref.sourceId : undefined);
  const edit = editable ? findEdit(edits.data, channel.ref) : undefined;

  return useMemo((): MenuAction[] => {
    if (!channel || !editable) return [];
    const radio = channel.ref.contentType === 'radio';
    const target = { ref: channel.ref, name: display(channel.name) };
    const items: MenuAction[] = [
      {
        id: 'channel-rename',
        label: t('menuRename'),
        icon: <Pencil aria-hidden size={16} />,
        hint: hint(RENAME_COMBO),
        onSelect: () => {
          prefetchSourceEdits(channel.ref.sourceId);
          openRenameDialog(channel);
        },
      },
    ];
    if (edit?.name !== undefined) {
      items.push({
        id: 'channel-reset-name',
        label: t('menuResetName'),
        icon: <RotateCcw aria-hidden size={16} />,
        onSelect: () => void resetName(channel.ref, edit, display(edit.originalName), t),
      });
    }
    items.push(
      edit?.hidden
        ? {
            id: 'channel-unhide',
            label: t('menuUnhide'),
            icon: <Eye aria-hidden size={16} />,
            onSelect: () => void unhideChannel(target, t),
          }
        : {
            id: 'channel-hide',
            label: radio ? t('menuHideStation') : t('menuHide'),
            icon: <EyeOff aria-hidden size={16} />,
            hint: hint(HIDE_COMBO),
            onSelect: () => void hideChannel(target, t),
          },
    );
    return items;
  }, [channel, editable, edit, display, t]);
}
