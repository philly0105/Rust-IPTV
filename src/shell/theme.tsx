/**
 * Theme: settings.theme ('light' | 'dark' | 'system') resolved against the OS
 * preference, mirrored to localStorage for a flash-free cold start, applied
 * as html[data-theme]. Also mirrors prefers-reduced-motion to
 * html[data-reduced-motion].
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { create } from 'zustand';

import { queryClient, rpcKey } from '@/api/query';
import { rpc } from '@/api/transport';
import type { Settings, Theme } from '@/api/types';

const STORAGE_KEY = 'tsrust.theme';

export type ResolvedTheme = 'light' | 'dark';

function readStored(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    // storage blocked
  }
  return 'system';
}

interface ThemeStore {
  theme: Theme;
  set(theme: Theme): void;
}

export const useThemeStore = create<ThemeStore>((set) => ({
  theme: readStored(),
  set: (theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // storage blocked
    }
    set({ theme });
  },
}));

function mql(query: string): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
}

function subscribeMedia(query: string) {
  return (cb: () => void) => {
    const m = mql(query);
    if (!m) return () => {};
    m.addEventListener('change', cb);
    return () => m.removeEventListener('change', cb);
  };
}

const DARK_Q = '(prefers-color-scheme: dark)';
const LIGHT_Q = '(prefers-color-scheme: light)';
const MOTION_Q = '(prefers-reduced-motion: reduce)';
const subscribeDark = subscribeMedia(DARK_Q);
const subscribeMotion = subscribeMedia(MOTION_Q);

/** Dark unless the OS explicitly asks for light (a TV app reads best dark). */
function systemPrefersDark(): boolean {
  return !(mql(LIGHT_Q)?.matches ?? false);
}

export function resolveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
  if (theme === 'system') return prefersDark ? 'dark' : 'light';
  return theme;
}

export function applyThemeToDocument(resolved: ResolvedTheme, reducedMotion: boolean): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  html.dataset['theme'] = resolved;
  if (reducedMotion) html.dataset['reducedMotion'] = 'true';
  else delete html.dataset['reducedMotion'];
}

// Apply the stored theme as early as this module loads.
applyThemeToDocument(resolveTheme(readStored(), systemPrefersDark()), mql(MOTION_Q)?.matches ?? false);

export interface ThemeApi {
  theme: Theme;
  resolved: ResolvedTheme;
  /** Updates locally at once and persists through settings.update. */
  setTheme(theme: Theme): void;
  /** Flips between light and dark (from system, flips the resolved value). */
  toggle(): void;
}

/** Persists a theme choice: local first (instant), then settings.update. */
export async function persistTheme(theme: Theme): Promise<void> {
  useThemeStore.getState().set(theme);
  const key = rpcKey('settings.get');
  const prev = queryClient.getQueryData<Settings>(key);
  if (prev) queryClient.setQueryData<Settings>(key, { ...prev, theme });
  try {
    const next = await rpc('settings.update', { patch: { theme } });
    queryClient.setQueryData(key, next);
  } catch {
    // Keep the local choice; settings will reconcile on the next load.
  }
}

export function useTheme(): ThemeApi {
  const theme = useThemeStore((s) => s.theme);
  const prefersDark = useSyncExternalStore(subscribeDark, systemPrefersDark, () => true);
  const resolved = resolveTheme(theme, prefersDark);
  const setTheme = useCallback((t: Theme) => void persistTheme(t), []);
  const toggle = useCallback(() => void persistTheme(resolved === 'dark' ? 'light' : 'dark'), [resolved]);
  return { theme, resolved, setTheme, toggle };
}

/**
 * Mount once (the shell does). Syncs the store from settings and applies
 * data-theme / data-reduced-motion.
 */
export function ThemeSync({ settingsTheme }: { settingsTheme?: Theme }) {
  const setLocal = useThemeStore((s) => s.set);
  useEffect(() => {
    if (settingsTheme) setLocal(settingsTheme);
  }, [settingsTheme, setLocal]);

  const theme = useThemeStore((s) => s.theme);
  const prefersDark = useSyncExternalStore(subscribeDark, systemPrefersDark, () => true);
  const reducedMotion = useSyncExternalStore(subscribeMotion, () => mql(MOTION_Q)?.matches ?? false, () => false);
  useEffect(() => {
    applyThemeToDocument(resolveTheme(theme, prefersDark), reducedMotion);
  }, [theme, prefersDark, reducedMotion]);
  return null;
}
