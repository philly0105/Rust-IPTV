import { useTranslation } from 'react-i18next';

import { Dialog } from '@/ui';

import { useShellStore } from './store';

/**
 * Inline-end context panel (right in LTR, left in RTL). Inline column on wide windows; on narrower ones a
 * modal drawer toggled from the header. The drawer is the shared Dialog
 * primitive (`placement="end"`), so it traps focus, closes on Escape or the
 * scrim, and hands focus back to the header toggle when it closes.
 */
export function ContextPanel({ inline }: { inline: boolean }) {
  const { t } = useTranslation('shell');
  const node = useShellStore((s) => s.contextPanel);
  const open = useShellStore((s) => s.panelOpen);
  const setOpen = useShellStore((s) => s.setPanelOpen);

  if (node === null) return null;

  if (inline) {
    return (
      <aside
        aria-label={t('contextPanel')}
        data-testid="context-panel"
        // overscroll-contain: scrolling the panel to its end does not start scrolling the page behind it.
        className="w-(--panel-width) shrink-0 overflow-y-auto overscroll-contain border-s border-divider bg-surface"
      >
        {node}
      </aside>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title={t('contextPanel')}
      hideTitle
      placement="end"
      testId="context-panel"
      bodyClassName="p-0"
    >
      {node}
    </Dialog>
  );
}
