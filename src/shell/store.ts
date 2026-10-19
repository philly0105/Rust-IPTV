/**
 * Shell UI state: header slots, context panel, overlays. Module-level zustand
 * store so `useShell()` works anywhere (pages, tests) without a provider.
 */

import { useEffect, useId, useMemo, type KeyboardEvent, type ReactNode } from 'react';
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
  contextPanel: null,
  panelOwner: null,
  panelDrawer: true,
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
