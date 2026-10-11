import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  onSelect(): void;
}

/** Cursor-positioned menu (right click, context-menu key). Arrow keys move, Enter selects, Escape closes. */
export function ContextMenu({
  pos,
  items,
  label,
  onClose,
}: {
  pos: { x: number; y: number } | null;
  items: MenuItem[];
  label: string;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const restoreFocus = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!pos || !ref.current) return;
    restoreFocus.current = document.activeElement as HTMLElement | null;
    const r = ref.current.getBoundingClientRect();
    const left = Math.min(pos.x, window.innerWidth - r.width - 8);
    const top = pos.y + r.height > window.innerHeight - 8 ? Math.max(8, pos.y - r.height) : pos.y;
    setPlace({ left: Math.max(8, left), top });
    ref.current.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, [pos]);

  useEffect(() => {
    if (!pos) return;
    const close = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
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

  if (!pos) return null;

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
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={{ left: place.left, top: place.top }}
      className="fixed z-50 min-w-52 rounded-lg border border-border bg-surface p-1 text-sm text-fg shadow-2"
    >
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="menuitem"
          disabled={it.disabled}
          onClick={() => {
            finish();
            it.onSelect();
          }}
          className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left outline-none hover:bg-surface-2 focus-visible:bg-surface-2 disabled:opacity-40"
        >
          <span className="inline-flex size-4 items-center justify-center text-fg-muted">{it.icon}</span>
          {it.label}
        </button>
      ))}
    </div>
  );
}
