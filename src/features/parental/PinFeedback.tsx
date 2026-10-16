import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { ProgressBar } from '@/ui';

import { MAX_PIN_ATTEMPTS, classifyPinError, formatCountdown, type PinFailure } from './pin';
import { refreshStatus, useParentalStatus } from './status';
import { motionAllowed, useNow } from './time';

/** A short horizontal shake for a refused PIN (skipped under reduced motion). */
function shake(el: HTMLElement | null): void {
  if (!el || typeof el.animate !== 'function' || !motionAllowed()) return;
  el.animate(
    [
      { transform: 'translateX(0)' },
      { transform: 'translateX(-7px)' },
      { transform: 'translateX(6px)' },
      { transform: 'translateX(-4px)' },
      { transform: 'translateX(2px)' },
      { transform: 'translateX(0)' },
    ],
    { duration: 340, easing: 'cubic-bezier(0.36, 0.07, 0.19, 0.97)' },
  );
}

export interface PinFeedback {
  failure: PinFailure | null;
  /** Wrong PINs left before the lockout, when the core told us. */
  attemptsLeft: number | null;
  /** True while the wrong-PIN lockout runs. */
  lockedOut: boolean;
  /** Seconds left in the lockout. */
  remaining: number;
  /** Length of the current lockout, for the progress bar. */
  lockSeconds: number;
  /** The slot row to shake. */
  slotsRef: RefObject<HTMLDivElement | null>;
  /** Records a refused PIN: classifies the error, refreshes the attempt count, shakes. */
  fail(err: unknown): Promise<PinFailure>;
  /** Shows a local problem (too short, the two PINs differ) without asking the core. */
  show(failure: PinFailure | null): void;
}

/**
 * Wrong-PIN and lockout state for a PIN dialog (C2: five wrong PINs start a
 * 30 s lockout that doubles up to 300 s). A lockout the core already reports
 * in its status (an earlier dialog, another device) applies on open.
 * `onLockoutEnd` runs once the wait is over, to put focus back in the field.
 */
export function usePinFeedback(onLockoutEnd?: () => void): PinFeedback {
  const status = useParentalStatus();
  const [failure, setFailure] = useState<PinFailure | null>(null);
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);
  const [lock, setLock] = useState<{ until: number; seconds: number } | null>(null);
  const slotsRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef(onLockoutEnd);
  endRef.current = onLockoutEnd;
  const now = useNow(lock ? 250 : null);

  const startLock = useCallback((seconds: number, from = Date.now()) => {
    const until = from + seconds * 1000;
    if (until <= Date.now()) return;
    setLock((cur) => (cur && cur.until >= until ? cur : { until, seconds }));
    setAttemptsLeft(null);
  }, []);

  const reported = status.data?.retryAfterSeconds;
  const reportedAt = status.dataUpdatedAt;
  useEffect(() => {
    if (reported) startLock(reported, reportedAt);
  }, [reported, reportedAt, startLock]);

  // `now` ticks while a lockout runs; the clock itself is read so a late tick never shows a stale second.
  const remaining = lock ? Math.max(0, Math.ceil((lock.until - Math.max(now, Date.now())) / 1000)) : 0;
  const lockedOut = lock !== null && remaining > 0;

  useEffect(() => {
    if (!lock || lock.until > now) return;
    setLock(null);
    setFailure(null);
    endRef.current?.();
  }, [lock, now]);

  const fail = useCallback(
    async (err: unknown): Promise<PinFailure> => {
      const f = classifyPinError(err);
      if (f.kind === 'lockout') startLock(f.seconds);
      if (f.kind === 'wrong') {
        try {
          const s = await refreshStatus();
          if (s.retryAfterSeconds) startLock(s.retryAfterSeconds);
          else setAttemptsLeft(Math.max(0, MAX_PIN_ATTEMPTS - s.failedAttempts));
        } catch {
          setAttemptsLeft(null);
        }
      }
      setFailure(f);
      shake(slotsRef.current);
      return f;
    },
    [startLock],
  );

  const show = useCallback((f: PinFailure | null) => {
    setFailure(f);
    if (f) shake(slotsRef.current);
  }, []);

  return { failure, attemptsLeft, lockedOut, remaining, lockSeconds: lock?.seconds ?? 0, slotsRef, fail, show };
}

/**
 * The line under a PIN field: the hint, or what went wrong, or the lockout
 * countdown. Its height is reserved so the dialog does not jump.
 */
export function PinMessage({ id, feedback, hint }: { id: string; feedback: PinFeedback; hint?: ReactNode }) {
  const { t } = useTranslation('parental');
  const { failure, lockedOut, remaining, lockSeconds, attemptsLeft } = feedback;

  let body: ReactNode;
  if (lockedOut) {
    body = (
      <div className="flex w-full max-w-64 flex-col items-center gap-2" data-testid="pin-lockout">
        <p role="alert" className="text-sm font-medium text-danger">
          {t('lockedOut')}
        </p>
        <p role="timer" aria-live="off" className="font-display text-sm text-fg-muted tabular">
          {t('tryAgainIn', { time: formatCountdown(remaining) })}
        </p>
        <ProgressBar value={remaining} max={Math.max(lockSeconds, remaining)} tone="danger" size="xs" label={t('lockoutProgress')} />
      </div>
    );
  } else if (failure) {
    let text: string;
    switch (failure.kind) {
      case 'wrong':
        text = attemptsLeft !== null && attemptsLeft > 0 ? t('wrongPinLeft', { count: attemptsLeft }) : t('wrongPin');
        break;
      case 'lockout':
        text = t('lockedOut');
        break;
      case 'invalid':
        text = t('pinLength');
        break;
      case 'mismatch':
        text = t('pinMismatch');
        break;
      case 'other':
        text = t('pinFailed', { message: failure.message });
        break;
    }
    body = (
      <p role="alert" className="text-sm font-medium text-danger" data-testid="pin-error" data-kind={failure.kind}>
        {text}
      </p>
    );
  } else {
    body = hint ? <p className="text-sm text-fg-muted">{hint}</p> : null;
  }

  return (
    <div id={id} className="flex min-h-11 w-full flex-col items-center justify-center text-center">
      {body}
    </div>
  );
}
