import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/ui';

import { useShellStore } from './store';

/**
 * Right-hand context panel. Inline column on wide windows; on narrower ones a
 * drawer toggled from the header, closed by Escape or the scrim.
 */
export function ContextPanel({ inline }: { inline: boolean }) {
  const { t } = useTranslation('shell');
  const node = useShellStore((s) => s.contextPanel);
  const open = useShellStore((s) => s.panelOpen);
  const setOpen = useShellStore((s) => s.setPanelOpen);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!inline && open) ref.current?.focus();
  }, [inline, open]);

  if (node === null) return null;

  if (inline) {
    return (
      <aside
        aria-label={t('contextPanel')}
        data-testid="context-panel"
        className="w-(--panel-width) shrink-0 overflow-y-auto border-l border-border bg-surface"
      >
        {node}
      </aside>
    );
  }

  if (!open) return null;
  return (
    <>
      <div aria-hidden className="fixed inset-0 z-30 bg-scrim motion-safe:animate-fade-in" onClick={() => setOpen(false)} />
      <aside
        ref={ref}
        tabIndex={-1}
        aria-label={t('contextPanel')}
        data-testid="context-panel"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className={cn(
          'fixed top-0 right-0 bottom-0 z-40 flex w-[min(var(--panel-width),90vw)] flex-col border-l border-border bg-surface shadow-2',
          'motion-safe:animate-fade-in',
        )}
      >
        <div className="flex h-(--header-height) shrink-0 items-center justify-end border-b border-border px-3">
          <button
            type="button"
            aria-label={t('hideDetails')}
            onClick={() => setOpen(false)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2 hover:text-fg"
          >
            <X aria-hidden size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{node}</div>
      </aside>
    </>
  );
}
