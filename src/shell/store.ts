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
        useShellStore.setState(
          node === null
            ? { contextPanel: null, panelOwner: null, panelOpen: false }
            : { contextPanel: node, panelOwner: owner },
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
