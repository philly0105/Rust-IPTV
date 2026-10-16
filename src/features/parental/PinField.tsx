import { Delete, Eye, EyeOff, X } from 'lucide-react';
import { useState, type ClipboardEvent, type ReactNode, type Ref, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { IconButton, cn } from '@/ui';

import { PIN_MAX, PIN_MIN, sanitizePin } from './pin';

export interface PinFieldProps {
  value: string;
  onChange: (pin: string) => void;
  /** Accessible name of the input ("PIN", "New PIN"). */
  label: string;
  id?: string;
  /** Id of the message under the field (hint, wrong PIN, lockout). */
  describedBy?: string;
  invalid?: boolean;
  disabled?: boolean;
  revealed: boolean;
  onRevealedChange: (revealed: boolean) => void;
  inputRef?: Ref<HTMLInputElement>;
  /** The slot row; the dialog shakes it after a wrong PIN. */
  slotsRef?: RefObject<HTMLDivElement | null>;
  /** Marks the input for the Dialog's initial focus. */
  autoFocus?: boolean;
  /** Shown between the slots and the keypad (hint, error, lockout countdown). */
  message?: ReactNode;
  testId?: string;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/**
 * PIN entry: a row of slots that light up as digits arrive, a show/hide
 * toggle, and a keypad for pointer and touch use.
 *
 * The real control is a native input stretched invisibly over the slots, so
 * typing, IME input, paste, autofill blocking and screen readers all work as
 * they do in any field. Input is normalized to ASCII digits (Arabic-Indic and
 * full-width digits count). Digits always read left to right, in RTL locales
 * too. The keypad keys are skipped by Tab (the input takes the same digits)
 * and do not take focus from the input when pressed.
 */
export function PinField({
  value,
  onChange,
  label,
  id,
  describedBy,
  invalid,
  disabled,
  revealed,
  onRevealedChange,
  inputRef,
  slotsRef,
  autoFocus,
  message,
  testId = 'pin-field',
}: PinFieldProps) {
  const { t } = useTranslation('parental');
  const [focused, setFocused] = useState(false);
  // Four slots to start, one more per digit typed, up to eight.
  const slots = Math.min(PIN_MAX, Math.max(PIN_MIN, value.length + 1));

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = sanitizePin(e.clipboardData.getData('text'));
    if (!pasted) return;
    // A whole PIN replaces what is there; a few digits continue it.
    onChange(pasted.length >= PIN_MIN ? pasted : sanitizePin(value + pasted));
  };

  const press = (key: string) => {
    if (disabled) return;
    if (key === 'back') onChange(value.slice(0, -1));
    else if (key === 'clear') onChange('');
    else onChange(sanitizePin(value + key));
  };

  return (
    <div className="flex w-full flex-col items-center gap-3" data-testid={testId}>
      <div className="flex w-full max-w-full items-center justify-center gap-1">
        <div
          ref={slotsRef}
          dir="ltr"
          className={cn(
            'relative flex min-w-0 justify-center gap-1.5 rounded-lg p-1.5 sm:gap-2',
            'focus-within:ring-2 focus-within:ring-focus',
            disabled && 'opacity-50',
          )}
        >
          {Array.from({ length: slots }, (_, i) => {
            const digit = value[i];
            const caret = focused && !disabled && i === value.length;
            return (
              <span
                key={i}
                aria-hidden
                data-filled={digit !== undefined || undefined}
                className={cn(
                  'relative flex h-12 w-10 min-w-0 shrink items-center justify-center rounded-md border bg-surface-2 font-display text-xl text-fg tabular',
                  'motion-safe:transition-[border-color,background-color] motion-safe:duration-150',
                  invalid ? 'border-danger' : digit !== undefined || caret ? 'border-accent' : 'border-border',
                  digit !== undefined && !invalid && 'bg-surface-3',
                )}
              >
                {digit === undefined ? null : revealed ? (
                  digit
                ) : (
                  <span className="size-2.5 rounded-full bg-accent shadow-[0_0_10px_var(--color-glow)]" />
                )}
                {caret ? (
                  <span className="absolute inset-x-2.5 bottom-1.5 h-0.5 rounded-full bg-accent motion-safe:animate-pulse" />
                ) : null}
              </span>
            );
          })}
          <input
            ref={inputRef}
            id={id}
            type={revealed ? 'text' : 'password'}
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="done"
            aria-label={label}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            // Read-only rather than disabled while locked out: a disabled input drops focus to <body>.
            readOnly={disabled}
            aria-disabled={disabled || undefined}
            value={value}
            data-autofocus={autoFocus ? '' : undefined}
            data-testid={`${testId}-input`}
            // Password managers: this is not a site password.
            data-1p-ignore=""
            data-lpignore="true"
            data-form-type="other"
            onChange={(e) => {
              if (!disabled) onChange(sanitizePin(e.target.value));
            }}
            onPaste={(e) => (disabled ? e.preventDefault() : onPaste(e))}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            className="absolute inset-0 h-full w-full cursor-text rounded-lg text-base caret-transparent opacity-0 aria-disabled:cursor-not-allowed"
          />
        </div>
        <IconButton
          label={revealed ? t('hidePin') : t('showPin')}
          pressed={revealed}
          icon={revealed ? <EyeOff aria-hidden size={18} /> : <Eye aria-hidden size={18} />}
          onClick={() => onRevealedChange(!revealed)}
          data-testid={`${testId}-reveal`}
        />
      </div>

      {message}

      <div role="group" aria-label={t('keypad')} dir="ltr" className="grid grid-cols-3 gap-2" data-testid={`${testId}-keypad`}>
        {KEYS.map((k) => (
          <KeypadKey key={k} label={k} disabled={disabled} onPress={() => press(k)}>
            {k}
          </KeypadKey>
        ))}
        <KeypadKey label={t('clearPin')} disabled={disabled || value.length === 0} onPress={() => press('clear')} muted>
          <X aria-hidden size={18} />
        </KeypadKey>
        <KeypadKey label="0" disabled={disabled} onPress={() => press('0')}>
          0
        </KeypadKey>
        <KeypadKey label={t('deleteDigit')} disabled={disabled || value.length === 0} onPress={() => press('back')} muted>
          <Delete aria-hidden size={18} />
        </KeypadKey>
      </div>
    </div>
  );
}

function KeypadKey({
  label,
  disabled,
  onPress,
  muted,
  children,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
  muted?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      disabled={disabled}
      // Keep focus (and the soft keyboard state) in the PIN input.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPress}
      className={cn(
        'flex h-12 w-16 items-center justify-center rounded-md border border-border bg-surface-2 font-display text-xl tabular select-none sm:w-[4.5rem]',
        'hover:bg-surface-3 active:bg-pressed disabled:cursor-not-allowed disabled:opacity-40',
        'motion-safe:transition-colors motion-safe:active:translate-y-px',
        muted ? 'text-fg-muted' : 'text-fg',
      )}
    >
      {children}
    </button>
  );
}
