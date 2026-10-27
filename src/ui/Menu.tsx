import { Ellipsis } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { IconButton, TOUCH_TARGET } from './Button';
import { cn } from './cn';
import { portalContainer } from './portal';
import { usePresence } from './presence';
import { Tooltip, type TooltipPlacement } from './Tooltip';

export interface MenuAction {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Combo hint shown on the right, e.g. `mod+k`. Display only. */
  hint?: ReactNode;
}

export interface MenuSeparator {
  id: string;
  type: 'separator';
}

export type MenuItem = MenuAction | MenuSeparator;

export interface MenuProps {
  items: MenuItem[];
  /** Accessible name of the trigger. Defaults to "More actions". */
  label?: string;
  /** Trigger content; defaults to an ellipsis icon (an IconButton whose tooltip is `label`). */
  trigger?: ReactNode;
  triggerClassName?: string;
  /** Tooltip for a custom icon-only `trigger` (the default trigger already shows `label`). */
  tooltip?: ReactNode;
  tooltipSide?: TooltipPlacement;
  align?: 'start' | 'end';
  /**
   * `block` (default): below the trigger (or above it). `inline-end`: beside the trigger on its
   * inline-end side (right in LTR, left in RTL), top edges lined up; for a trigger in a narrow
   * column such as the collapsed rail. `align` applies to `block` only.
   */
  placement?: 'block' | 'inline-end';
  className?: string;
}

/**
 * A destructive item (Remove, Delete): red as a whole, its icon included, with a red wash under
 * the pointer and focus, so it never looks like its neutral neighbours until it is read. Exported
 * for src/ui/test/contrast.test.ts, which holds the red text to 4.5:1 on the strongest wash.
 */
export const MENU_DANGER = 'text-danger hover:bg-danger/10 focus:bg-danger/15 active:bg-danger/20';

function isAction(i: MenuItem): i is MenuAction {
  return !('type' in i);
}

/** Gap between trigger and menu, and the minimum distance kept from the viewport edge. */
const GAP = 6;
const MARGIN = 8;

/** What takes focus when pressed: a press outside the menu on one of these keeps it there. */
const CONTROL = [
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

interface MenuAnchor {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Where a menu of `size` opens next to its trigger. It drops below the
 * trigger, or opens upward when it would leave the viewport and there is more
 * room above; `align` lines it up with the trigger's start or end edge
 * (logical, so `end` is the left edge in RTL). With `placement: 'inline-end'`
 * it opens beside the trigger instead, on its inline-end side (the other side
 * when that has more room), top edges lined up, or bottom edges near the
 * bottom of the screen. The result is clamped so the menu stays fully on
 * screen. Exported for tests.
 */
export function placeMenu(
  anchor: MenuAnchor,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  opts: { align: 'start' | 'end'; rtl: boolean; placement?: 'block' | 'inline-end' },
): { top: number; left: number; side: 'below' | 'above' | 'inline-end' | 'inline-start' } {
  const clamp = (v: number, max: number) => Math.max(MARGIN, Math.min(v, max - MARGIN));
  if (opts.placement === 'inline-end') {
    const roomRight = viewport.width - anchor.right - GAP - MARGIN;
    const roomLeft = anchor.left - GAP - MARGIN;
    const endRoom = opts.rtl ? roomLeft : roomRight;
    const startRoom = opts.rtl ? roomRight : roomLeft;
    const side = size.width > endRoom && startRoom > endRoom ? 'inline-start' : 'inline-end';
    const toRight = (side === 'inline-end') !== opts.rtl;
    const left = toRight ? anchor.right + GAP : anchor.left - GAP - size.width;
    const below = viewport.height - anchor.top - MARGIN;
    const above = anchor.bottom - MARGIN;
    const top = size.height > below && above > below ? anchor.bottom - size.height : anchor.top;
    return { top: clamp(top, viewport.height - size.height), left: clamp(left, viewport.width - size.width), side };
  }
  const below = viewport.height - anchor.bottom - GAP - MARGIN;
  const above = anchor.top - GAP - MARGIN;
  const side = size.height > below && above > below ? 'above' : 'below';
  let top = side === 'below' ? anchor.bottom + GAP : anchor.top - GAP - size.height;
  const alignRight = (opts.align === 'end') !== opts.rtl;
  let left = alignRight ? anchor.right - size.width : anchor.left;
  left = clamp(left, viewport.width - size.width);
  top = clamp(top, viewport.height - size.height);
  return { top, left, side };
}

/**
 * Menu button (WAI-ARIA menu pattern): Enter/Space/ArrowDown open on the
 * first item, ArrowUp opens on the last; roving focus with arrows, Home/End,
 * type-ahead; Escape/Tab close and restore focus to the trigger.
 */
export function Menu({ items, label, trigger, triggerClassName, tooltip, tooltipSide, align = 'end', placement = 'block', className }: MenuProps) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ rect: MenuAnchor; rtl: boolean } | null>(null);
  const [pos, setPos] = useState<ReturnType<typeof placeMenu> | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Closing keeps the menu on screen for its pop-out, inert, at the place it opened.
  const { present, closing } = usePresence(open, menuRef);
  const focusOnOpen = useRef<'first' | 'last'>('first');
  const menuId = useId();
  const actions = items.filter(isAction);

  const place = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAnchor({ rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right }, rtl: getComputedStyle(el).direction === 'rtl' });
  };

  // Measure the rendered (still hidden) menu, then flip and clamp it into the viewport before paint.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!open) {
      // A closing menu stays where it was; once it is gone the next open measures afresh.
      if (!present) setPos(null);
      return;
    }
    if (!anchor || !menu) {
      setPos(null);
      return;
    }
    const size = menu.getBoundingClientRect();
    setPos(
      placeMenu(anchor.rect, { width: size.width, height: size.height }, { width: window.innerWidth, height: window.innerHeight }, {
        align,
        rtl: anchor.rtl,
        placement,
      }),
    );
  }, [open, present, anchor, align, placement, items.length]);

  const openMenu = (where: 'first' | 'last') => {
    focusOnOpen.current = where;
    place();
    setOpen(true);
  };

  const close = (restore = true) => {
    setOpen(false);
    if (restore) triggerRef.current?.focus();
  };

  // Focus once the menu is placed: a `visibility: hidden` element cannot take focus.
  const placed = pos !== null;
  useLayoutEffect(() => {
    if (!open || !placed) return;
    const nodes = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])');
    if (!nodes || nodes.length === 0) {
      menuRef.current?.focus();
      return;
    }
    (focusOnOpen.current === 'first' ? nodes[0] : nodes[nodes.length - 1])?.focus();
  }, [open, placed]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      // A press on another control leaves focus to it. Anywhere else (empty page, text, #main) the
      // press would move focus to <body> or a container, so the trigger takes it back instead.
      if (!(target instanceof Element && target.closest(CONTROL))) {
        e.preventDefault();
        triggerRef.current?.focus({ preventScroll: true });
      }
      setOpen(false);
    };
    const onScroll = () => place();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onScroll);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  const focusItem = (dir: 1 | -1 | 'first' | 'last') => {
    const nodes = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [],
    );
    if (nodes.length === 0) return;
    const idx = nodes.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (dir === 'first') next = 0;
    else if (dir === 'last') next = nodes.length - 1;
    else next = (idx + dir + nodes.length) % nodes.length;
    nodes[next]?.focus();
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        focusItem(1);
        break;
      case 'ArrowUp':
        focusItem(-1);
        break;
      case 'Home':
        focusItem('first');
        break;
      case 'End':
        focusItem('last');
        break;
      case 'Escape':
        close();
        break;
      case 'Tab':
        // The menu is portaled to the end of <body>, so the browser's own Tab
        // would leave the document. Putting focus back on the trigger first
        // lets Tab and Shift+Tab continue from where the menu was opened.
        close();
        return;
      default: {
        if (e.key.length === 1 && /\S/.test(e.key)) {
          const ch = e.key.toLowerCase();
          const nodes = Array.from(
            menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [],
          );
          const start = nodes.indexOf(document.activeElement as HTMLElement) + 1;
          const ordered = [...nodes.slice(start), ...nodes.slice(0, start)];
          ordered.find((n) => n.textContent?.trim().toLowerCase().startsWith(ch))?.focus();
          break;
        }
        return;
      }
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const triggerProps = {
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    onClick: () => (open ? close(false) : openMenu('first')),
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        openMenu('first');
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        openMenu('last');
      }
    },
  };

  return (
    <>
      {trigger ? (
        <Tooltip content={open ? null : tooltip} side={tooltipSide} describe={false}>
          <button ref={triggerRef} type="button" aria-label={label} {...triggerProps} className={triggerClassName}>
            {trigger}
          </button>
        </Tooltip>
      ) : (
        <IconButton
          ref={triggerRef}
          label={label ?? t('moreActions')}
          icon={<Ellipsis aria-hidden size={18} />}
          {...triggerProps}
          className={triggerClassName}
        />
      )}
      {present &&
        anchor &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            tabIndex={-1}
            data-dialog-layer=""
            data-state={closing ? 'closed' : 'open'}
            inert={closing || undefined}
            aria-label={label}
            onKeyDown={onMenuKey}
            // Rendered hidden for one layout pass so placeMenu can measure it. A menu placed above its
            // trigger rises from above (--pop-from, read by the pop-in keyframes in globals.css).
            style={
              pos
                ? ({ top: pos.top, left: pos.left, '--pop-from': pos.side === 'above' ? '-6px' : '6px' } as CSSProperties)
                : { top: 0, left: 0, visibility: 'hidden' }
            }
            className={cn(
              'fixed z-[60] min-w-48 max-w-80 rounded-lg border border-edge bg-surface p-1 shadow-2',
              closing ? 'pointer-events-none motion-safe:animate-pop-out' : 'motion-safe:animate-pop-in',
              className,
            )}
          >
            {items.map((item) =>
              isAction(item) ? (
                <div
                  key={item.id}
                  role="menuitem"
                  tabIndex={-1}
                  aria-disabled={item.disabled || undefined}
                  onClick={() => {
                    if (item.disabled) return;
                    close();
                    item.onSelect();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      if (item.disabled) return;
                      close();
                      item.onSelect();
                    }
                  }}
                  className={cn(
                    'flex h-9 cursor-pointer items-center gap-3 rounded-md px-3 text-sm outline-hidden select-none',
                    TOUCH_TARGET,
                    'hover:bg-hover focus:bg-active active:bg-pressed focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus aria-disabled:cursor-not-allowed aria-disabled:opacity-40',
                    item.danger ? MENU_DANGER : 'text-fg',
                  )}
                >
                  {item.icon && (
                    <span aria-hidden data-menu-icon="" className={cn('flex w-4 shrink-0 justify-center', item.danger ? 'text-danger' : 'text-fg-muted')}>
                      {item.icon}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint && <span className="text-xs text-fg-subtle">{item.hint}</span>}
                </div>
              ) : (
                <div key={item.id} role="separator" className="my-1 h-px bg-divider" />
              ),
            )}
            {actions.length === 0 && (
              <div className="px-3 py-2 text-sm text-fg-subtle">{t('noActions')}</div>
            )}
          </div>,
          portalContainer(),
        )}
    </>
  );
}
