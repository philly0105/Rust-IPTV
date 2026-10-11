import { useEffect, type ReactNode } from 'react';

import { useShell } from '../deps';

export interface HeaderSearch {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}

/**
 * Sets the shell header for the current page. `actions` must be memoized by
 * the caller; a new node every render would re-run the effect.
 */
export function usePageHeader(title: string, subtitle?: string, actions?: ReactNode, search?: HeaderSearch): void {
  const { setHeader } = useShell();
  const searchValue = search?.value;
  const searchChange = search?.onChange;
  const searchPlaceholder = search?.placeholder;
  useEffect(() => {
    const h: { title: string; subtitle?: string; actions?: ReactNode; search?: HeaderSearch } = { title };
    if (subtitle) h.subtitle = subtitle;
    if (actions) h.actions = actions;
    if (searchChange && searchValue !== undefined && searchPlaceholder !== undefined) {
      h.search = { value: searchValue, onChange: searchChange, placeholder: searchPlaceholder };
    }
    setHeader(h);
  }, [setHeader, title, subtitle, actions, searchValue, searchChange, searchPlaceholder]);
}
