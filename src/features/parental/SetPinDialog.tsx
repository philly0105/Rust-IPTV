import { KeyRound } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { rpc, RpcError } from '@/api/transport';
import type { ParentalStatus } from '@/api/types';
import { Button, Dialog } from '@/ui';

import { useFocusPinOnPanel } from './focus';
import { PinField } from './PinField';
import { PinMessage, usePinFeedback } from './PinFeedback';
import { isValidPin, isWeakPin } from './pin';
import { applyStatus } from './status';

type Step = 'current' | 'new' | 'confirm';

export interface SetPinDialogProps {
  open: boolean;
  /** `first` sets the first PIN (turns controls on); `change` asks for the current PIN too. */
  mode: 'first' | 'change';
  /** Runs after the core accepted the PIN, with its new status (already in the cache). */
  onDone: (status: ParentalStatus) => void;
  onCancel: () => void;
  testId?: string;
}

/**
 * Sets the first PIN or changes it (C2 `parental.setPin`): the current PIN
 * (when changing), a new one, and the new one again.
 *
 * The core only checks the current PIN when the change is sent, so a wrong
 * one sends the dialog back to that step with the new PIN kept: entering the
 * right PIN then finishes at once. The lockout after repeated wrong PINs
 * shows on that step as a countdown.
 */
export function SetPinDialog({ open, mode, onDone, onCancel, testId = 'set-pin-dialog' }: SetPinDialogProps) {
  const { t } = useTranslation('parental');
  const formId = useId();
  const messageId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const steps: Step[] = mode === 'change' ? ['current', 'new', 'confirm'] : ['new', 'confirm'];
  const [step, setStep] = useState<Step>(steps[0]!);
  const [values, setValues] = useState<Record<Step, string>>({ current: '', new: '', confirm: '' });
  /** The confirmed new PIN, kept while a wrong current PIN is re-entered. */
  const [pending, setPending] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const feedback = usePinFeedback(() => inputRef.current?.focus());
  useFocusPinOnPanel(inputRef);

  const value = values[step];
  const index = steps.indexOf(step);
  const last = step === 'confirm' || (step === 'current' && pending !== null);
  const lockedHere = feedback.lockedOut && step === 'current';

  // Each step starts with the cursor in the field.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, step]);

  const go = (next: Step, keep?: Partial<Record<Step, string>>) => {
    setValues((v) => ({ ...v, [next]: '', ...keep }));
    setStep(next);
  };

  const send = async (currentPin: string | undefined, newPin: string) => {
    setBusy(true);
    try {
      // A first PIN also unlocks the session, so the user who just set it can go on configuring without typing it again.
      const status = await rpc('parental.setPin', currentPin === undefined ? { newPin, unlock: true } : { currentPin, newPin });
      applyStatus(status);
      onDone(status);
    } catch (err) {
      const code = RpcError.from(err).code;
      if (code === 'auth' || code === 'conflict') {
        // The current PIN was refused: ask for it again, keep the new one.
        setPending(newPin);
        go('current');
        await feedback.fail(err);
      } else if (code === 'invalid') {
        setPending(null);
        go('new', { confirm: '' });
        feedback.show({ kind: 'invalid' });
      } else {
        await feedback.fail(err);
      }
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || lockedHere) return;
    if (!isValidPin(value)) {
      feedback.show({ kind: 'invalid' });
      return;
    }
    feedback.show(null);
    if (step === 'current') {
      if (pending !== null) await send(value, pending);
      else go('new');
      return;
    }
    if (step === 'new') {
      go('confirm');
      return;
    }
    if (value !== values.new) {
      go('new');
      feedback.show({ kind: 'mismatch' });
      return;
    }
    await send(mode === 'change' ? values.current : undefined, values.new);
  };

  const back = () => {
    feedback.show(null);
    const prev = steps[index - 1];
    if (prev) go(prev, { [prev]: values[prev] });
  };

  const hint = step === 'new' ? (isWeakPin(value) ? t('weakPin') : t('pinRule')) : undefined;

  const stepLabel = { current: t('currentPin'), new: t('newPin'), confirm: t('confirmPin') }[step];
  const stepText = {
    // After a refused current PIN the new one is already confirmed; say so where it stays visible.
    current: pending !== null ? t('newPinKept') : t('enterCurrentPin'),
    new: mode === 'first' ? t('chooseFirstPin') : t('chooseNewPin'),
    confirm: t('enterNewPinAgain'),
  }[step];
  const finalLabel = mode === 'first' ? t('setPin') : t('changePin');

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={mode === 'first' ? t('setPinTitle') : t('changePinTitle')}
      description={stepText}
      size="sm"
      dismissible={false}
      testId={testId}
      footer={
        <>
          {index > 0 && pending === null ? (
            <Button variant="ghost" onClick={back} disabled={busy} data-testid={`${testId}-back`}>
              {t('back')}
            </Button>
          ) : (
            <Button variant="ghost" onClick={onCancel} disabled={busy}>
              {t('cancel')}
            </Button>
          )}
          <Button variant="primary" type="submit" form={formId} loading={busy} disabled={lockedHere} data-testid={`${testId}-submit`}>
            {last ? finalLabel : t('next')}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={(e) => void submit(e)} className="flex flex-col items-center gap-4 pt-1">
        <p className="text-body-sm text-fg-subtle tabular" data-testid={`${testId}-step`}>
          {t('stepOf', { step: index + 1, total: steps.length })}
        </p>
        <PinField
          key={step}
          value={value}
          onChange={(v) => {
            setValues((s) => ({ ...s, [step]: v }));
            if (feedback.failure && !feedback.lockedOut) feedback.show(null);
          }}
          label={stepLabel}
          describedBy={messageId}
          invalid={!!feedback.failure && !lockedHere}
          disabled={lockedHere}
          revealed={revealed}
          onRevealedChange={setRevealed}
          inputRef={inputRef}
          slotsRef={feedback.slotsRef}
          autoFocus
          // A lockout only concerns the current PIN; the new PIN steps stay usable.
          message={<PinMessage id={messageId} feedback={{ ...feedback, lockedOut: lockedHere }} hint={hint} />}
          testId={`${testId}-field`}
        />
        {/* SS-15: there is no recovery yet, so say it before the PIN is set, while it can still be written down. */}
        {step === 'confirm' ? (
          <p className="flex max-w-xs items-start gap-2 rounded-md border border-edge bg-surface-2 px-3 py-2 text-body-sm text-fg-muted" data-testid={`${testId}-no-recovery`}>
            <KeyRound aria-hidden size={16} className="mt-0.5 shrink-0 text-warning" />
            {t('pinNoRecovery')}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
