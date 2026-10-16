import { useCallback, useEffect, useRef, useState } from 'react';

export const DIGIT_COMMIT_MS = 1000;
export const MAX_DIGITS = 5;

/**
 * True when no further digit can make a channel number: the buffer is at {@link MAX_DIGITS}, or
 * appending any digit would pass the source's highest number (`7` on a 30-channel list).
 */
export function digitsComplete(buffer: string, maxNumber: number | undefined): boolean {
  if (buffer.length >= MAX_DIGITS) return true;
  if (maxNumber === undefined) return false;
  const n = Number.parseInt(buffer, 10);
  return Number.isFinite(n) && n * 10 > maxNumber;
}

/**
 * Collects channel-number digits and commits them after a pause (C16: 0-9 with a 1 s commit).
 * Enter, or `commitNow`, flushes immediately, and so does a number no further digit can extend
 * (five digits, or past `maxNumber`, the source's highest channel number when known).
 */
export function useDigitEntry(onCommit: (n: number) => void, delayMs = DIGIT_COMMIT_MS, maxNumber?: number) {
  const [buffer, setBuffer] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bufRef = useRef('');
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const maxRef = useRef(maxNumber);
  maxRef.current = maxNumber;

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
      if (digitsComplete(next, maxRef.current)) {
        commitNow();
        return;
      }
      setBuffer(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(commitNow, delayMs);
    },
    [commitNow, delayMs],
  );

  // The highest number can arrive after the first digit (it is asked for on the first key): a
  // pending number it already completes commits then.
  useEffect(() => {
    if (bufRef.current && digitsComplete(bufRef.current, maxNumber)) commitNow();
  }, [maxNumber, commitNow]);

  // Enter while digits are pending commits at once. Capture phase, so a focused list row
  // does not also treat the Enter as "play this row".
  const pending = buffer !== '';
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      commitNow();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pending, commitNow]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return { buffer, push, commitNow, clear };
}
