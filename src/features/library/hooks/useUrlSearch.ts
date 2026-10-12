import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router';

/**
 * Header search text mirrored into `?q=`, so a reload or Back keeps what the
 * user typed. The URL entry is replaced, not pushed, on every keystroke.
 */
export function useUrlSearch(): [string, (value: string) => void] {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(() => params.get('q') ?? '');
  const update = useCallback(
    (value: string) => {
      setSearch(value);
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value) next.set('q', value);
          else next.delete('q');
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  return [search, update];
}
