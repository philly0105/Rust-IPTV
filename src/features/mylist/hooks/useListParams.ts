import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import { parseFilter, parseSort, type MyListFilter, type MyListSort } from '../lib/list';

export interface ListParams {
  filter: MyListFilter;
  sort: MyListSort;
  hideWatched: boolean;
  query: string;
}

/**
 * The page's view state mirrored into the URL (`?type=`, `?sort=`,
 * `?watched=hide`, `?q=`), so a reload or Back keeps it. Defaults are left
 * out of the URL; every change replaces the history entry instead of pushing
 * one. The search text is also held locally so typing never waits on the
 * router, and follows the URL when it changes from outside (Back, a link).
 */
export function useListParams(): [ListParams, (patch: Partial<ListParams>) => void] {
  const [params, setParams] = useSearchParams();
  const urlQuery = params.get('q') ?? '';
  const [query, setQuery] = useState(urlQuery);
  const filter = parseFilter(params.get('type'));
  const sort = parseSort(params.get('sort'));
  const hideWatched = params.get('watched') === 'hide';

  useEffect(() => setQuery(urlQuery), [urlQuery]);

  const update = useCallback(
    (patch: Partial<ListParams>) => {
      if (patch.query !== undefined) setQuery(patch.query);
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          const put = (key: string, value: string | undefined) => {
            if (value) next.set(key, value);
            else next.delete(key);
          };
          if (patch.filter !== undefined) put('type', patch.filter === 'all' ? undefined : patch.filter);
          if (patch.sort !== undefined) put('sort', patch.sort === 'order' ? undefined : patch.sort);
          if (patch.hideWatched !== undefined) put('watched', patch.hideWatched ? 'hide' : undefined);
          if (patch.query !== undefined) put('q', patch.query);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const value = useMemo(() => ({ filter, sort, hideWatched, query }), [filter, sort, hideWatched, query]);
  return [value, update];
}
