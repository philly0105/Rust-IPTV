/**
 * A select-only combobox for long, sectioned choices (LG-11): the guide's source and its group or
 * view, the multi-view picker's and the list "Add channels" dialog's scope. The trigger looks like
 * the kit Select; the popover is a cmdk list with headed sections (Views, Lists, Groups), counts,
 * a filter field when there are many options, and the current choice ticked. Arrow keys move,
 * Enter picks, Escape closes and gives focus back to the trigger.
 *
 * The native select it replaces put All, Favorites, every list and hundreds of groups in one flat
 * OS dropdown with no counts.
 *
 * The popover's list (ScopePickerList, with cmdk and the Radix stack it brings) is its own chunk,
 * fetched once the page idles, when the pointer or focus comes to a trigger, or at the latest on
 * the first open, which shows a short placeholder until it is in (performance audit SH-10).
 */

import { ChevronDown } from 'lucide-react';
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { cn, fieldClass, Skeleton, usePresence } from '@/ui';
import { portalContainer } from '@/ui/portal';

import type { ScopePickerListProps } from './ScopePickerList';

export interface PickerOption {
  value: string;
  label: string;
  /** Shown muted at the end of the option (a group's channel count). */
  count?: number;
  icon?: ReactNode;
}

export interface PickerSection {
  id: string;
  /** Section heading; none for the first, unheaded block (All channels). */
  heading?: string;
  options: readonly PickerOption[];
}

export interface ScopePickerProps {
  /** Accessible name of the trigger and the list. */
  label: string;
  value: string;
  sections: readonly PickerSection[];
  onChange(value: string): void;
  /** Shown on the trigger while `value` matches no option (still loading). */
  placeholder?: string;
  /** Placeholder of the filter field. */
  filterLabel?: string;
  /** The filter field shows from this many options up. */
  filterFrom?: number;
  disabled?: boolean;
  /**
   * A square trigger showing this icon, for a narrow toolbar (the phone guide's genre filter):
   * the current option's name is read out but not drawn, and a choice other than the first
   * option (`''`, "All …") inverts the trigger, as a chosen filter chip does.
   */
  triggerIcon?: ReactNode;
  className?: string;
  testId?: string;
}

type ListModule = typeof import('./ScopePickerList');
let listModule: ListModule | null = null;
let listLoad: Promise<ListModule> | null = null;

/** Fetches the popover's list chunk (once); the picker renders it at once when it is in. */
export function preloadScopePickerList(): Promise<ListModule> {
  listLoad ??= import('./ScopePickerList').then((m) => (listModule = m));
  return listLoad;
}
const LazyList = lazy(() => preloadScopePickerList().then((m) => ({ default: m.ScopePickerList })));

/** The list, at once when its chunk is in, else behind a placeholder of a few rows. */
function PickerList(props: ScopePickerListProps) {
  if (listModule) return <listModule.ScopePickerList {...props} />;
  return (
    <Suspense
      fallback={
        <div className="flex flex-col gap-1.5 p-2" aria-busy="true">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-4/5" />
          <Skeleton className="h-7 w-3/5" />
        </div>
      }
    >
      <LazyList {...props} />
    </Suspense>
  );
}

const GAP = 4;
const MARGIN = 8;

export function ScopePicker({
  label,
  value,
  sections,
  onChange,
  placeholder,
  filterLabel,
  filterFrom = 9,
  disabled,
  triggerIcon,
  className,
  testId,
}: ScopePickerProps) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ top?: number; bottom?: number; left: number; width: number; maxHeight: number; above: boolean } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const { present, closing } = usePresence(open, popRef);

  const all = useMemo(() => sections.flatMap((s) => s.options), [sections]);
  const current = all.find((o) => o.value === value);

  // The list's chunk, once the page idles after the picker is up (or sooner: hover, focus, open).
  useEffect(() => {
    if (listModule) return;
    if (typeof requestIdleCallback === 'function') {
      const h = requestIdleCallback(() => void preloadScopePickerList(), { timeout: 3000 });
      return () => cancelIdleCallback(h);
    }
    const h = setTimeout(() => void preloadScopePickerList(), 1000);
    return () => clearTimeout(h);
  }, []);

  const measure = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - GAP - MARGIN;
    const above = r.top - GAP - MARGIN;
    const up = below < 240 && above > below;
    const width = Math.min(Math.max(r.width, 256), 352, window.innerWidth - 2 * MARGIN);
    const rtl = getComputedStyle(el).direction === 'rtl';
    const left = Math.max(MARGIN, Math.min(rtl ? r.right - width : r.left, window.innerWidth - width - MARGIN));
    const maxHeight = Math.max(160, Math.min(420, up ? above : below));
    // Opening upward it hangs from the trigger's top edge, so its height never needs measuring.
    setPlace(up ? { bottom: window.innerHeight - r.top + GAP, left, width, maxHeight, above: true } : { top: r.bottom + GAP, left, width, maxHeight, above: false });
  };

  const show = () => {
    if (disabled) return;
    void preloadScopePickerList();
    measure();
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  };
  const pick = (v: string) => {
    close();
    if (v !== value) onChange(v);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    const onMove = (e: Event) => {
      if (e.target instanceof Node && popRef.current?.contains(e.target)) return;
      measure();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPopKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      // Not the dialog under it: React bubbles portal events through the tree. (A typed filter
      // took the first Escape in the list.)
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      close();
    }
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || ((e.key === 'Enter' || e.key === ' ') && !open)) {
      e.preventDefault();
      show();
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        data-testid={testId}
        onClick={() => (open ? close() : show())}
        onKeyDown={onTriggerKey}
        onPointerEnter={() => void preloadScopePickerList()}
        onFocus={() => void preloadScopePickerList()}
        className={
          triggerIcon
            ? fieldClass(
                'sm',
                cn(
                  // Square on a touch screen too, where the field's floor makes it 44 px tall.
                  'inline-flex size-9 shrink-0 items-center justify-center px-0 pointer-coarse:min-w-[calc(44rem/15)]',
                  value ? 'border-fg bg-fg text-bg hover:bg-fg/90' : 'text-fg-muted hover:text-fg',
                  className,
                ),
              )
            : fieldClass('sm', cn('inline-flex min-w-0 items-center gap-2 pe-2 text-start', className))
        }
      >
        {triggerIcon ? (
          <>
            <span aria-hidden className="flex">
              {triggerIcon}
            </span>
            <span className="sr-only">{current?.label ?? placeholder ?? ''}</span>
          </>
        ) : (
          <>
            {current?.icon ? <span aria-hidden className="flex shrink-0 text-fg-muted">{current.icon}</span> : null}
            <span dir="auto" className={cn('min-w-0 flex-1 truncate', !current && 'text-fg-subtle')}>
              {current?.label ?? placeholder ?? ''}
            </span>
            <ChevronDown aria-hidden size={16} className={cn('shrink-0 text-fg-muted motion-safe:transition-transform', open && 'rotate-180')} />
          </>
        )}
      </button>
      {present && place
        ? createPortal(
            <div
              ref={popRef}
              data-dialog-layer=""
              data-testid={testId ? `${testId}-popover` : undefined}
              inert={closing || undefined}
              onKeyDown={onPopKey}
              style={
                {
                  top: place.top,
                  bottom: place.bottom,
                  left: place.left,
                  width: place.width,
                  '--pop-from': place.above ? '-6px' : '6px',
                } as CSSProperties
              }
              className={cn(
                'fixed z-[60] flex flex-col overflow-hidden rounded-lg border border-edge bg-surface shadow-2',
                closing ? 'pointer-events-none motion-safe:animate-pop-out' : 'motion-safe:animate-pop-in',
              )}
            >
              <PickerList
                label={label}
                value={value}
                sections={sections}
                filterLabel={filterLabel}
                filterFrom={filterFrom}
                listId={listId}
                maxHeight={place.maxHeight}
                onPick={pick}
              />
            </div>,
            portalContainer(),
          )
        : null}
    </>
  );
}
