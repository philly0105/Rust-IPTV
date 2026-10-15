import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { useShellStore } from '@/shell';
import { isTypingTarget } from '@/ui';

/**
 * True when a bare Escape should mean "go back" on a VOD page: nothing else
 * owns the key (an input, a dialog, a menu, the shell palette/help/panel, the
 * player overlay, fullscreen or PiP). Exported for tests.
 */
export function isBackEscape(e: KeyboardEvent): boolean {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return false;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
  if (isTypingTarget(e.target)) return false;
  const target = e.target instanceof Element ? e.target : null;
  if (target?.closest('[data-mpv-reserved], [data-pip-layer], [role="menu"], [role="dialog"]')) return false;
  if (typeof document !== 'undefined') {
    if (document.fullscreenElement) return false;
    // Escape closes the innermost thing first: a visible tooltip hides on this press, Back waits for the next.
    if (document.querySelector('[role="dialog"][aria-modal="true"], [data-pip-layer]:not([hidden]), [role="tooltip"]')) return false;
  }
  const shell = useShellStore.getState();
  if (shell.paletteOpen || shell.helpOpen || shell.panelOpen) return false;
  return true;
}

/**
 * Escape goes back (grid to categories, detail to where you came from).
 * Listens on document, ahead of the shell's window-level Escape (which only
 * blurs), and claims the key so the shell does not also act on it.
 */
export function useEscapeBack(enabled: boolean, onBack: () => void): void {
  const cb = useRef(onBack);
  cb.current = onBack;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isBackEscape(e)) return;
      e.preventDefault();
      cb.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled]);
}

/**
 * "Back" for a VOD page: pop the in-app history entry when there is one, so the
 * page you came from restores its scroll and focus; when the page was opened
 * cold (deep link, reload) go to `fallbackHref` instead, replacing this entry so
 * Back does not ping-pong between the two.
 */
export function useGoBack(fallbackHref: string): () => void {
  const navigate = useNavigate();
  const location = useLocation();
  return () => {
    if (location.key !== 'default') void navigate(-1);
    else void navigate(fallbackHref, { replace: true });
  };
}

/**
 * Escape on a detail page: back to where you came from (the grid restores its
 * place), or to the movies/series landing when the page was opened cold.
 */
export function useDetailEscapeBack(enabled: boolean, fallbackHref: string): void {
  useEscapeBack(enabled, useGoBack(fallbackHref));
}
