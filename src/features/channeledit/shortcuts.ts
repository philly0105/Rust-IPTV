import { useTranslation } from 'react-i18next';

import type { Channel } from '@/api/types';
import { useShortcut } from '@/shell/shortcuts';

import { hideChannel } from './actions';
import { isEditable, prefetchSourceEdits, useDisplayName } from './edits';
import { HIDE_COMBO, RENAME_COMBO } from './menu';
import { openRenameDialog } from './store';

/**
 * F2 renames and Shift+Delete hides the focused channel row (C2, C11). The
 * page passes the row that has focus, or undefined; the keys are bound only
 * while there is one, and never while typing (the search field keeps its own
 * Shift+Delete). A held Shift+Delete hides once, not row after row.
 * Registered under the Live area, so they join its entries in the `?`
 * overlay.
 *
 * A page can pass a function instead: the keys stay bound and it is asked
 * for the focused row when the key is pressed, so they keep working when
 * focus came back without a focus event a page could have tracked (a dialog
 * handing it back on close, L3-live-2). It answers undefined when no row has
 * focus; the key then does nothing.
 */
export function useChannelEditShortcuts(focused: Channel | undefined | (() => Channel | undefined)): void {
  const { t } = useTranslation('channels');
  const { t: tLive } = useTranslation('live');
  const display = useDisplayName();
  const resolve = typeof focused === 'function' ? focused : () => focused;
  const enabled = typeof focused === 'function' || (!!focused && isEditable(focused.ref));
  const area = tLive('shortcutArea');
  const target = (): Channel | undefined => {
    const ch = resolve();
    return ch && isEditable(ch.ref) ? ch : undefined;
  };

  useShortcut(
    RENAME_COMBO,
    (e) => {
      const ch = e.repeat ? undefined : target();
      if (!ch) return;
      // The dialog asks for the source's edits on mount: start them now, beside its code.
      prefetchSourceEdits(ch.ref.sourceId);
      openRenameDialog(ch);
    },
    { description: t('shortcutRename'), area, enabled },
  );
  useShortcut(
    HIDE_COMBO,
    (e) => {
      const ch = e.repeat ? undefined : target();
      if (!ch) return;
      void hideChannel({ ref: ch.ref, name: display(ch.name) }, t);
    },
    { description: t('shortcutHide'), area, enabled },
  );
}
