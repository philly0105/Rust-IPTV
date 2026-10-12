/** `1:02:03` / `4:05`. Non-finite or negative values render as `0:00`. */
export function formatTime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Seconds the arrow keys skip, both as global shortcuts and on a focused seek bar (Shift: 30 s). */
export const SEEK_STEP = 10;
export const SEEK_STEP_LARGE = 30;

/** Seconds behind the end of the seekable window that still count as live (the element's buffer). */
export const LIVE_EDGE_SLACK = 6;
/** mpv's cache runs a few seconds ahead of playback even at the live edge. */
export const LIVE_EDGE_SLACK_MPV = 10;

/**
 * "4:20 / 45:00" for VOD; for live "Live" at the edge or "1:20 behind live". The edge uses the
 * same slack as the control bar's LIVE badge, so the readout and the badge never disagree.
 */
export function positionReadout(
  t: (key: string, opts?: Record<string, unknown>) => string,
  p: { position: number; duration?: number; liveEnd?: number; edgeSlack?: number | undefined },
): string {
  if (p.liveEnd !== undefined) {
    const behind = Math.max(0, p.liveEnd - p.position);
    return behind < (p.edgeSlack ?? LIVE_EDGE_SLACK) ? t('live') : t('behindLive', { time: formatTime(behind) });
  }
  return `${formatTime(p.position)} / ${formatTime(p.duration)}`;
}

let lastPointerAt = 0;
let lastKeyAt = 0;
let modalityBound = false;
/** Input order counter (not time: fake timers freeze the clock). */
let inputSeq = 0;

/** Start tracking whether the latest input was a pointer press or a key press (idempotent). */
export function bindInputModality(): void {
  if (modalityBound || typeof document === 'undefined') return;
  modalityBound = true;
  document.addEventListener('pointerdown', () => (lastPointerAt = ++inputSeq), true);
  document.addEventListener('mousedown', () => (lastPointerAt = ++inputSeq), true);
  document.addEventListener('keydown', () => (lastKeyAt = ++inputSeq), true);
}

/**
 * True when focus just arrived from a mouse or touch press rather than the keyboard.
 * Player chrome stays pinned only for keyboard focus; a clicked button keeps focus but
 * must not stop the controls from hiding.
 */
export function focusFromPointer(): boolean {
  return lastPointerAt > lastKeyAt;
}

/** Test hook: forget the recorded modality. */
export function __resetInputModality(): void {
  lastPointerAt = 0;
  lastKeyAt = 0;
}

/** True when nothing useful holds keyboard focus (it fell back to the document). */
export function focusIsLost(): boolean {
  const a = document.activeElement;
  return !a || a === document.body || a === document.documentElement;
}

/**
 * Focus `el` (an error's Retry, say) when keyboard focus is already inside the player or was
 * lost to the document; never pull focus out of a list the user is working in.
 */
export function focusIfPlayerOwnsFocus(el: HTMLElement | null): void {
  if (!el) return;
  const host = el.closest('[data-player-host]') ?? el.closest('[data-pip-layer]');
  const active = document.activeElement;
  if (focusIsLost() || (host && active && host.contains(active))) el.focus({ preventScroll: true });
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
