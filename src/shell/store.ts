/**
 * Shell UI state: header slots, context panel, overlays. Module-level zustand
 * store so `useShell()` works anywhere (pages, tests) without a provider.
 */

import { useEffect, useId, useMemo, type ReactNode } from 'react';
import { create } from 'zustand';

export interface HeaderSearch {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Enter in the header search box. */
  onSubmit?: (value: string) => void;
}

export interface HeaderState {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  search?: HeaderSearch;
}

interface ShellStore {
  header: HeaderState | null;
  headerOwner: string | null;
  contextPanel: ReactNode | null;
  panelOwner: string | null;
  /**
   * Whether the panel also exists below 1440 px as a drawer behind the header toggle. A page that
   * shows the same content inline at those widths (Settings' section list) turns it off.
   */
  panelDrawer: boolean;
  /** Narrow screens: context panel drawer open. */
  panelOpen: boolean;
  paletteOpen: boolean;
  helpOpen: boolean;
  railCollapsed: boolean;
  setPaletteOpen(open: boolean): void;
  setHelpOpen(open: boolean): void;
  setPanelOpen(open: boolean): void;
  toggleRail(): void;
}

const RAIL_KEY = 'tsrust.railCollapsed';

function storedRail(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === '1';
  } catch {
    return false;
  }
}

export const useShellStore = create<ShellStore>((set, get) => ({
  header: null,
  headerOwner: null,
  contextPanel: null,
  panelOwner: null,
  panelDrawer: true,
  panelOpen: false,
  paletteOpen: false,
  helpOpen: false,
  railCollapsed: storedRail(),
  setPaletteOpen: (open) => set({ paletteOpen: open, ...(open ? { helpOpen: false } : {}) }),
  setHelpOpen: (open) => set({ helpOpen: open, ...(open ? { paletteOpen: false } : {}) }),
  setPanelOpen: (open) => set({ panelOpen: open }),
  toggleRail: () => {
    const next = !get().railCollapsed;
    try {
      localStorage.setItem(RAIL_KEY, next ? '1' : '0');
    } catch {
      // storage blocked
    }
    set({ railCollapsed: next });
  },
}));

export interface ShellApi {
  /** Sets the header (title, subtitle, actions, search slot). Call inside useEffect. */
  setHeader(h: HeaderState): void;
  /**
   * Sets the right-hand context panel; `null` removes it. `drawer: false` shows it only where it
   * fits inline (1440 px and up), for a page that lists the same content itself below that.
   */
  setContextPanel(node: ReactNode | null, opts?: { drawer?: boolean }): void;
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
      if (s.panelOwner === owner) Object.assign(patch, { contextPanel: null, panelOwner: null, panelOpen: false, panelDrawer: true });
      if (Object.keys(patch).length) useShellStore.setState(patch);
    },
    [owner],
  );
  return useMemo<ShellApi>(
    () => ({
      setHeader: (h) => useShellStore.setState({ header: h, headerOwner: owner }),
      setContextPanel: (node, opts) =>
        useShellStore.setState(
          node === null
            ? { contextPanel: null, panelOwner: null, panelOpen: false, panelDrawer: true }
            : { contextPanel: node, panelOwner: owner, panelDrawer: opts?.drawer ?? true, ...(opts?.drawer === false ? { panelOpen: false } : {}) },
        ),
    }),
    [owner],
  );
}

/** Convenience: sets the header while mounted and whenever `deps` change. */
export function useShellHeader(h: HeaderState, deps: readonly unknown[]): void {
  const shell = useShell();
  useEffect(() => {
    shell.setHeader(h);
    // h is rebuilt each render; deps decide when to push it.
  }, [shell, ...deps]);
}
