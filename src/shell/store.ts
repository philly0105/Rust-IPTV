/**
 * Shell UI state: header slots, context panel, overlays. Module-level zustand
 * store so `useShell()` works anywhere (pages, tests) without a provider.
 */

import { useCallback, useEffect, useId, useMemo, type KeyboardEvent, type ReactNode, type RefCallback } from 'react';
import { create } from 'zustand';

export interface HeaderSearch {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Enter in the header search box. */
  onSubmit?: (value: string) => void;
  /** Every key in the header search box, before its own Enter and Escape handling (preventDefault skips those). */
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
}

/** The header's Back control (the kit BackButton at its leading edge). */
export interface HeaderBack {
  /** Back in history, or to the page's section when it was opened cold (useGoBack). */
  onClick: () => void;
  /** Defaults to "Back". */
  label?: string;
}

export interface HeaderState {
  title: string;
  /**
   * The window and tab title, when it is not `title`: a movie's watch view names its section in
   * the header, since the stage below shows the title, while the window keeps the title's name.
   */
  documentTitle?: string;
  subtitle?: string;
  actions?: ReactNode;
  search?: HeaderSearch;
  /** A Back control before the title: detail pages, which the window has no browser chrome to leave. */
  back?: HeaderBack;
  /**
   * What the header names while the page's own large title is on screen: the section the page
   * belongs to ("Movies"), so a detail page does not show its title twice. Once that title has
   * scrolled away (useHeaderTitleAnchor), `title` fades in instead. The window title is `title`
   * (or `documentTitle`) throughout.
   */
  section?: string;
}

interface ShellStore {
  header: HeaderState | null;
  headerOwner: string | null;
  /** The element marked with useHeaderTitleAnchor has scrolled out of view above. */
  titleScrolledAway: boolean;
  contextPanel: ReactNode | null;
  panelOwner: string | null;
  /** Narrow screens: context panel drawer open. */
  panelOpen: boolean;
  paletteOpen: boolean;
  helpOpen: boolean;
  railCollapsed: boolean;
  /**
   * Below 1024 px, where the rail is always icons: the user hid it (header button brings it back).
   * Wider windows ignore it, so the rail never goes missing on a desktop.
   */
  railHidden: boolean;
  setPaletteOpen(open: boolean): void;
  setHelpOpen(open: boolean): void;
  setPanelOpen(open: boolean): void;
  toggleRail(): void;
  toggleRailHidden(): void;
}

const RAIL_KEY = 'tsrust.railCollapsed';
const RAIL_HIDDEN_KEY = 'tsrust.railHidden';

function storedFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function storeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    // storage blocked
  }
}

export const useShellStore = create<ShellStore>((set, get) => ({
  header: null,
  headerOwner: null,
  titleScrolledAway: false,
  contextPanel: null,
  panelOwner: null,
  panelOpen: false,
  paletteOpen: false,
  helpOpen: false,
  railCollapsed: storedFlag(RAIL_KEY),
  railHidden: storedFlag(RAIL_HIDDEN_KEY),
  setPaletteOpen: (open) => set({ paletteOpen: open, ...(open ? { helpOpen: false } : {}) }),
  setHelpOpen: (open) => set({ helpOpen: open, ...(open ? { paletteOpen: false } : {}) }),
  setPanelOpen: (open) => set({ panelOpen: open }),
  toggleRail: () => {
    const next = !get().railCollapsed;
    storeFlag(RAIL_KEY, next);
    set({ railCollapsed: next });
  },
  toggleRailHidden: () => {
    const next = !get().railHidden;
    storeFlag(RAIL_HIDDEN_KEY, next);
    set({ railHidden: next });
  },
}));

export interface ShellApi {
  /** Sets the header (title, subtitle, actions, search slot). Call inside useEffect. */
  setHeader(h: HeaderState): void;
  /** Sets the right-hand context panel; `null` removes it. */
  setContextPanel(node: ReactNode | null): void;
}

/**
 * C16. Header and context panel set through this hook are reset when the
 * calling component unmounts (if no other page has replaced them since).
 */
export function useShell(): ShellApi {
  const owner = useId();
  useEffect(
    () => () => {
      const s = useShellStore.getState();
      const patch: Partial<ShellStore> = {};
      if (s.headerOwner === owner) Object.assign(patch, { header: null, headerOwner: null });
      if (s.panelOwner === owner) Object.assign(patch, { contextPanel: null, panelOwner: null, panelOpen: false });
      if (Object.keys(patch).length) useShellStore.setState(patch);
    },
    [owner],
  );
  return useMemo<ShellApi>(
    () => ({
      setHeader: (h) => useShellStore.setState({ header: h, headerOwner: owner }),
      setContextPanel: (node) =>
        useShellStore.setState(node === null ? { contextPanel: null, panelOwner: null, panelOpen: false } : { contextPanel: node, panelOwner: owner }),
    }),
    [owner],
  );
}

function setTitleScrolledAway(away: boolean): void {
  if (useShellStore.getState().titleScrolledAway !== away) useShellStore.setState({ titleScrolledAway: away });
}

/**
 * Marks the page's own large title (a detail page's h1) for a header with a `section`: while the
 * element has scrolled out of view above, the header names the page by its `title`. Returns a
 * stable ref callback. Without IntersectionObserver the header keeps the section.
 */
export function useHeaderTitleAnchor(): RefCallback<HTMLElement> {
  return useCallback((el: HTMLElement | null) => {
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      const e = entries.at(-1);
      if (!e) return;
      // Out of view, and above the middle of the window: scrolled away upwards, not still below.
      const viewport = e.rootBounds?.height ?? window.innerHeight;
      setTitleScrolledAway(!e.isIntersecting && e.boundingClientRect.bottom < viewport / 2);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      setTitleScrolledAway(false);
    };
  }, []);
}

/** Convenience: sets the header while mounted and whenever `deps` change. */
export function useShellHeader(h: HeaderState, deps: readonly unknown[]): void {
  const shell = useShell();
  useEffect(() => {
    shell.setHeader(h);
    // h is rebuilt each render; deps decide when to push it.
  }, [shell, ...deps]);
}
