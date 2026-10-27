import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { cn, TOUCH_TARGET, usePresence } from '@/ui';
import { portalContainer } from '@/ui/portal';

import { documentIsRtl } from '../lib/rtl';

export interface MenuItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  /** Destructive: drawn in the danger tone, as in the kit Menu. */
  danger?: boolean;
  /** Key hint shown at the inline end, e.g. `F2`. Display only (hidden from the accessible name). */
  hint?: ReactNode;
  onSelect(): void;
}

/** A rule between two sections of the menu. Leading, trailing and doubled rules are dropped. */
export interface MenuSeparator {
  id: string;
  type: 'separator';
}

export type MenuEntry = MenuItem | MenuSeparator;

/**
 * What the menu is about, drawn above its items (LG-16): a channel's logo, its name and what is
 * on. Not focusable and not an item; the menu's `label` stays its accessible name.
 */
export interface MenuHeader {
  title: ReactNode;
  subtitle?: ReactNode;
  media?: ReactNode;
}

/**
 * A phone held in the hand: below sm (Tailwind's 40rem, 640 px in a media query) with a finger
 * for a pointer. There the menu is a bottom sheet over a scrim; a narrow window driven by a
 * mouse keeps the popover at the cursor.
 */
const SHEET_QUERY = '(max-width: 639.98px) and (pointer: coarse)';

function opensAsSheet(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(SHEET_QUERY).matches;
}

function isSeparator(e: MenuEntry): e is MenuSeparator {
  return 'type' in e && e.type === 'separator';
}

/** The entries with empty sections folded away: no rule at either end, never two in a row. */
export function tidyEntries(entries: readonly MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (isSeparator(e) && (out.length === 0 || isSeparator(out[out.length - 1]!))) continue;
    out.push(e);
  }
  while (out.length > 0 && isSeparator(out[out.length - 1]!)) out.pop();
  return out;
}

/**
 * Cursor-positioned menu (right click, the context-menu key, a long press). It looks and behaves
 * like the kit `Menu` (same items, rules, touch targets, type-ahead and pop animation), which only
 * opens from a trigger button: arrow keys move, Home/End jump, a letter finds the next item that
 * starts with it, Enter selects, Escape and Tab close and give focus back.
 *
 * On a phone (SHEET_QUERY) it is a bottom sheet instead: full width over a scrim, its header as
 * the sheet's title, items in the same order. A popover pinned under the ⋮ covered the tab bar or
 * the row it belonged to, and a tap beside it went through to the page.
 */
export function ContextMenu({
  pos,
  items,
  label,
  header,
  onClose,
}: {
  pos: { x: number; y: number } | null;
  items: readonly MenuEntry[];
  label: string;
  header?: MenuHeader;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; above: boolean }>({ left: 0, top: 0, above: false });
  const restoreFocus = useRef<HTMLElement | null>(null);
  // Closing keeps the menu up for its pop-out, inert, with what it showed when it closed.
  const { present, closing } = usePresence(pos !== null, ref);
  const shown = useRef({ items, label, header, sheet: false });
  if (pos) shown.current = { items, label, header, sheet: shown.current.sheet };
  // Decided once per opening, so a rotation while it is up does not swap the menu's shape.
  const openedAt = useRef<typeof pos>(null);
  if (pos && openedAt.current !== pos) {
    openedAt.current = pos;
    shown.current.sheet = opensAsSheet();
  }
  // In the sheet, a tap only counts when it started inside it: the finger that long-pressed a row
  // may lift over the sheet that rose under it, and that release must not choose an item.
  const pressedInside = useRef(false);

  useLayoutEffect(() => {
    if (!pos || !ref.current) return;
    restoreFocus.current = document.activeElement as HTMLElement | null;
    pressedInside.current = false;
    if (shown.current.sheet) {
      // The sheet itself takes focus, so no item looks chosen before a tap; the arrows start at the first.
      ref.current.focus({ preventScroll: true });
      return;
    }
    const r = ref.current.getBoundingClientRect();
    // In RTL the menu grows from the pointer toward the inline end (leftward), like native menus.
    const want = documentIsRtl() ? pos.x - r.width : pos.x;
    const left = Math.min(want, window.innerWidth - r.width - 8);
    const above = pos.y + r.height > window.innerHeight - 8;
    const top = above ? Math.max(8, pos.y - r.height) : pos.y;
    setPlace({ left: Math.max(8, left), top, above });
    ref.current.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, [pos]);

  useEffect(() => {
    if (!pos) return;
    const close = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      // The sheet's scrim closes on its own click, so the tap ends on it and not on the page.
      if (e.target instanceof Element && e.target.closest('[data-context-scrim]')) return;
      onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [pos, onClose]);

  if (!present) return null;
  const view = shown.current;
  const sheet = view.sheet;
  const entries = tidyEntries(view.items);

  const finish = () => {
    onClose();
    restoreFocus.current?.focus?.();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') buttons[(i + 1) % buttons.length]?.focus();
    else if (e.key === 'ArrowUp') buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    else if (e.key === 'Home') buttons[0]?.focus();
    else if (e.key === 'End') buttons[buttons.length - 1]?.focus();
    else if (e.key === 'Escape' || e.key === 'Tab') finish();
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Type-ahead, as in the kit Menu: the next item after the focused one that starts with the letter.
      const ch = e.key.toLocaleLowerCase();
      const ordered = [...buttons.slice(i + 1), ...buttons.slice(0, i + 1)];
      ordered.find((b) => b.dataset.menuLabel?.startsWith(ch))?.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  // Portaled at the kit Menu's layer: rendered in the page, the mini player (later in the DOM at
  // the same z-index) covered it, items and keyboard focus included. A dialog layer, as the kit
  // Menu is, so a dialog under it lets focus in.
  return createPortal(
    <>
      {sheet ? (
        <div
          aria-hidden
          data-context-scrim=""
          className={cn(
            'fixed inset-0 z-[60] touch-none bg-scrim',
            closing ? 'pointer-events-none motion-safe:animate-fade-out' : 'motion-safe:animate-fade-in',
          )}
          onClick={finish}
        />
      ) : null}
      <div
        ref={ref}
        role="menu"
        tabIndex={sheet ? -1 : undefined}
        data-dialog-layer=""
        data-sheet={sheet ? '' : undefined}
        aria-label={view.label}
        onKeyDown={onKeyDown}
        onPointerDown={() => {
          pressedInside.current = true;
        }}
        data-state={closing ? 'closed' : 'open'}
        inert={closing || undefined}
        style={sheet ? undefined : { left: place.left, top: place.top, ['--pop-from' as string]: place.above ? '-6px' : '6px' }}
        className={cn(
          'fixed z-[60] overflow-y-auto overscroll-contain border-edge bg-surface text-fg',
          // The sheet takes focus as a whole; as on the kit Dialog's panel, a ring around all of it
          // would read as a stray highlight, so the global focus-visible outline is turned off here.
          sheet
            ? 'inset-x-0 bottom-0 max-h-[calc(100dvh-3rem)] rounded-t-xl border-t px-2 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] text-body shadow-3 outline-none focus-visible:shadow-3 focus-visible:outline-none'
            : 'max-h-[calc(100dvh-1rem)] min-w-56 max-w-80 rounded-lg border p-1 text-sm shadow-2',
          closing
            ? cn('pointer-events-none', sheet ? 'motion-safe:animate-sheet-out' : 'motion-safe:animate-pop-out')
            : sheet
              ? 'motion-safe:animate-sheet-in'
              : 'motion-safe:animate-pop-in',
        )}
      >
        {view.header ? (
          <>
            <div className={cn('flex min-w-0 items-center gap-2.5 px-2.5 pb-2', sheet ? 'pt-2' : 'pt-1.5')} data-testid="context-menu-header">
              {view.header.media ? <span className="shrink-0">{view.header.media}</span> : null}
              <span className="flex min-w-0 flex-col">
                <span dir="auto" className={cn('truncate font-medium text-fg', sheet ? 'text-body' : 'text-body-sm')}>
                  {view.header.title}
                </span>
                {view.header.subtitle ? (
                  <span dir="auto" className="truncate text-caption text-fg-subtle">
                    {view.header.subtitle}
                  </span>
                ) : null}
              </span>
            </div>
            {entries.length > 0 ? <div role="separator" className="my-1 h-px bg-divider" /> : null}
          </>
        ) : null}
        {entries.map((it) =>
          isSeparator(it) ? (
            <div key={it.id} role="separator" className="my-1 h-px bg-divider" />
          ) : (
            <button
              key={it.id}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              data-menu-label={typeof it.label === 'string' ? it.label.trim().toLocaleLowerCase() : undefined}
              onClick={(e) => {
                // detail 0: Enter or Space, which never come from the long press's lifting finger.
                if (sheet && e.detail > 0 && !pressedInside.current) return;
                finish();
                it.onSelect();
              }}
              className={cn(
                'flex h-9 w-full items-center gap-3 rounded-md px-2.5 text-start select-none',
                TOUCH_TARGET,
                'outline-none hover:bg-hover active:bg-pressed focus-visible:bg-active focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-40',
                it.danger ? 'text-danger' : 'text-fg',
              )}
            >
              <span aria-hidden className={cn('inline-flex w-4 shrink-0 items-center justify-center', it.danger ? 'text-danger' : 'text-fg-muted')}>
                {it.icon}
              </span>
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {/* Out of the accessible name: the item is named by its label alone. A key a finger cannot press is left out on touch. */}
              {it.hint ? (
                <span className="ms-4 shrink-0 text-xs text-fg-subtle pointer-coarse:hidden" aria-hidden>
                  {it.hint}
                </span>
              ) : null}
            </button>
          ),
        )}
      </div>
    </>,
    portalContainer(),
  );
}
