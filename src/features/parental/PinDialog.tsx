import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Dialog } from '@/ui';

import { useFocusPinOnPanel } from './focus';
import { PinField } from './PinField';
import { PinMessage, usePinFeedback } from './PinFeedback';
import { isValidPin } from './pin';

export interface PinDialogProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  /** Muted line under the keypad (how long an unlock lasts). */
  footnote?: ReactNode;
  /** Label of the confirm button. Default "Continue". */
  confirmLabel?: string;
  /** Confirm styled as destructive (turning controls off). */
  danger?: boolean;
  /**
   * Runs the command with the PIN. Rejects with the core's error: `auth` is a
   * wrong PIN, `conflict` the lockout. The parent closes the dialog once it resolves.
   */
  onSubmit: (pin: string) => Promise<void>;
  onCancel: () => void;
  testId?: string;
}

/**
 * Asks for the parental PIN once (C2). Shows a wrong PIN with the tries left,
 * and the wrong-PIN lockout as a countdown with the field locked; Escape,
 * the backdrop and Cancel all cancel.
 */
export function PinDialog({ open, title, description, footnote, confirmLabel, danger, onSubmit, onCancel, testId = 'pin-dialog' }: PinDialogProps) {
  const { t } = useTranslation('parental');
  const formId = useId();
  const messageId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pin, setPin] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const feedback = usePinFeedback(() => inputRef.current?.focus());
  useFocusPinOnPanel(inputRef);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || feedback.lockedOut) return;
    if (!isValidPin(pin)) {
      feedback.show({ kind: 'invalid' });
      return;
    }
    setBusy(true);
    try {
      await onSubmit(pin);
      feedback.show(null);
    } catch (err) {
      setPin('');
      await feedback.fail(err);
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      size="sm"
      testId={testId}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            form={formId}
            variant={danger ? 'danger' : 'primary'}
            loading={busy}
            disabled={feedback.lockedOut}
            data-testid={`${testId}-submit`}
          >
            {confirmLabel ?? t('continue')}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={(e) => void submit(e)} className="flex flex-col items-center gap-4 pt-1">
        <PinField
          value={pin}
          onChange={(v) => {
            setPin(v);
            if (feedback.failure && !feedback.lockedOut) feedback.show(null);
          }}
          label={t('pin')}
          describedBy={messageId}
          invalid={!!feedback.failure && !feedback.lockedOut}
          disabled={feedback.lockedOut}
          revealed={revealed}
          onRevealedChange={setRevealed}
          inputRef={inputRef}
          slotsRef={feedback.slotsRef}
          autoFocus
          message={<PinMessage id={messageId} feedback={feedback} />}
          testId={`${testId}-field`}
        />
        {footnote ? <p className="max-w-xs text-center text-[calc(13rem/15)] text-fg-subtle">{footnote}</p> : null}
      </form>
    </Dialog>
  );
}
