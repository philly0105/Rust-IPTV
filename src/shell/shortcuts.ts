/**
 * Shortcut registry (SPEC C16). One window keydown listener dispatches to the
 * most recently registered enabled handler for a combo. Every `useShortcut`
 * call is listed by `shortcutRegistry.list()`, which powers the `?` overlay.
 *
 * Combo syntax: `+`-joined, lowercase. Modifiers `mod` (Ctrl, or Cmd on macOS),
 * `ctrl`, `meta`, `alt`, `shift`. Keys are `KeyboardEvent.key` lowercased
 * (`k`, `?`, `/`, `arrowleft`, `escape`, `enter`, `f1`), plus `space` and
 * `digit` (any 0-9 without modifiers; read the digit from `e.key`).
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';

import { isTypingTarget } from '@/ui/focus';

export interface ShortcutOptions {
  description: string;
  area: string;
  enabled?: boolean;
  allowInInput?: boolean;
  /** Fire while a modal dialog is open. Default: only `escape` and `mod+*` combos do. */
  allowInModal?: boolean;
  /**
   * Global shortcut: fires everywhere, including while typing, inside modal
   * dialogs, and with a button or link focused. Implies `allowInInput` and
   * `allowInModal`.
   */
  global?: boolean;
}

export interface ShortcutInfo {
  combo: string;
  description: string;
  area: string;
}

export interface ShortcutEntry extends ShortcutOptions {
  id: number;
  combo: string;
  parsed: ParsedCombo;
  handler: (e: KeyboardEvent) => void;
}

export interface ParsedCombo {
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  ' ': 'space',
  spacebar: 'space',
  left: 'arrowleft',
  right: 'arrowright',
  up: 'arrowup',
  down: 'arrowdown',
  del: 'delete',
  return: 'enter',
  plus: '+',
};

export function normalizeCombo(combo: string): string {
  const p = parseCombo(combo);
  const parts: string[] = [];
  if (p.mod) parts.push('mod');
  if (p.ctrl) parts.push('ctrl');
  if (p.meta) parts.push('meta');
  if (p.alt) parts.push('alt');
  if (p.shift) parts.push('shift');
  parts.push(p.key);
  return parts.join('+');
}

export function parseCombo(combo: string): ParsedCombo {
  const out: ParsedCombo = { mod: false, ctrl: false, meta: false, alt: false, shift: false, key: '' };
  // A trailing "+" key ("mod++") would split oddly; handle explicitly.
  const raw = combo.trim().toLowerCase();
  const tokens = raw.endsWith('++') ? [...raw.slice(0, -2).split('+'), '+'] : raw.split('+');
  for (const t of tokens) {
    const tok = t.trim();
    if (!tok) continue;
    if (tok === 'mod' || tok === 'cmdorctrl') out.mod = true;
    else if (tok === 'ctrl' || tok === 'control') out.ctrl = true;
    else if (tok === 'meta' || tok === 'cmd' || tok === 'command') out.meta = true;
    else if (tok === 'alt' || tok === 'option') out.alt = true;
    else if (tok === 'shift') out.shift = true;
    else out.key = KEY_ALIASES[tok] ?? tok;
  }
  return out;
}

/** Key names an event can match: `e.key` and the layout-independent `e.code` form. */
function eventKeys(e: KeyboardEvent): string[] {
  const keys: string[] = [];
  const k = (e.key ?? '').toLowerCase();
  keys.push(KEY_ALIASES[k] ?? k);
  const code = e.code ?? '';
  if (/^Key[A-Z]$/.test(code)) keys.push(code.slice(3).toLowerCase());
  else if (/^Digit\d$/.test(code)) keys.push(code.slice(5));
  else if (/^Numpad\d$/.test(code)) keys.push(code.slice(6));
  else if (code === 'Slash') keys.push('/');
  else if (code === 'Space') keys.push('space');
  return keys;
}

const isPrintableSymbol = (key: string) => key.length === 1 && !/[a-z0-9]/.test(key);

/** True when the keyboard event matches the parsed combo. */
export function matches(p: ParsedCombo, e: KeyboardEvent): boolean {
  const wantCtrl = p.ctrl || (p.mod && !IS_MAC);
  const wantMeta = p.meta || (p.mod && IS_MAC);
  if (e.ctrlKey !== wantCtrl || e.metaKey !== wantMeta || e.altKey !== p.alt) return false;

  if (p.key === 'digit') {
    // Shift is not checked: AZERTY (French, Belgian) types digits on the top
    // row only with Shift held. Shift+digit on QWERTY yields "!", "@"... and
    // fails the test on e.key anyway.
    return /^\d$/.test(e.key);
  }
  const keys = eventKeys(e);
  if (!keys.includes(p.key)) return false;
  // Symbols like "?" need Shift on most layouts; don't require the combo to say so.
  if (isPrintableSymbol(p.key) && keys[0] === p.key) return p.shift ? e.shiftKey : true;
  return e.shiftKey === p.shift;
}

let nextId = 1;
const entries: ShortcutEntry[] = [];
const listeners = new Set<() => void>();
let snapshot: ShortcutInfo[] = [];
let attached = false;

function emit(): void {
  const seen = new Set<string>();
  const list: ShortcutInfo[] = [];
  for (const e of entries) {
    if (e.enabled === false) continue;
    const key = `${e.area}|${e.combo}|${e.description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ combo: e.combo, description: e.description, area: e.area });
  }
  snapshot = list;
  for (const l of listeners) l();
}

function modalOpen(): boolean {
  return typeof document !== 'undefined' && document.querySelector('[aria-modal="true"]') !== null;
}

const ACTIVATABLE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'treeitem',
  'gridcell',
]);

/**
 * True when Space/Enter on the target already means "activate this control"
 * (a focused button, link, checkbox, option...). Plain `space`/`enter`
 * shortcuts must not steal that.
 */
export function isActivationTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'SELECT') return true;
  if (tag === 'A' && target.hasAttribute('href')) return true;
  if (tag === 'INPUT') return true;
  const role = target.getAttribute('role');
  return role !== null && ACTIVATABLE_ROLES.has(role);
}

const ARROW_KEYS = new Set(['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'home', 'end', 'pageup', 'pagedown']);

/** True when bare arrow/Home/End/Page keys adjust the focused control (slider, spinbutton, select). */
export function isArrowTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === 'SELECT') return true;
  if (target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'range') return true;
  const role = target.getAttribute('role');
  return role === 'slider' || role === 'spinbutton' || role === 'scrollbar';
}

const bare = (p: ParsedCombo) => !p.mod && !p.ctrl && !p.meta && !p.alt;
const isBareActivationKey = (p: ParsedCombo) => (p.key === 'space' || p.key === 'enter') && bare(p);
const isBareArrowKey = (p: ParsedCombo) => ARROW_KEYS.has(p.key) && bare(p);

/** Picks the entry that should handle `e`, newest registration first. Exported for tests. */
export function findShortcut(e: KeyboardEvent): ShortcutEntry | undefined {
  if (e.defaultPrevented || e.isComposing) return undefined;
  const typing = isTypingTarget(e.target);
  const activation = isActivationTarget(e.target);
  const arrows = isArrowTarget(e.target);
  const modal = modalOpen();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.enabled === false) continue;
    if (!matches(entry.parsed, e)) continue;
    if (entry.global) return entry;
    if (typing && !entry.allowInInput) continue;
    if (activation && isBareActivationKey(entry.parsed)) continue;
    if (arrows && isBareArrowKey(entry.parsed)) continue;
    // While a modal is open only escape, mod+* combos, and opted-in shortcuts fire.
    if (modal && !entry.allowInModal && !(entry.parsed.key === 'escape' || entry.parsed.mod)) continue;
    return entry;
  }
  return undefined;
}

function onKeyDown(e: KeyboardEvent): void {
  const entry = findShortcut(e);
  if (!entry) return;
  // Claim the key before the handler runs, so the browser default (Space
  // scrolling, `/` quick find, F11, Ctrl+F/R/K) never fires even when the
  // handler throws, awaits, or moves focus.
  e.preventDefault();
  e.stopPropagation();
  try {
    entry.handler(e);
  } catch (err) {
    console.error(`[shortcuts] handler for "${entry.combo}" failed`, err);
  }
}

function attach(): void {
  // Bubble phase on window: focused widgets (Dialog, SearchInput, Menu,
  // VirtualList) handle their own keys first and claim them with
  // preventDefault/stopPropagation; whatever they leave reaches the registry.
  if (attached || typeof window === 'undefined') return;
  window.addEventListener('keydown', onKeyDown);
  attached = true;
}

export const shortcutRegistry = {
  /** Registers a shortcut; returns an unregister function. Prefer `useShortcut` in components. */
  register(combo: string, handler: (e: KeyboardEvent) => void, opts: ShortcutOptions): () => void {
    attach();
    const entry: ShortcutEntry = { ...opts, id: nextId++, combo: normalizeCombo(combo), parsed: parseCombo(combo), handler };
    entries.push(entry);
    emit();
    return () => {
      const i = entries.findIndex((x) => x.id === entry.id);
      if (i >= 0) entries.splice(i, 1);
      emit();
    };
  },
  /** Every enabled registered shortcut, deduplicated by area + combo + description. */
  list(): ShortcutInfo[] {
    return snapshot;
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** Test helper: drops every registration. */
  reset(): void {
    entries.splice(0, entries.length);
    emit();
  },
};

/**
 * Registers a keyboard shortcut for the component's lifetime. The latest
 * handler is always called (no need to memoize it).
 */
export function useShortcut(combo: string, handler: (e: KeyboardEvent) => void, opts: ShortcutOptions): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const { description, area, enabled = true, allowInInput = false, allowInModal, global } = opts;
  useEffect(() => {
    if (!enabled) return;
    return shortcutRegistry.register(combo, (e) => handlerRef.current(e), {
      description,
      area,
      enabled,
      allowInInput,
      allowInModal,
      global,
    });
  }, [combo, description, area, enabled, allowInInput, allowInModal, global]);
}

/** Live list of registered shortcuts. */
export function useShortcutList(): ShortcutInfo[] {
  return useSyncExternalStore(shortcutRegistry.subscribe, shortcutRegistry.list, shortcutRegistry.list);
}
