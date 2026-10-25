import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useLocation, useNavigate } from 'react-router';

import type { Settings } from '@/api/types';
import { isDesktop } from '@/api/transport';
import { leaveBareWindowFullscreen } from '@/api/window';
import { ChannelEditDialogHost } from '@/features/channeledit/DialogHost';
import { ListsDialogHost } from '@/features/lists/host';
import { registerGateHost } from '@/features/parental/gate';
import { useParentalEvents } from '@/features/parental/status';
import '@/i18n';
import { cn, focusToasts, Skeleton, ToastViewport } from '@/ui';
import { isTypingTarget } from '@/ui/focus';

import { ConnectionBanner, ConnectionWatcher } from './connection';
import { ContextPanel } from './ContextPanel';
import { useLanguageSync, useLastRoutePersistence, useShellEvents, useWindowStatePersistence } from './effects';
import { focusSearchWhenReady } from './focusSearch';
import { Header, HEADER_SEARCH_WIDTH } from './Header';
import { LIBRARY_LINKS, PHONE_QUERY, rememberRouteSource, WATCH_LINKS } from './navigation';
import { Rail } from './Rail';
import { SecureContextNotice } from './SecureContextNotice';
import { useOutletScrollMemory } from './scrollMemory';
import { modalOpen, useShortcut } from './shortcuts';
import { useShellStore } from './store';
import { ThemeSync, useTheme } from './theme';
import { useMediaQuery } from './useMediaQuery';
import { useSettings, useSettingsValue } from './useSettings';
import { SHELL_BOTTOM_INSET, TabBar, TAB_BAR_HEIGHT } from './TabBar';

// player: the dock and the external-playback footer carry the whole playback UI (surfaces,
// controls, engines, the store), about a third of the app's code, in their own chunk (C4 entry
// budget, docs/architecture/performance.md). The shell renders only once the router has loaded
// the first route's chunks, and the player request waits for that and then for the browser's
// first idle moment, so it never competes with the page being opened. It starts at once when
// there is playback to restore, and on the first pointer or key press (the start of any play
// intent; a page that plays imports the player itself, so by then the chunk is usually in).
type PlayerModule = typeof import('@/features/player');
let loadedPlayer: PlayerModule | null = null;
let playerModule: Promise<PlayerModule> | null = null;

function loadPlayerModule(): Promise<PlayerModule> {
  playerModule ??= import('@/features/player').then((m) => (loadedPlayer = m));
  return playerModule;
}

/** The player's resume record in sessionStorage (RESUME_KEY in features/player/store.ts). */
export const PLAYER_RESUME_KEY = 'player.resume';
/** Longest the idle wait holds the player back after the shell's first paint. */
export const PLAYER_IDLE_TIMEOUT_MS = 2000;
/**
 * How long the shell leaves the first route to itself before it starts the idle wait for the
 * player (about 200 KB of chunks to fetch, parse and compile): they arrived at about 414 ms on a
 * cold load, among the route's own chunks and in its long tasks (L3-perf-ui-6). A press still
 * loads the player at once.
 */
export const PLAYER_PREFETCH_DELAY_MS = 2500;

function playbackToRestore(): boolean {
  try {
    return sessionStorage.getItem(PLAYER_RESUME_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Calls `load` once: at once when `now`, else on the first idle moment (at most
 * PLAYER_IDLE_TIMEOUT_MS; a macrotask where requestIdleCallback is missing) once `delayMs` has
 * passed, or on the first pointer or key press, whichever comes first. Presses count from the
 * start. Returns the cancel function.
 */
export function schedulePlayerLoad(load: () => void, now: boolean, win: Window = window, delayMs = 0): () => void {
  const intents = ['pointerdown', 'keydown'] as const;
  let idle: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    for (const type of intents) win.removeEventListener(type, fire, true);
    if (idle !== undefined) win.cancelIdleCallback?.(idle);
    if (timer !== undefined) clearTimeout(timer);
    idle = timer = undefined;
  };
  function fire() {
    cancel();
    load();
  }
  if (now) {
    load();
    return () => undefined;
  }
  for (const type of intents) win.addEventListener(type, fire, { capture: true, passive: true });
  const waitForIdle = () => {
    timer = undefined;
    if (typeof win.requestIdleCallback === 'function') idle = win.requestIdleCallback(fire, { timeout: PLAYER_IDLE_TIMEOUT_MS });
    else timer = setTimeout(fire, 0);
  };
  if (delayMs > 0) timer = setTimeout(waitForIdle, delayMs);
  else waitForIdle();
  return cancel;
}

/** The player module once loaded (on the first render when an earlier shell already loaded it). */
function usePlayerModule(): PlayerModule | null {
  const [player, setPlayer] = useState(loadedPlayer);
  useEffect(() => {
    if (player) return;
    let live = true;
    const cancel = schedulePlayerLoad(
      () => {
        // A failed chunk load leaves the shell usable without the dock, like a missing engine.
        void loadPlayerModule()
          .then((m) => {
            if (live) setPlayer(m);
          })
          .catch(() => {});
      },
      playerModule !== null || playbackToRestore(),
      window,
      PLAYER_PREFETCH_DELAY_MS,
    );
    return () => {
      live = false;
      cancel();
    };
  }, [player]);
  return player;
}

/**
 * Run 2 C7: counts watch time from the player store for as long as the shell is mounted. The
 * reporter loads with the player store in a lazy chunk instead of pulling it into the main one,
 * and starts with the player module (`enabled`); it reads the store's state when it starts.
 */
function useWatchStats(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let stop: (() => void) | null = null;
    void import('@/features/stats/reporter')
      .then((m) => {
        if (live) stop = m.startWatchStatsReporter();
      })
      .catch(() => {});
    return () => {
      live = false;
      stop?.();
    };
  }, [enabled]);
}

// recording: renders nothing; split out so the recording hooks and schedule logic stay out of the main chunk.
const RecordingWatcher = lazy(() => import('@/features/recording/components/RecordingWatcher').then((m) => ({ default: m.RecordingWatcher })));
// parental: the PIN dialogs (C2) load with the shell, outside the main chunk.
const ParentalGateHost = lazy(() => import('@/features/parental/GateHost').then((m) => ({ default: m.ParentalGateHost })));
// The palette and the `?` overlay only show on demand; they load right after the shell, outside the main chunk.
const CommandPalette = lazy(() => import('./CommandPalette').then((m) => ({ default: m.CommandPalette })));
const ShortcutOverlay = lazy(() => import('./ShortcutOverlay').then((m) => ({ default: m.ShortcutOverlay })));
// Run 3 C7: the first-run tour and What's new. The host (decision, store) loads right after the
// shell; the overlays and release notes are its own lazy chunks. Imported from `host`, not the
// barrel, so RELEASE_NOTES and its icons stay out of this chunk.
const OnboardingHost = lazy(() => import('@/features/onboarding/host').then((m) => ({ default: m.OnboardingHost })));

/** Opens the command palette from anywhere. */
export function openPalette(): void {
  useShellStore.getState().setPaletteOpen(true);
}

/** Opens the `?` keyboard shortcut overlay from anywhere. */
export function openShortcutHelp(): void {
  useShellStore.getState().setHelpOpen(true);
}

let playbackRestored = false;

/**
 * F11 (L2-desktop-8). With a source in the dock it is the player's fullscreen, as `f` is.
 * Otherwise it fills the screen with the whole app: element fullscreen on the page, which the
 * desktop window follows (bindWindowFullscreen in main.tsx), so the key works on the desktop,
 * where WebView2 has no F11 of its own, and in the browser alike. Exported for tests.
 */
export function toggleFullscreenKey(): void {
  const player = loadedPlayer?.usePlayerStore?.getState();
  if (player?.source && player.mode !== 'external') {
    player.toggleFullscreen();
    return;
  }
  if (document.fullscreenElement) {
    void document.exitFullscreen?.()?.catch(() => undefined);
    return;
  }
  const enter = () => void document.documentElement.requestFullscreen?.()?.catch(() => undefined);
  // A desktop window that opened fullscreen (settings.windowStart) has no page fullscreen to leave:
  // F11 takes the window itself out.
  if (isDesktop) void leaveBareWindowFullscreen().then((left) => left || enter());
  else enter();
}

/**
 * Ctrl+F and Ctrl+R leave the page, which would throw away a dialog's or a field's typed text
 * (the Add source URL and credentials): there they claim the key, so the browser neither
 * reloads nor opens its find bar, and do nothing. From the command palette they still run.
 */
function navigationKeyBlocked(e: KeyboardEvent): boolean {
  if (useShellStore.getState().paletteOpen) return false;
  return modalOpen() || isTypingTarget(e.target);
}

function GlobalShortcuts() {
  const { t } = useTranslation('shell');
  const navigate = useNavigate();
  const area = 'Global';
  const { toggle: toggleTheme } = useTheme();

  useShortcut(
    'mod+k',
    () => {
      const s = useShellStore.getState();
      // Inside the palette it closes it; over another dialog it does not open.
      if (!s.paletteOpen && modalOpen()) return;
      s.setPaletteOpen(!s.paletteOpen);
    },
    { description: t('scPalette'), area, allowInInput: true, allowInModal: true },
  );
  useShortcut(
    'mod+f',
    (e) => {
      if (navigationKeyBlocked(e)) return;
      useShellStore.getState().setPaletteOpen(false);
      const field = document.querySelector<HTMLInputElement>('[data-shell-search], [data-page-search]');
      if (field && !window.location.pathname.startsWith('/search')) {
        field.focus();
        field.select();
        return;
      }
      navigate('/search');
      focusSearchWhenReady();
    },
    { description: t('scSearch'), area, allowInInput: true, allowInModal: true },
  );
  // Desktop only: the app window has no reload, so Ctrl+R is free there. In a browser it is the
  // reload key, and claiming it sent a user refreshing a stuck page to Recently watched instead
  // (SH-ctrl-r-browser); there the palette and the rail lead to it.
  useShortcut(
    'mod+r',
    (e) => {
      if (navigationKeyBlocked(e)) return;
      useShellStore.getState().setPaletteOpen(false);
      navigate('/recent');
    },
    { description: t('scRecent'), area, allowInInput: true, allowInModal: true, enabled: isDesktop },
  );
  useShortcut(
    '?',
    () => {
      const s = useShellStore.getState();
      s.setHelpOpen(!s.helpOpen);
    },
    { description: t('scHelp'), area },
  );
  useShortcut(
    'mod+shift+l',
    () => toggleTheme(),
    { description: t('scTheme'), area, allowInInput: true, allowInModal: true },
  );
  useShortcut('f8', () => focusToasts(), { description: t('scNotifications'), area, allowInInput: true });
  useShortcut('f11', toggleFullscreenKey, { description: t('scFullscreen'), area, allowInInput: true, allowInModal: true });
  useShortcut(
    'escape',
    () => {
      const s = useShellStore.getState();
      if (s.paletteOpen) return s.setPaletteOpen(false);
      if (s.helpOpen) return s.setHelpOpen(false);
      if (s.panelOpen) return s.setPanelOpen(false);
      // Leaves a search or text field; a focused link, card or button keeps focus (and the Tab position).
      const active = document.activeElement;
      if (active instanceof HTMLElement && isTextEntry(active)) active.blur();
    },
    { description: t('scEscape'), area, allowInInput: true },
  );
  return null;
}

const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file', 'image']);

/** A field that takes typed text: Escape leaves it. */
export function isTextEntry(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(el.type);
  return el instanceof HTMLTextAreaElement || el.isContentEditable === true;
}

/**
 * Navigation side effects of the shell: overlays that belong to the page being left (the
 * palette, the `?` overlay, the context drawer) close when the location changes, Back or
 * Forward included, and the outlet keeps its scroll position and focus per history entry.
 */
function ShellNavigationEffects() {
  const { key, pathname } = useLocation();
  const last = useRef(key);
  // The phone tab bar's Live TV tab, and Live TV, Movies and Series in the rail and the palette,
  // open the source the user last opened.
  useEffect(() => {
    rememberRouteSource(pathname);
  }, [pathname]);
  useEffect(() => {
    if (last.current === key) return;
    last.current = key;
    const s = useShellStore.getState();
    if (s.paletteOpen) s.setPaletteOpen(false);
    if (s.helpOpen) s.setHelpOpen(false);
    if (s.panelOpen) s.setPanelOpen(false);
  }, [key]);
  useOutletScrollMemory();
  return null;
}

// SH-1 (performance audit): the shell's router and settings readers live in these leaves. The
// router hands every route a new context on each navigation, and `useNavigate`/`useLocation` in
// ShellLayout re-rendered it, and everything under it (dock, controls, rail, header), on each
// navigation, each typed `?q=` and each `lastRoute` save. ShellLayout reads only the language.

/** Wires app events to the cache, toasts and navigation (useShellEvents). Renders nothing. */
function ShellEvents() {
  useShellEvents();
  return null;
}

/** Saves the current screen as settings.lastRoute (useLastRoutePersistence). Renders nothing. */
function LastRoutePersistence() {
  const settings = useSettings();
  useLastRoutePersistence(settings.isSuccess, settings.data?.lastRoute);
  return null;
}

/** ThemeSync fed from settings, so a settings write re-renders this leaf only. */
function SettingsThemeSync() {
  const settings = useSettings();
  return <ThemeSync settingsTheme={settings.data?.theme} appearance={settings.data} />;
}

const selectLanguage = (s: Settings) => s.language;

/**
 * Text-free stand-in for the shell (SH-boot-skeletons): the router's first frame while a deep
 * link's page chunks load (routes.tsx AppLoading), and the shell's own while a fresh profile
 * waits for the server's language (no English first frame). One geometry for both, laid out like
 * the real rail and header (the brand row, the Watch and Library groups at --rail-item-height,
 * the footer row, the search slot, the phone tab bar), so nothing jumps as the shell replaces it.
 */
export function ShellSkeleton({ collapsed, railHidden, phone = false, testId = 'shell-skeleton' }: { collapsed: boolean; railHidden: boolean; phone?: boolean; testId?: string }) {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => (
      <div key={i} className={cn('flex h-(--rail-item-height) items-center gap-3', collapsed ? 'justify-center' : 'px-3')}>
        {/* The rail's 20 px glyph box, so the label bars start where the labels will. */}
        <span className="inline-flex size-5 shrink-0 items-center justify-center">
          <Skeleton className="size-[calc(18rem/15)] rounded-sm" />
        </span>
        {!collapsed && <Skeleton className={cn('h-3', i % 3 === 0 ? 'w-24' : i % 3 === 1 ? 'w-20' : 'w-28')} />}
      </div>
    ));
  const label = () => (collapsed ? <span className="mx-3 my-1.5 block border-t border-divider" /> : <Skeleton className="ms-3 mt-4 mb-2 h-2.5 w-14" />);
  return (
    <div className="flex h-dvh min-h-0 w-full overflow-hidden bg-bg text-fg" data-testid={testId} aria-busy="true">
      {!phone && (
        <div
          aria-hidden
          hidden={railHidden}
          className={cn('flex h-full shrink-0 flex-col border-e border-divider bg-surface', collapsed ? 'w-(--rail-width-collapsed)' : 'w-(--rail-width)')}
        >
          <div className={cn('flex h-(--header-height) shrink-0 items-center gap-2.5', collapsed ? 'justify-center' : 'px-4')}>
            <Skeleton className={cn('shrink-0 rounded-[22%]', collapsed ? 'size-8' : 'size-7')} />
            {!collapsed && <Skeleton className="h-4 w-28" />}
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden px-2">
            {/* Every Watch link, Live TV, Movies and Series included: most sources have movies and series. */}
            {rows(WATCH_LINKS.length)}
            {label()}
            {rows(LIBRARY_LINKS.length)}
          </div>
          {/* The footer row: Settings, and beside it (expanded) the shortcuts and collapse buttons. */}
          <div className={cn('flex shrink-0 items-center gap-0.5 border-t border-divider p-2', collapsed && 'flex-col')}>
            <div className="min-w-0 flex-1">{rows(1)}</div>
            {Array.from({ length: collapsed ? 1 : 2 }, (_, i) => (
              <div key={i} className={cn('flex h-(--rail-item-height) shrink-0 items-center justify-center', collapsed ? 'w-full' : 'w-(--rail-item-height)')}>
                <Skeleton className="size-[calc(18rem/15)] rounded-sm" />
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <div aria-hidden className="flex h-(--header-height) shrink-0 items-center gap-3 border-b border-divider px-(--page-gutter) sm:gap-4">
          <Skeleton className="h-6 w-32" />
          <div className="flex-1" />
          {!phone && (
            <>
              <Skeleton className={cn('me-1 h-8 rounded-md', HEADER_SEARCH_WIDTH)} />
              <Skeleton className="size-10 rounded-md" />
            </>
          )}
        </div>
        <div aria-hidden className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden px-(--page-gutter) py-6">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-40 w-full max-w-[80rem] rounded-lg" />
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-24 w-full max-w-[80rem] rounded-lg" />
        </div>
        {phone && (
          <div aria-hidden className="grid shrink-0 grid-cols-5 items-center border-t border-divider bg-surface pb-[env(safe-area-inset-bottom,0px)]" style={{ height: SHELL_BOTTOM_INSET }}>
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="flex flex-col items-center gap-1.5" style={{ height: TAB_BAR_HEIGHT }}>
                <Skeleton className="mt-2.5 size-[calc(22rem/15)] rounded-sm" />
                <Skeleton className="h-2 w-10" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * While the phone tab bar shows, --shell-bottom-inset on <html> holds its height (safe area
 * included), so overlays fixed to the bottom of the window (the mini player, toasts) can lift
 * above it; 0px otherwise. On <html>, not the shell's root, because those overlays portal to
 * <body>.
 */
function useShellBottomInset(tabBar: boolean): void {
  useLayoutEffect(() => {
    const html = document.documentElement;
    html.style.setProperty('--shell-bottom-inset', tabBar ? SHELL_BOTTOM_INSET : '0px');
    return () => {
      html.style.removeProperty('--shell-bottom-inset');
    };
  }, [tabBar]);
}

/**
 * Layout route (C7): rail (or, on a phone, the bottom tab bar), header, the offline strip,
 * context panel, outlet, player dock, and the external playback footer, plus palette, shortcut
 * overlay, and toasts.
 */
export function ShellLayout() {
  const { t } = useTranslation('shell');
  const language = useSettingsValue(selectLanguage);
  const railPref = useShellStore((s) => s.railCollapsed);
  const narrow = useMediaQuery('(max-width: 1023px)');
  const wide = useMediaQuery('(min-width: 1440px)');
  // Below sm the tab bar replaces the rail (CB-PHONE-NAV).
  const phone = useMediaQuery(PHONE_QUERY);
  const collapsed = railPref || narrow;
  // Hiding the rail is a narrow-window choice: from 1024 px up it always shows, and on a phone
  // there is no rail to show.
  const railHidden = useShellStore((s) => s.railHidden) && narrow && !phone;

  useParentalEvents();
  const player = usePlayerModule();
  useWatchStats(!!player);
  // The layout counts as the parental gate's host from its first render, so a PIN request made
  // before the dialogs can show (restoring a locked channel under the language skeleton, or
  // while their chunk loads) waits in the queue instead of being refused.
  useEffect(() => registerGateHost(), []);
  const languageSettled = useLanguageSync(language.data, language.isError);
  useWindowStatePersistence();
  useShellBottomInset(phone && languageSettled);

  useEffect(() => {
    if (playbackRestored) return;
    playbackRestored = true;
    // Nothing to restore: leave the player to its idle-time load.
    if (!playbackToRestore()) return;
    void loadPlayerModule()
      .then((m) => m.restorePlayback())
      .catch(() => {});
  }, []);

  // The same first child in both branches, so the leaves stay mounted when the skeleton goes.
  const leaves = (
    <>
      <ShellEvents />
      <LastRoutePersistence />
      <SettingsThemeSync />
      <ConnectionWatcher />
    </>
  );

  if (!languageSettled) {
    return (
      <>
        {leaves}
        <ShellSkeleton collapsed={collapsed} railHidden={railHidden} phone={phone} />
      </>
    );
  }

  return (
    <>
      {leaves}
      {/* The side safe areas: a phone on its side keeps the rail and the header off the notch. */}
      <div className="flex h-dvh min-h-0 w-full overflow-hidden bg-bg ps-[env(safe-area-inset-left,0px)] pe-[env(safe-area-inset-right,0px)] text-fg" data-testid="shell">
        <a
          href="#main"
          className="sr-only z-[90] rounded-md bg-accent-solid px-4 py-2 text-accent-solid-fg focus:not-sr-only focus:fixed focus:top-3 focus:start-3"
        >
          {t('skipToContent')}
        </a>
        <GlobalShortcuts />
        {!railHidden && !phone && <Rail collapsed={collapsed} autoCollapsed={narrow} />}
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
          <Header panelInline={wide} railHidden={railHidden} phone={phone} />
          <ConnectionBanner />
          <div className="flex min-h-0 flex-1">
            {/*
              The outlet is a bounded flex column at every width: the row above
              has a definite height (h-dvh minus header and footer), and
              min-h-0 lets it shrink. Pages either grow (main scrolls) or fill
              it with `flex-1 min-h-0` / `h-full` and scroll inside, which gives
              VirtualList / VirtualGrid a bounded scroll parent.
            */}
            <main
              id="main"
              tabIndex={-1}
              data-shell-outlet=""
              className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto focus:outline-none"
            >
              <Outlet />
            </main>
            <ShellNavigationEffects />
            <ContextPanel inline={wide} />
          </div>
          {player && <player.ExternalPlaybackFooter />}
          {phone && <TabBar />}
        </div>
        {player && <player.PlayerDock />}
        <Suspense fallback={null}>
          <CommandPalette />
          <ShortcutOverlay />
        </Suspense>
        <ToastViewport />
        <SecureContextNotice />
        <Suspense fallback={null}>
          <ParentalGateHost />
        </Suspense>
        {/* recording: it imports the player, so it mounts with it (it picks up reminders that fired before it listened). */}
        {player && (
          <Suspense fallback={null}>
            <RecordingWatcher />
          </Suspense>
        )}
        {/* Run 2: the list and rename dialogs. Both hosts are small; each dialog is its own lazy chunk. */}
        <ListsDialogHost />
        <ChannelEditDialogHost />
        <Suspense fallback={null}>
          <OnboardingHost />
        </Suspense>
      </div>
    </>
  );
}
