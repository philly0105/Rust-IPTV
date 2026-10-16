const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Tabbable descendants in DOM order, skipping hidden ones. A negative tabindex takes an element
 * out of the Tab order even when it is natively focusable (the inactive items of a roving group),
 * so a dialog's first-focus fallback and Tab trap never land on one.
 */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.hasAttribute('disabled') || el.getAttribute('aria-hidden') === 'true') return false;
    if (Number(el.getAttribute('tabindex')) < 0) return false;
    if (el.closest('[inert]')) return false;
    // jsdom has no layout; treat everything as visible there.
    const rects = el.getClientRects();
    return rects.length > 0 || typeof navigator === 'undefined' || /jsdom/i.test(navigator.userAgent);
  });
}

let announcePending: HTMLElement | null = null;
const announced = new WeakSet<Event>();

/**
 * For focus moved inside a layout-effect cleanup (a dialog or toast closing). Cleanups run while
 * React commits, and React ignores DOM events during a commit: the element gains focus, but the
 * React onFocus handlers above it never run (L3-live-2: Live lost track of the focused channel row,
 * so F2 and Shift+Delete did nothing until an arrow key moved focus). Once the commit is over (a
 * microtask later), React hears of the focus through a focusin event on the element, if focus is
 * still there. Several calls in one commit announce only the last element. Native focusin
 * listeners see the event too; it has no relatedTarget, so a handler that reads where focus came
 * from checks {@link isAnnouncedFocus} first.
 */
export function announceFocusAfterCommit(el: HTMLElement): void {
  const scheduled = announcePending !== null;
  announcePending = el;
  if (scheduled) return;
  queueMicrotask(() => {
    const target = announcePending;
    announcePending = null;
    if (target && target.isConnected && document.activeElement === target) {
      const event = new FocusEvent('focusin', { bubbles: true, composed: true });
      announced.add(event);
      target.dispatchEvent(event);
    }
  });
}

/** True for the focusin sent by {@link announceFocusAfterCommit}: focus did not move, so it came from nowhere new. */
export function isAnnouncedFocus(event: Event): boolean {
  return announced.has(event);
}

/** True when the keyboard event comes from a text-entry element. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
  }
  return false;
}
