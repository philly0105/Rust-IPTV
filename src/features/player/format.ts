/** `1:02:03` / `4:05`. Non-finite or negative values render as `0:00`. */
export function formatTime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Only http(s) and data URLs may reach CSS/`img` for ambient art. */
export function safeImageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return /^(https?:|data:image\/)/i.test(url.trim()) ? url : undefined;
}

export type KeyKind = 'space' | 'letter' | 'arrow';

const TEXT_ROLES = ['textbox', 'combobox', 'searchbox'];
const ARROW_ROLES = ['listbox', 'option', 'grid', 'gridcell', 'menu', 'menuitem', 'menuitemradio', 'slider', 'tab', 'tablist', 'radiogroup', 'radio', 'tree', 'treeitem'];

/**
 * True when the focused target owns this key, so a playback shortcut must not fire.
 * Text fields own every key; buttons and links own space; lists, menus and sliders own arrows;
 * an open dialog or an inert region owns everything.
 */
export function targetOwnsKey(e: Event, kind: KeyKind): boolean {
  if (modalOpen()) return true;
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
  for (const node of path) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.isContentEditable || node.hasAttribute('inert')) return true;
    const tag = node.tagName;
    const role = node.getAttribute('role') ?? '';
    if (tag === 'TEXTAREA' || tag === 'SELECT' || TEXT_ROLES.includes(role)) return true;
    if (tag === 'INPUT') {
      const type = (node as HTMLInputElement).type;
      if (type !== 'range' && type !== 'checkbox' && type !== 'radio' && type !== 'button') return true;
      if (kind !== 'letter') return true;
    }
    if (kind === 'space' && (tag === 'BUTTON' || tag === 'A' || role === 'button' || role === 'switch' || role === 'option' || role === 'menuitem' || role === 'menuitemradio')) return true;
    if (kind === 'arrow' && ARROW_ROLES.includes(role)) return true;
  }
  return false;
}

/** True when a modal dialog is open anywhere on the page. */
export function modalOpen(): boolean {
  return typeof document !== 'undefined' && !!document.querySelector('[aria-modal="true"], dialog[open]');
}
