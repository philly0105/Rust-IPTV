import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

import { cn } from './cn';

export interface TabItem {
  id: string;
  label: ReactNode;
  /** Optional count or badge after the label. */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  /** Accessible name of the tab list. */
  label?: string;
  className?: string;
  /** `underline` (default) for page sections, `pill` for compact toolbars. */
  variant?: 'underline' | 'pill';
  /**
   * When set, each tab gets aria-controls=`${panelIdPrefix}-${id}`; render
   * panels with `tabPanelProps(panelIdPrefix, id)`.
   */
  panelIdPrefix?: string;
}

/**
 * WAI-ARIA tabs with roving focus: ArrowLeft/Right (and Up/Down), Home, End
 * move focus and activate (automatic activation).
 */
export function Tabs({ items, value, onChange, label, className, variant = 'underline', panelIdPrefix }: TabsProps) {
  const autoId = useId();
  const prefix = panelIdPrefix ?? autoId;
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const enabled = items.filter((i) => !i.disabled);

  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = enabled.findIndex((i) => i.id === value);
    // Arrow keys follow the screen: in RTL the tab row is mirrored, so ArrowLeft moves forward.
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    const forward = (idx + 1) % enabled.length;
    // When the value is not an enabled tab (idx -1), back wraps to the last tab, not the one before it.
    const back = idx < 0 ? enabled.length - 1 : (idx - 1 + enabled.length) % enabled.length;
    let next = -1;
    switch (e.key) {
      case 'ArrowRight':
        next = rtl ? back : forward;
        break;
      case 'ArrowLeft':
        next = rtl ? forward : back;
        break;
      case 'ArrowDown':
        next = forward;
        break;
      case 'ArrowUp':
        next = back;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = enabled.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    const item = enabled[next];
    if (!item) return;
    onChange(item.id);
    refs.current.get(item.id)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      onKeyDown={move}
      className={cn(
        'flex max-w-full items-center overflow-x-auto scrollbar-none',
        variant === 'underline' ? 'gap-1 border-b border-divider' : 'gap-1 rounded-md bg-surface-2 p-1',
        className,
      )}
    >
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            ref={(el) => {
              if (el) refs.current.set(item.id, el);
              else refs.current.delete(item.id);
            }}
            type="button"
            role="tab"
            id={`${prefix}-tab-${item.id}`}
            aria-selected={selected}
            aria-controls={panelIdPrefix ? `${prefix}-${item.id}` : undefined}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onChange(item.id)}
            className={cn(
              'inline-flex shrink-0 items-center gap-2 whitespace-nowrap text-sm font-medium disabled:opacity-40',
              'motion-safe:transition-colors',
              variant === 'underline'
                ? cn(
                    '-mb-px h-10 border-b-2 px-3',
                    selected ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg hover:border-divider active:border-border motion-safe:transition-colors',
                  )
                : cn(
                    'h-8 rounded-sm px-3',
                    selected ? 'bg-surface text-fg shadow-1' : 'text-fg-muted hover:bg-surface-2 hover:text-fg active:bg-surface-3 motion-safe:transition-colors',
                  ),
            )}
          >
            {item.label}
            {item.badge !== undefined && (
              <span className="tabular rounded-full bg-surface-3 px-1.5 text-xs text-fg-muted">{item.badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Props for a tab panel paired with `<Tabs panelIdPrefix>`. */
export function tabPanelProps(panelIdPrefix: string, id: string) {
  return {
    role: 'tabpanel' as const,
    id: `${panelIdPrefix}-${id}`,
    'aria-labelledby': `${panelIdPrefix}-tab-${id}`,
    tabIndex: 0,
  };
}
