import { Ellipsis } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { cn } from './cn';

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
  /** Trigger content; defaults to an ellipsis icon. */
  trigger?: ReactNode;
  triggerClassName?: string;
  align?: 'start' | 'end';
  className?: string;
}

function isAction(i: MenuItem): i is MenuAction {
  return !('type' in i);
}

/**
 * Menu button (WAI-ARIA menu pattern): Enter/Space/ArrowDown open on the
 * first item, ArrowUp opens on the last; roving focus with arrows, Home/End,
 * type-ahead; Escape/Tab close and restore focus to the trigger.
 */
export function Menu({ items, label, trigger, triggerClassName, align = 'end', className }: MenuProps) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; right: number; rtl: boolean } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef<'first' | 'last'>('first');
  const menuId = useId();
  const actions = items.filter(isAction);

  const place = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (r && triggerRef.current)
      setPos({ top: r.bottom + 6, left: r.left, right: window.innerWidth - r.right, rtl: getComputedStyle(triggerRef.current).direction === 'rtl' });
  };

  const openMenu = (where: 'first' | 'last') => {
    focusOnOpen.current = where;
    place();
    setOpen(true);
  };

  const close = (restore = true) => {
    setOpen(false);
    if (restore) triggerRef.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const nodes = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])');
    if (!nodes || nodes.length === 0) {
      menuRef.current?.focus();
      return;
    }
    (focusOnOpen.current === 'first' ? nodes[0] : nodes[nodes.length - 1])?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
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
        close(false);
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

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={trigger ? label : (label ?? t('moreActions'))}
        title={trigger ? undefined : (label ?? t('moreActions'))}
        onClick={() => (open ? close(false) : openMenu('first'))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            openMenu('first');
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            openMenu('last');
          }
        }}
        className={cn(
          !trigger &&
            'inline-flex h-9 w-9 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2 hover:text-fg',
          triggerClassName,
        )}
      >
        {trigger ?? <Ellipsis aria-hidden size={18} />}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            tabIndex={-1}
            data-dialog-layer=""
            aria-label={label}
            onKeyDown={onMenuKey}
            // `align` is logical: `end` lines the menu up with the trigger's inline-end edge (its left edge in RTL).
            style={(align === 'end') !== pos.rtl ? { top: pos.top, right: pos.right } : { top: pos.top, left: pos.left }}
            className={cn(
              'fixed z-[60] min-w-48 max-w-80 rounded-md border border-border bg-surface p-1 shadow-2 motion-safe:animate-pop-in',
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
                    'flex h-9 cursor-pointer items-center gap-3 rounded-sm px-3 text-sm outline-none select-none',
                    'hover:bg-surface-2 focus:bg-surface-3 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus aria-disabled:cursor-not-allowed aria-disabled:opacity-40',
                    item.danger ? 'text-danger' : 'text-fg',
                  )}
                >
                  {item.icon && (
                    <span aria-hidden className="flex w-4 shrink-0 justify-center text-fg-muted">
                      {item.icon}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint && <span className="text-xs text-fg-subtle">{item.hint}</span>}
                </div>
              ) : (
                <div key={item.id} role="separator" className="my-1 h-px bg-border" />
              ),
            )}
            {actions.length === 0 && (
              <div className="px-3 py-2 text-sm text-fg-subtle">{t('noActions')}</div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
