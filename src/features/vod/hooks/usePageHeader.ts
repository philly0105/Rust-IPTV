import { useEffect, useRef, type ReactNode } from 'react';

import { useShell, type HeaderBack, type HeaderSearch } from '@/shell';

export interface PageHeader {
  title: string;
  /** The window and tab title when it is not `title` (HeaderState.documentTitle). */
  documentTitle?: string;
  subtitle?: string;
  actions?: ReactNode;
  search?: HeaderSearch;
  /** The header's Back control (HeaderState.back). */
  back?: HeaderBack;
  /** What the header names until the page's own title scrolls away (HeaderState.section). */
  section?: string;
}

/**
 * Publishes the page header to the shell (C16). The latest header is pushed
 * whenever one of `deps` changes; the shell clears it on unmount. The Back
 * control always runs the page's latest handler, so it needs no deps of its own.
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
    if (h.back) out.back = { ...h.back, onClick: () => headerRef.current.back?.onClick() };
    if (h.section) out.section = h.section;
    shell.setHeader(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell, ...deps]);
}
