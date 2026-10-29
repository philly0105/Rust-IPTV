/**
 * The container overlays (toasts, dialogs, menus) portal into. In element fullscreen (the
 * player, the multi-view wall) the browser paints only the fullscreen element's subtree, so a
 * layer portaled to <body> sits behind it, unseen and out of reach. Window fill similarly has a
 * raised layer that can cover body-portaled tooltips. One shared host follows the visible layer
 * and goes back to <body> when it ends. Moving the host
 * node keeps every portal's React state; focus inside it is put back after the move.
 */

let host: HTMLDivElement | null = null;

function target(): HTMLElement {
  const fs = document.fullscreenElement;
  // A <video> or <iframe> in fullscreen paints none of its children.
  const usable = fs instanceof HTMLElement && fs.isConnected && !(fs instanceof HTMLMediaElement) && !(fs instanceof HTMLIFrameElement);
  if (usable) return fs;
  const windowFill = document.querySelector<HTMLElement>('[data-player-window-layer]:not([hidden])');
  return windowFill?.isConnected ? windowFill : document.body;
}

function place(): void {
  if (!host) return;
  const to = target();
  if (host.parentNode === to) return;
  const active = document.activeElement;
  const refocus = active instanceof HTMLElement && host.contains(active) ? active : null;
  to.appendChild(host);
  if (refocus && document.activeElement !== refocus) refocus.focus({ preventScroll: true });
}

/** The node to pass to `createPortal`. Call it while rendering the open layer. */
export function portalContainer(): HTMLElement {
  if (!host) {
    host = document.createElement('div');
    host.dataset['portalHost'] = '';
    // No box of its own: the fixed layers inside still place against the viewport.
    host.style.display = 'contents';
    // The wall hides an idle pointer with cursor: none; a toast or menu over it needs one.
    host.style.cursor = 'auto';
    document.addEventListener('fullscreenchange', place);
  }
  place();
  return host;
}
