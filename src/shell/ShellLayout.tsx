import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useNavigate } from 'react-router';

import { ExternalPlaybackFooter, PlayerDock, restorePlayback } from '@/features/player';
import '@/i18n';
import { focusToasts, ToastViewport } from '@/ui';

import { CommandPalette } from './CommandPalette';
import { ContextPanel } from './ContextPanel';
import { useLanguageSync, useLastRoutePersistence, useShellEvents, useWindowStatePersistence } from './effects';
import { Header } from './Header';
import { Rail } from './Rail';
import { ShortcutOverlay } from './ShortcutOverlay';
import { useShortcut } from './shortcuts';
import { useShellStore } from './store';
import { ThemeSync, useTheme } from './theme';
import { useMediaQuery } from './useMediaQuery';
import { useSettings } from './useSettings';

/** Opens the command palette from anywhere. */
export function openPalette(): void {
  useShellStore.getState().setPaletteOpen(true);
}

/** Opens the `?` keyboard shortcut overlay from anywhere. */
export function openShortcutHelp(): void {
  useShellStore.getState().setHelpOpen(true);
}

let playbackRestored = false;

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
      // The search page focuses its own input; this covers the case it is already open.
      setTimeout(() => document.querySelector<HTMLInputElement>('[data-page-search], [data-shell-search]')?.focus(), 50);
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
  useLanguageSync(settings.data?.language);
  useLastRoutePersistence(settings.isSuccess, settings.data?.lastRoute);
  useWindowStatePersistence();

  useEffect(() => {
    if (playbackRestored) return;
    playbackRestored = true;
    void Promise.resolve()
      .then(() => restorePlayback())
      .catch(() => {});
  }, []);

  return (
    <div className="flex h-dvh min-h-0 w-full overflow-hidden bg-bg text-fg" data-testid="shell">
      <a
        href="#main"
        className="sr-only z-[90] rounded-md bg-accent px-4 py-2 text-accent-fg focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        {t('skipToContent')}
      </a>
      <ThemeSync settingsTheme={settings.data?.theme} />
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
      <CommandPalette />
      <ShortcutOverlay />
      <ToastViewport />
    </div>
  );
}
