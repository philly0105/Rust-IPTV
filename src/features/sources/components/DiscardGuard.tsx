import { useEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { Button, Dialog } from '@/ui';

/** Deep equality for drafts: plain objects, arrays and primitives. No allocation, so a long pasted playlist costs one string compare. */
export function sameDraft(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.hasOwn(b, k) || !sameDraft((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/**
 * Keeps typed details from vanishing with a stray close (SS-1). `request` is what Escape, the
 * close button and Cancel call: with nothing changed it closes at once, otherwise it asks
 * "Discard changes?" first. The host also passes `dismissible={!dirty}` to its Dialog, so a click
 * on the dimmed backdrop (an activating click on the window in WebView2 lands there) does nothing
 * while there is something to lose. Parental group locks ask the same way (LockGroupsDialog).
 */
export function useDiscardGuard({ open, dirty, onClose, title }: { open: boolean; dirty: boolean; onClose: () => void; title?: string }): {
  request: () => void;
  prompt: ReactNode;
} {
  const { t } = useTranslation('sources');
  const [asking, setAsking] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) setAsking(false);
  }, [open]);

  const request = () => (dirty ? setAsking(true) : closeRef.current());
  // The prompt closes in its own commit first: closing both at once lets the prompt hand focus
  // back to a button of the dialog just as it leaves the page, and focus drops to <body>.
  const discard = () => {
    flushSync(() => setAsking(false));
    closeRef.current();
  };

  const prompt = asking ? (
    <Dialog
      open
      onClose={() => setAsking(false)}
      title={title ?? t('discardTitle')}
      description={t('discardText')}
      size="sm"
      testId="discard-prompt"
      footer={
        <>
          <Button variant="ghost" onClick={() => setAsking(false)} data-autofocus="" data-testid="discard-keep">
            {t('keepEditing')}
          </Button>
          <Button variant="danger" onClick={discard} data-testid="discard-confirm">
            {t('discard')}
          </Button>
        </>
      }
    />
  ) : null;
  return { request, prompt };
}

/**
 * Below sm a source dialog is a bottom sheet (SS-13, the Dialog's `sheet`), and its body gives the
 * fields the room the floating card's margins took.
 */
export const PHONE_SHEET_BODY = 'max-sm:px-4';
