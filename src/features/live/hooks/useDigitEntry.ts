import { useCallback, useEffect, useRef, useState } from 'react';

export const DIGIT_COMMIT_MS = 1500;
const MAX_DIGITS = 5;

/**
 * Collects channel-number digits and commits them after a pause (C16: 0-9 with a 1.5 s commit).
 * `commitNow` flushes immediately (Enter).
 */
export function useDigitEntry(onCommit: (n: number) => void, delayMs = DIGIT_COMMIT_MS) {
  const [buffer, setBuffer] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bufRef = useRef('');
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    bufRef.current = '';
    setBuffer('');
  }, []);

  const commitNow = useCallback(() => {
    const value = bufRef.current;
    clear();
    const n = Number.parseInt(value, 10);
    if (value && Number.isFinite(n)) commitRef.current(n);
  }, [clear]);

  const push = useCallback(
    (digit: string) => {
      if (!/^[0-9]$/.test(digit)) return;
      const next = (bufRef.current + digit).slice(-MAX_DIGITS);
      bufRef.current = next;
      setBuffer(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(commitNow, delayMs);
    },
    [commitNow, delayMs],
  );

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return { buffer, push, commitNow, clear };
}
