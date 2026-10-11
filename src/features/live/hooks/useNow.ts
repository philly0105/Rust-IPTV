import { useEffect, useState } from 'react';

/** Wall clock that ticks every `intervalMs`, aligned to the interval boundary. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(Date.now());
      timer = setTimeout(tick, intervalMs - (Date.now() % intervalMs) + 5);
    };
    timer = setTimeout(tick, intervalMs - (Date.now() % intervalMs) + 5);
    return () => clearTimeout(timer);
  }, [intervalMs]);
  return now;
}
