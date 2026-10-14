import { useTranslation } from 'react-i18next';

import type { Channel } from '@/api/types';
import { useShortcut } from '@/shell/shortcuts';

import { hideChannel } from './actions';
import { isEditable, useDisplayName } from './edits';
import { HIDE_COMBO, RENAME_COMBO } from './menu';
import { openRenameDialog } from './store';

/**
 * F2 renames and Shift+Delete hides the focused channel row (C2, C11). The
 * Live page passes the row that has focus, or undefined; the keys are bound
 * only while there is one, and never while typing (the search field keeps
 * its own Shift+Delete). A held Shift+Delete hides once, not row after row.
 * Registered under the Live area, so they join its entries in the `?`
 * overlay.
 */
export function useChannelEditShortcuts(focused: Channel | undefined): void {
  const { t } = useTranslation('channels');
  const { t: tLive } = useTranslation('live');
  const display = useDisplayName();
  const enabled = !!focused && isEditable(focused.ref);
  const area = tLive('shortcutArea');

  useShortcut(
    RENAME_COMBO,
    (e) => {
      if (e.repeat || !focused) return;
      openRenameDialog(focused);
    },
    { description: t('shortcutRename'), area, enabled },
  );
  useShortcut(
    HIDE_COMBO,
    (e) => {
      if (e.repeat || !focused) return;
      void hideChannel({ ref: focused.ref, name: display(focused.name) }, t);
    },
    { description: t('shortcutHide'), area, enabled },
  );
}
