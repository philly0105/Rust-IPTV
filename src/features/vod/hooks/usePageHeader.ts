import { useEffect, useRef, type ReactNode } from 'react';

import { useShell, type HeaderSearch } from '@/shell';

export interface PageHeader {
  title: string;
  /** The window and tab title when it is not `title` (HeaderState.documentTitle). */
  documentTitle?: string;
  subtitle?: string;
  actions?: ReactNode;
  search?: HeaderSearch;
}

/**
 * Publishes the page header to the shell (C16). The latest header is pushed
 * whenever one of `deps` changes; the shell clears it on unmount.
 */
export function usePageHeader(header: PageHeader, deps: readonly unknown[]): void {
  const shell = useShell();
  const headerRef = useRef(header);
  headerRef.current = header;

  useEffect(() => {
    const h = headerRef.current;
    const out: Parameters<typeof shell.setHeader>[0] = { title: h.title };
    if (h.documentTitle) out.documentTitle = h.documentTitle;
    if (h.subtitle) out.subtitle = h.subtitle;
    if (h.actions) out.actions = h.actions;
    if (h.search) out.search = h.search;
    shell.setHeader(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell, ...deps]);
}
