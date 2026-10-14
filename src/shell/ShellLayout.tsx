import { lazy, Suspense, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useNavigate } from 'react-router';

import { ChannelEditDialogHost } from '@/features/channeledit/DialogHost';
import { ListsDialogHost } from '@/features/lists/host';
import { registerGateHost } from '@/features/parental/gate';
import { useParentalEvents } from '@/features/parental/status';
import { ExternalPlaybackFooter, PlayerDock, restorePlayback } from '@/features/player';
import { useWatchStatsReporter } from '@/features/stats/reporter';
import '@/i18n';
import { cn, focusToasts, Skeleton, ToastViewport } from '@/ui';

import { ContextPanel } from './ContextPanel';
import { useLanguageSync, useLastRoutePersistence, useShellEvents, useWindowStatePersistence } from './effects';
import { Header } from './Header';
import { Rail } from './Rail';
import { useShortcut } from './shortcuts';
import { useShellStore } from './store';
import { ThemeSync, useTheme } from './theme';
import { useMediaQuery } from './useMediaQuery';
import { useSettings } from './useSettings';

// recording: renders nothing; split out so the recording hooks and schedule logic stay out of the main chunk.
const RecordingWatcher = lazy(() => import('@/features/recording/components/RecordingWatcher').then((m) => ({ default: m.RecordingWatcher })));
// parental: the PIN dialogs (C2) load with the shell, outside the main chunk.
const ParentalGateHost = lazy(() => import('@/features/parental/GateHost').then((m) => ({ default: m.ParentalGateHost })));
// The palette and the `?` overlay only show on demand; they load right after the shell, outside the main chunk.
const CommandPalette = lazy(() => import('./CommandPalette').then((m) => ({ default: m.CommandPalette })));
const ShortcutOverlay = lazy(() => import('./ShortcutOverlay').then((m) => ({ default: m.ShortcutOverlay })));

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
 * Focuses the search field once it exists. The search page loads lazily, so on a first visit its
 * field (in the header) mounts only after the chunk arrives, which can take well over a frame:
 * poll briefly instead of guessing one delay.
 */
function focusSearchWhenReady(deadline = Date.now() + 3000) {
  const field = document.querySelector<HTMLInputElement>('[data-page-search], [data-shell-search]');
  if (field) field.focus();
  else if (Date.now() < deadline) setTimeout(() => focusSearchWhenReady(deadline), 50);
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
      s.setPaletteOpen(!s.paletteOpen);
    },
    { description: t('scPalette'), area, allowInInput: true },
  );
  useShortcut(
    'mod+f',
    () => {
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
    { description: t('scSearch'), area, allowInInput: true },
  );
  useShortcut(
    'mod+r',
    () => {
      useShellStore.getState().setPaletteOpen(false);
      navigate('/recent');
    },
    { description: t('scRecent'), area, allowInInput: true },
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
    { description: t('scTheme'), area, allowInInput: true },
  );
  useShortcut('f8', () => focusToasts(), { description: t('scNotifications'), area, allowInInput: true });
  useShortcut(
    'escape',
    () => {
      const s = useShellStore.getState();
      if (s.paletteOpen) return s.setPaletteOpen(false);
      if (s.helpOpen) return s.setHelpOpen(false);
      if (s.panelOpen) return s.setPanelOpen(false);
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) active.blur();
    },
    { description: t('scEscape'), area, allowInInput: true },
  );
  return null;
}

/**
 * Text-free stand-in for the shell, shown on a fresh profile while the
 * server's language loads (no English first frame). Same geometry as the
 * real rail and header, so nothing jumps when it swaps out.
 */
function ShellSkeleton({ collapsed }: { collapsed: boolean }) {
  return (
    <div className="flex h-dvh min-h-0 w-full overflow-hidden bg-bg text-fg" data-testid="shell-skeleton" aria-busy="true">
      <div
        aria-hidden
        className={cn(
          'flex h-full shrink-0 flex-col gap-3 border-e border-divider bg-surface px-3 pt-5',
          collapsed ? 'w-(--rail-width-collapsed)' : 'w-(--rail-width)',
        )}
      >
        <Skeleton className="mb-4 h-8 w-8 rounded-md" />
        {Array.from({ length: 7 }, (_, i) => (
          <Skeleton key={i} className={cn('h-8 rounded-md', collapsed ? 'w-10' : 'w-4/5')} />
        ))}
      </div>
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <div aria-hidden className="flex h-(--header-height) shrink-0 items-center gap-3 border-b border-divider px-4 sm:gap-4 sm:px-5">
          <Skeleton className="h-6 w-40" />
          <div className="flex-1" />
          <Skeleton className="hidden h-8 w-[clamp(10rem,22vw,20rem)] rounded-md lg:block" />
          <Skeleton className="h-8 w-8 rounded-md" />
          <Skeleton className="h-8 w-8 rounded-md" />
        </div>
        <div aria-hidden className="flex flex-col gap-6 p-4 sm:p-8">
          <Skeleton className="h-48 w-full rounded-lg" />
          <Skeleton className="h-5 w-48" />
          <div className="flex gap-4 overflow-hidden">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="aspect-[2/3] w-[11.2rem] shrink-0 rounded-md" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Layout route (C7): rail, header, context panel, outlet, player dock, and
 * the external playback footer, plus palette, shortcut overlay, and toasts.
 */
export function ShellLayout() {
  const { t } = useTranslation('shell');
  const settings = useSettings();
  const railPref = useShellStore((s) => s.railCollapsed);
  const narrow = useMediaQuery('(max-width: 1023px)');
  const wide = useMediaQuery('(min-width: 1440px)');
  const collapsed = railPref || narrow;

  useShellEvents();
  useParentalEvents();
  // Run 2 C7: counts watch time from the player store; renders nothing.
  useWatchStatsReporter();
  // The layout counts as the parental gate's host from its first render, so a PIN request made
  // before the dialogs can show (restoring a locked channel under the language skeleton, or
  // while their chunk loads) waits in the queue instead of being refused.
  useEffect(() => registerGateHost(), []);
  const languageSettled = useLanguageSync(settings.data?.language, settings.isError);
  useLastRoutePersistence(settings.isSuccess, settings.data?.lastRoute);
  useWindowStatePersistence();

  useEffect(() => {
    if (playbackRestored) return;
    playbackRestored = true;
    void Promise.resolve()
      .then(() => restorePlayback())
      .catch(() => {});
  }, []);

  if (!languageSettled) {
    return (
      <>
        <ThemeSync settingsTheme={settings.data?.theme} appearance={settings.data} />
        <ShellSkeleton collapsed={collapsed} />
      </>
    );
  }

  return (
    <div className="flex h-dvh min-h-0 w-full overflow-hidden bg-bg text-fg" data-testid="shell">
      <a
        href="#main"
        className="sr-only z-[90] rounded-md bg-accent px-4 py-2 text-accent-fg focus:not-sr-only focus:fixed focus:top-3 focus:start-3"
      >
        {t('skipToContent')}
      </a>
      <ThemeSync settingsTheme={settings.data?.theme} appearance={settings.data} />
      <GlobalShortcuts />
      <Rail collapsed={collapsed} autoCollapsed={narrow} />
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <Header panelInline={wide} />
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
          <ContextPanel inline={wide} />
        </div>
        <ExternalPlaybackFooter />
      </div>
      <PlayerDock />
      <Suspense fallback={null}>
        <CommandPalette />
        <ShortcutOverlay />
      </Suspense>
      <ToastViewport />
      <Suspense fallback={null}>
        <ParentalGateHost />
      </Suspense>
      {/* recording: */}
      <Suspense fallback={null}>
        <RecordingWatcher />
      </Suspense>
      {/* Run 2: the list and rename dialogs. Both hosts are small; each dialog is its own lazy chunk. */}
      <ListsDialogHost />
      <ChannelEditDialogHost />
    </div>
  );
}
