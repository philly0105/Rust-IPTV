/**
 * A select-only combobox for long, sectioned choices (LG-11): the guide's source and its group or
 * view, the multi-view picker's and the list "Add channels" dialog's scope. The trigger looks like
 * the kit Select; the popover is a cmdk list with headed sections (Views, Lists, Groups), counts,
 * a filter field when there are many options, and the current choice ticked. Arrow keys move,
 * Enter picks, Escape closes and gives focus back to the trigger.
 *
 * The native select it replaces put All, Favorites, every list and hundreds of groups in one flat
 * OS dropdown with no counts.
 */

import { Command as Cmdk } from 'cmdk';
import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { cn, fieldClass, TOUCH_TARGET, usePresence } from '@/ui';
import { portalContainer } from '@/ui/portal';
import { intlLocale } from '@/lib/intl';

import { foldForFilter } from './CategorySidebar';

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
  className?: string;
  testId?: string;
}

/** Options drawn at once with no filter typed; typing reaches the rest. Keeps a 3000-group source quick. */
export const PICKER_RENDER_CAP = 400;
/**
 * cmdk's item value for an option whose value is empty ("All channels" is `''`): cmdk never
 * highlights an empty value, so the arrow keys found nothing to stop on and Enter picked nothing
 * while it was the current choice. Only the cmdk side sees it; `onChange` still gets `''`.
 */
const EMPTY_ITEM = '\u2063scope-all';
const itemValue = (v: string) => (v === '' ? EMPTY_ITEM : v);

/** A touch screen: the picker then opens without focusing the filter, so no keyboard covers the list. */
function coarsePointer(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
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
  className,
  testId,
}: ScopePickerProps) {
  const { t, i18n } = useTranslation('live');
  const fmt = useMemo(() => new Intl.NumberFormat(intlLocale(i18n.language)), [i18n.language]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [place, setPlace] = useState<{ top?: number; bottom?: number; left: number; width: number; maxHeight: number; above: boolean } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const { present, closing } = usePresence(open, popRef);

  const all = useMemo(() => sections.flatMap((s) => s.options), [sections]);
  const current = all.find((o) => o.value === value);
  const filterable = all.length >= filterFrom;
  const q = foldForFilter(query.trim());
  const shown = useMemo(() => {
    let budget = PICKER_RENDER_CAP;
    return sections
      .map((s) => {
        const options = (q ? s.options.filter((o) => foldForFilter(o.label).includes(q)) : s.options).slice(0, Math.max(0, budget));
        budget -= options.length;
        return { ...s, options };
      })
      .filter((s) => s.options.length > 0);
  }, [sections, q]);
  const shownCount = shown.reduce((n, s) => n + s.options.length, 0);
  const capped = !q && shownCount < all.length;

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
    setQuery('');
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

  // Focus goes into the popover's field once it is up. A short list has no visible filter: the
  // field is then visually hidden and read-only, and still holds focus so the arrow keys move
  // and screen readers follow the highlighted option (aria-activedescendant). On a touch screen
  // the list takes focus instead: a focused field would raise the on-screen keyboard over it, and
  // a tap on the filter still brings the keyboard up to type. The list, not the cmdk root: cmdk
  // moves focus to its field whenever the highlight changes while the root has it.
  useLayoutEffect(() => {
    if (!open) return;
    if (coarsePointer()) listRef.current?.focus({ preventScroll: true });
    else inputRef.current?.focus({ preventScroll: true });
  }, [open]);

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
      // Not the dialog under it: React bubbles portal events through the tree.
      e.preventDefault();
      e.stopPropagation();
      if (query) setQuery('');
      else close();
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
        className={fieldClass('sm', cn('inline-flex min-w-0 items-center gap-2 pe-2 text-start', className))}
      >
        {current?.icon ? <span aria-hidden className="flex shrink-0 text-fg-muted">{current.icon}</span> : null}
        <span dir="auto" className={cn('min-w-0 flex-1 truncate', !current && 'text-fg-subtle')}>
          {current?.label ?? placeholder ?? ''}
        </span>
        <ChevronDown aria-hidden size={16} className={cn('shrink-0 text-fg-muted motion-safe:transition-transform', open && 'rotate-180')} />
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
              {/* cmdk names its field by `label` (aria-labelledby wins over aria-label): the filter's
                  purpose when it shows, else the picker's own name. */}
              <Cmdk
                label={filterable ? (filterLabel ?? t('filterGroups')) : label}
                shouldFilter={false}
                loop
                defaultValue={itemValue(value)}
                vimBindings={false}
                className="flex min-h-0 flex-col"
              >
                <div className={filterable ? 'border-b border-divider p-1.5' : 'sr-only'}>
                  <Cmdk.Input
                    ref={inputRef}
                    value={filterable ? query : ''}
                    onValueChange={filterable ? setQuery : undefined}
                    readOnly={!filterable}
                    placeholder={filterable ? (filterLabel ?? t('filterGroups')) : undefined}
                    className={fieldClass('sm', 'bg-surface-2')}
                  />
                </div>
                <Cmdk.List
                  ref={listRef}
                  id={listId}
                  tabIndex={-1}
                  aria-label={label}
                  className="min-h-0 overflow-y-auto overscroll-contain p-1"
                  style={{ maxHeight: place.maxHeight }}
                >
                  {shownCount === 0 ? <div className="px-3 py-6 text-center text-sm text-fg-muted">{t('noGroupsMatch', { query: query.trim() })}</div> : null}
                  {shown.map((s) => (
                    <Cmdk.Group key={s.id} heading={s.heading}>
                      {s.options.map((o) => {
                        const chosen = o.value === value;
                        return (
                          <Cmdk.Item
                            key={o.value}
                            value={itemValue(o.value)}
                            onSelect={() => pick(o.value)}
                            data-chosen={chosen || undefined}
                            className={cn('flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm text-fg-muted hover:bg-hover', TOUCH_TARGET)}
                          >
                            <span aria-hidden className="flex w-4 shrink-0 justify-center text-fg-muted">
                              {o.icon ?? null}
                            </span>
                            <span dir="auto" className={cn('min-w-0 flex-1 truncate text-match-parent', chosen && 'font-medium text-fg')}>
                              {o.label}
                            </span>
                            {o.count !== undefined ? <span className="shrink-0 text-caption tabular-nums text-fg-subtle">{fmt.format(o.count)}</span> : null}
                            <Check aria-hidden size={14} className={cn('shrink-0 text-fg-muted', !chosen && 'invisible')} />
                          </Cmdk.Item>
                        );
                      })}
                    </Cmdk.Group>
                  ))}
                  {capped ? <p className="px-3 py-2 text-caption text-fg-subtle">{t('pickerTypeForMore')}</p> : null}
                </Cmdk.List>
              </Cmdk>
            </div>,
            portalContainer(),
          )
        : null}
    </>
  );
}
