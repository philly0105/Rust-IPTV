import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';

import { cn } from './cn';
import { SEGMENT_TRACK, segmentClass } from './Segmented';

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
  /**
   * `underline` (default) for page sections: an accent bar under the chosen tab. `pill` for
   * compact toolbars: the SegmentedControl look, a raised neutral thumb in a recessed track.
   */
  variant?: 'underline' | 'pill';
  /**
   * When set, each tab gets aria-controls=`${panelIdPrefix}-${id}`; render
   * panels with `tabPanelProps(panelIdPrefix, id)`.
   */
  panelIdPrefix?: string;
}

/** Fade length at an edge that hides tabs; a selected tab is pulled this far clear of it. */
const FADE_PX = 24;

/** Physical edges of a sideways scroller that hide content. RTL scrollLeft runs from 0 to negative. */
export function hiddenTabEdges(b: { scrollLeft: number; scrollWidth: number; clientWidth: number; rtl: boolean }): {
  left: boolean;
  right: boolean;
} {
  const max = b.scrollWidth - b.clientWidth;
  if (max <= 1) return { left: false, right: false };
  const x = b.rtl ? b.scrollLeft + max : b.scrollLeft;
  return { left: x > 1, right: x < max - 1 };
}

/**
 * An underline tab row too wide for its box (long labels in a narrow dialog, many seasons)
 * scrolls sideways with its scrollbar hidden. The edge that hides tabs fades out, so a cut label
 * reads as "more this way", and the selected tab is scrolled clear of the fade.
 */
function useOverflowFade(list: HTMLDivElement | null, enabled: boolean): CSSProperties {
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    if (!list || !enabled) return;
    const measure = () => {
      const next = hiddenTabEdges({
        scrollLeft: list.scrollLeft,
        scrollWidth: list.scrollWidth,
        clientWidth: list.clientWidth,
        rtl: getComputedStyle(list).direction === 'rtl',
      });
      setEdges((prev) => (prev.left === next.left && prev.right === next.right ? prev : next));
    };
    measure();
    list.addEventListener('scroll', measure, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    ro?.observe(list);
    return () => {
      list.removeEventListener('scroll', measure);
      ro?.disconnect();
    };
  }, [list, enabled]);
  if (!enabled || (!edges.left && !edges.right)) return {};
  const start = edges.left ? `transparent 0, #000 ${FADE_PX}px` : '#000 0';
  const end = edges.right ? `#000 calc(100% - ${FADE_PX}px), transparent 100%` : '#000 100%';
  const mask = `linear-gradient(to right, ${start}, ${end})`;
  return { maskImage: mask, WebkitMaskImage: mask };
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
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const fade = useOverflowFade(list, variant === 'underline');

  // Keep the selected tab whole and clear of the fades (a click on a cut tab, arrow keys, opening on a later tab).
  useLayoutEffect(() => {
    const tab = refs.current.get(value);
    if (!list || !tab || list.scrollWidth - list.clientWidth <= 1) return;
    const box = list.getBoundingClientRect();
    const r = tab.getBoundingClientRect();
    if (box.width <= 0) return;
    if (r.left < box.left + FADE_PX) list.scrollLeft -= box.left + FADE_PX - r.left;
    else if (r.right > box.right - FADE_PX) list.scrollLeft += r.right - (box.right - FADE_PX);
  }, [list, value]);

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
      ref={setList}
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      onKeyDown={move}
      style={fade}
      className={cn(
        'flex max-w-full items-center overflow-x-auto scrollbar-none',
        variant === 'underline' ? 'gap-1 border-b border-divider' : SEGMENT_TRACK.default,
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
                    selected ? 'border-accent-mark text-fg' : 'border-transparent text-fg-muted hover:text-fg hover:border-divider active:border-border motion-safe:transition-colors',
                  )
                : // One raised thumb for every segmented choice (DS-STATE-FILLS): neutral, never an amber fill.
                  cn(segmentClass(selected), 'h-8 shrink-0'),
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
