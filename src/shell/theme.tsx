/**
 * Theme and appearance. settings.theme ('light' | 'dark' | 'system') resolves
 * against the OS preference and lands as html[data-theme]; the appearance
 * settings (C1) land as html[data-accent], html[data-oled] (OLED black while
 * the dark theme is in effect), html[data-density] and the --ui-scale custom
 * property that html font-size follows. Both are mirrored to localStorage and
 * applied when this module loads, so a cold start paints in the right colours
 * and size before settings arrive. Also mirrors prefers-reduced-motion to
 * html[data-reduced-motion]. See docs/architecture/appearance.md.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { create } from 'zustand';

import { onConnectionState, type ConnectionState } from '@/api/events';
import { queryClient, rpcKey } from '@/api/query';
import { onServerAnswered } from '@/api/reachability';
import { RpcError, rpc } from '@/api/transport';
import { ACCENTS, DENSITIES, UI_SCALE_MAX, UI_SCALE_MIN } from '@/api/types';
import type { Accent, Density, Settings, Theme } from '@/api/types';
import { setUiScaleState } from '@/ui/scale';

const STORAGE_KEY = 'tsrust.theme';
/** localStorage key for the appearance mirror (JSON of {@link Appearance}). */
export const APPEARANCE_STORAGE_KEY = 'tsrust.appearance';

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

// ---------------------------------------------------------------------------
// Appearance (C1)

/** The appearance subset of Settings that the document reflects. */
export interface Appearance {
  accent: Accent;
  oledBlack: boolean;
  density: Density;
  uiScale: number;
}

export const DEFAULT_APPEARANCE: Appearance = { accent: 'amber', oledBlack: false, density: 'comfortable', uiScale: 1 };

/** Clamps to the C1 range and rounds to the core's 4 decimals; anything unusable becomes 1. */
export function clampUiScale(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1;
  return Math.round(Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, v)) * 10000) / 10000;
}

/** Keeps known values and replaces anything else with the default (a stale or hand-edited mirror). */
export function sanitizeAppearance(raw: unknown): Appearance {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    accent: (ACCENTS as readonly unknown[]).includes(r['accent']) ? (r['accent'] as Accent) : DEFAULT_APPEARANCE.accent,
    oledBlack: typeof r['oledBlack'] === 'boolean' ? r['oledBlack'] : DEFAULT_APPEARANCE.oledBlack,
    density: (DENSITIES as readonly unknown[]).includes(r['density']) ? (r['density'] as Density) : DEFAULT_APPEARANCE.density,
    uiScale: r['uiScale'] === undefined ? DEFAULT_APPEARANCE.uiScale : clampUiScale(r['uiScale']),
  };
}

function readStoredAppearance(): Appearance {
  try {
    const v = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (v) return sanitizeAppearance(JSON.parse(v));
  } catch {
    // storage blocked or the mirror is not JSON
  }
  return DEFAULT_APPEARANCE;
}

function sameAppearance(a: Appearance, b: Appearance): boolean {
  return a.accent === b.accent && a.oledBlack === b.oledBlack && a.density === b.density && a.uiScale === b.uiScale;
}

interface AppearanceStore {
  /** The saved appearance (settings, mirrored to localStorage). */
  appearance: Appearance;
  /** An unsaved overlay, e.g. the UI scale while its slider is being dragged. */
  preview: Partial<Appearance> | null;
  set(appearance: Appearance): void;
  setPreview(preview: Partial<Appearance> | null): void;
}

export const useAppearanceStore = create<AppearanceStore>((set, get) => ({
  appearance: readStoredAppearance(),
  preview: null,
  set: (appearance) => {
    const next = sanitizeAppearance(appearance);
    if (sameAppearance(next, get().appearance)) return;
    try {
      localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // storage blocked
    }
    set({ appearance: next });
  },
  setPreview: (preview) => set({ preview }),
}));

/** The saved appearance with any live preview laid over it. */
export function effectiveAppearance(s: Pick<AppearanceStore, 'appearance' | 'preview'>): Appearance {
  return s.preview ? sanitizeAppearance({ ...s.appearance, ...s.preview }) : s.appearance;
}

/**
 * Shows an appearance change without saving it (null ends the preview). The
 * settings page uses it for the UI scale slider so the whole app resizes under
 * the pointer and the value is only written on release.
 */
export function previewAppearance(preview: Partial<Appearance> | null): void {
  useAppearanceStore.getState().setPreview(preview);
}

/** The appearance in effect right now, preview included. */
export function useAppearance(): Appearance {
  const appearance = useAppearanceStore((s) => s.appearance);
  const preview = useAppearanceStore((s) => s.preview);
  return effectiveAppearance({ appearance, preview });
}

// ---------------------------------------------------------------------------
// Document

function mql(query: string): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
}

function subscribeMedia(query: string) {
  return (cb: () => void) => {
    const m = mql(query);
    // Test doubles often stub matchMedia with `matches` only.
    if (!m || typeof m.addEventListener !== 'function') return () => {};
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

/**
 * Swaps every colour in one frame: without this each control with
 * transition-colors fades on its own and the page shimmers through the change.
 */
function suspendTransitions(html: HTMLElement): void {
  html.dataset['themeSwitching'] = 'true';
  const done = () => delete html.dataset['themeSwitching'];
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(done));
  else setTimeout(done, 32);
}

export function applyThemeToDocument(resolved: ResolvedTheme, reducedMotion: boolean): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  const previous = html.dataset['theme'];
  if (previous && previous !== resolved) suspendTransitions(html);
  html.dataset['theme'] = resolved;
  if (reducedMotion) html.dataset['reducedMotion'] = 'true';
  else delete html.dataset['reducedMotion'];
}

/**
 * Applies the appearance settings (C1): data-accent, data-oled (only while
 * `resolved` is dark), data-density and --ui-scale. Call after
 * {@link applyThemeToDocument} so OLED follows the theme in effect.
 */
export function applyAppearanceToDocument(appearance: Appearance, resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  const a = sanitizeAppearance(appearance);
  const oled = a.oledBlack && resolved === 'dark';
  const prevAccent = html.dataset['accent'];
  const prevOled = 'oled' in html.dataset;
  if ((prevAccent && prevAccent !== a.accent) || (prevAccent && prevOled !== oled)) suspendTransitions(html);

  html.dataset['accent'] = a.accent;
  if (oled) html.dataset['oled'] = '';
  else delete html.dataset['oled'];
  html.dataset['density'] = a.density;
  html.style.setProperty('--ui-scale', String(a.uiScale));
  setUiScaleState(a.uiScale, a.density);
}

// Apply the stored theme and appearance as early as this module loads.
{
  const resolved = resolveTheme(readStored(), systemPrefersDark());
  applyThemeToDocument(resolved, mql(MOTION_Q)?.matches ?? false);
  applyAppearanceToDocument(useAppearanceStore.getState().appearance, resolved);
}

export interface ThemeApi {
  theme: Theme;
  resolved: ResolvedTheme;
  /** Updates locally at once and persists through settings.update. */
  setTheme(theme: Theme): void;
  /** Flips between light and dark (from system, flips the resolved value). */
  toggle(): void;
}

let persistSeq = 0;

/**
 * The newest theme choice the server has not confirmed yet: in flight, or
 * written while the server was unreachable (web mode, server down). While it
 * is set, ThemeSync ignores the server's theme, so the settings refetch that
 * follows a reconnect (`events.lagged`) cannot flip the theme back.
 */
let pendingTheme: Theme | null = null;
let stopReplayWatch: (() => void) | null = null;

function stopWatching(): void {
  stopReplayWatch?.();
  stopReplayWatch = null;
}

/**
 * Writes the pending theme again once the server is back: when the event
 * socket reopens (before that reconnect's settings refetch goes out, which
 * waits for the event burst), or when any RPC gets an answer. Not on the
 * state reported at subscribe time: only a reconnect proves anything.
 */
function watchForReplay(): void {
  if (stopReplayWatch) return;
  const replay = () => {
    stopWatching();
    if (pendingTheme) void persistTheme(pendingTheme);
  };
  let last: ConnectionState | null = null;
  const offState = onConnectionState((s) => {
    const was = last;
    last = s;
    if (s === 'open' && was !== null && was !== 'open') replay();
  });
  const offAnswered = onServerAnswered(replay);
  stopReplayWatch = () => {
    offState();
    offAnswered();
  };
}

/**
 * Persists a theme choice: local first (instant), then settings.update. Only
 * the newest call writes its response to the settings cache: with Ctrl+Shift+L
 * pressed twice quickly, an older reply arriving last would otherwise flow
 * back through ThemeSync and undo the second press. A write that cannot reach
 * the server keeps the choice and replays it when the server is back.
 */
export async function persistTheme(theme: Theme): Promise<void> {
  const mine = ++persistSeq;
  pendingTheme = theme;
  useThemeStore.getState().set(theme);
  const key = rpcKey('settings.get');
  const prev = queryClient.getQueryData<Settings>(key);
  if (prev) queryClient.setQueryData<Settings>(key, { ...prev, theme });
  try {
    const next = await rpc('settings.update', { patch: { theme } });
    if (mine !== persistSeq) return;
    pendingTheme = null;
    stopWatching();
    queryClient.setQueryData(key, next);
  } catch (err) {
    if (mine !== persistSeq) return;
    const { code } = RpcError.from(err);
    if (code === 'network' || code === 'timeout') {
      watchForReplay();
      return;
    }
    // The server answered and refused: keep the local choice; settings reconcile on the next load.
    pendingTheme = null;
    stopWatching();
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

/** Live `prefers-reduced-motion: reduce`, for motion that CSS alone can't stop (timers, rotation). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, () => mql(MOTION_Q)?.matches ?? false, () => false);
}

export interface ThemeSyncProps {
  settingsTheme?: Theme;
  /** The settings appearance fields; absent while settings load (the mirror holds until then). */
  appearance?: Partial<Appearance>;
}

/**
 * Mount once (the shell does). Syncs the stores from settings and applies
 * data-theme, data-reduced-motion and the appearance attributes.
 */
export function ThemeSync({ settingsTheme, appearance }: ThemeSyncProps) {
  const setLocal = useThemeStore((s) => s.set);
  useEffect(() => {
    // An unconfirmed choice stands over the server's older theme (persistTheme).
    if (settingsTheme && pendingTheme === null) setLocal(settingsTheme);
  }, [settingsTheme, setLocal]);

  const setAppearance = useAppearanceStore((s) => s.set);
  const accent = appearance?.accent;
  const oledBlack = appearance?.oledBlack;
  const density = appearance?.density;
  const uiScale = appearance?.uiScale;
  useEffect(() => {
    if (accent === undefined && oledBlack === undefined && density === undefined && uiScale === undefined) return;
    setAppearance(sanitizeAppearance({ accent, oledBlack, density, uiScale }));
  }, [accent, oledBlack, density, uiScale, setAppearance]);

  const theme = useThemeStore((s) => s.theme);
  const prefersDark = useSyncExternalStore(subscribeDark, systemPrefersDark, () => true);
  const reducedMotion = useReducedMotion();
  const eff = useAppearance();
  const [effAccent, effOled, effDensity, effScale] = [eff.accent, eff.oledBlack, eff.density, eff.uiScale];
  useEffect(() => {
    const resolved = resolveTheme(theme, prefersDark);
    applyThemeToDocument(resolved, reducedMotion);
    applyAppearanceToDocument({ accent: effAccent, oledBlack: effOled, density: effDensity, uiScale: effScale }, resolved);
  }, [theme, prefersDark, reducedMotion, effAccent, effOled, effDensity, effScale]);
  return null;
}
