/**
 * The ScopePicker's popover body: a cmdk list with headed sections, counts, the filter field and
 * the current choice ticked. Its own chunk, loaded when the picker is first about to open (or the
 * page idles): cmdk brings the Radix dialog stack with it, about 17 kB gzipped that the guide's
 * and multi-view's first render no longer wait for (performance audit SH-10).
 */

import { Command as Cmdk } from 'cmdk';
import { Check } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { cn, fieldClass, TOUCH_TARGET } from '@/ui';
import { intlLocale } from '@/lib/intl';

import { foldForFilter } from './CategorySidebar';
import type { PickerSection } from './ScopePicker';

/** Options drawn at once with no filter typed; typing reaches the rest. Keeps a 3000-group source quick. */
export const PICKER_RENDER_CAP = 400;
/**
 * cmdk's item value for an option whose value is empty ("All channels" is `''`): cmdk never
 * highlights an empty value, so the arrow keys found nothing to stop on and Enter picked nothing
 * while it was the current choice. Only the cmdk side sees it; `onPick` still gets `''`.
 */
const EMPTY_ITEM = '\u2063scope-all';
const itemValue = (v: string) => (v === '' ? EMPTY_ITEM : v);

/** A touch screen: the picker then opens without focusing the filter, so no keyboard covers the list. */
function coarsePointer(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

export interface ScopePickerListProps {
  label: string;
  value: string;
  sections: readonly PickerSection[];
  filterLabel?: string;
  filterFrom: number;
  listId: string;
  maxHeight: number;
  onPick(value: string): void;
}

export function ScopePickerList({ label, value, sections, filterLabel, filterFrom, listId, maxHeight, onPick }: ScopePickerListProps) {
  const { t, i18n } = useTranslation('live');
  const fmt = useMemo(() => new Intl.NumberFormat(intlLocale(i18n.language)), [i18n.language]);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const all = useMemo(() => sections.flatMap((s) => s.options), [sections]);
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

  // Focus goes into the popover's field once it is up. A short list has no visible filter: the
  // field is then visually hidden and read-only, and still holds focus so the arrow keys move
  // and screen readers follow the highlighted option (aria-activedescendant). On a touch screen
  // the list takes focus instead: a focused field would raise the on-screen keyboard over it, and
  // a tap on the filter still brings the keyboard up to type. The list, not the cmdk root: cmdk
  // moves focus to its field whenever the highlight changes while the root has it.
  useLayoutEffect(() => {
    if (coarsePointer()) listRef.current?.focus({ preventScroll: true });
    else inputRef.current?.focus({ preventScroll: true });
  }, []);

  // Escape clears a typed filter first; with none, the popover closes (ScopePicker).
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && query) {
      e.preventDefault();
      e.stopPropagation();
      setQuery('');
    }
  };

  return (
    // cmdk names its field by `label` (aria-labelledby wins over aria-label): the filter's
    // purpose when it shows, else the picker's own name.
    <Cmdk
      label={filterable ? (filterLabel ?? t('filterGroups')) : label}
      shouldFilter={false}
      loop
      defaultValue={itemValue(value)}
      vimBindings={false}
      onKeyDown={onKey}
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
      <Cmdk.List ref={listRef} id={listId} tabIndex={-1} aria-label={label} className="min-h-0 overflow-y-auto overscroll-contain p-1" style={{ maxHeight }}>
        {shownCount === 0 ? <div className="px-3 py-6 text-center text-sm text-fg-muted">{t('noGroupsMatch', { query: query.trim() })}</div> : null}
        {shown.map((s) => (
          <Cmdk.Group key={s.id} heading={s.heading}>
            {s.options.map((o) => {
              const chosen = o.value === value;
              return (
                <Cmdk.Item
                  key={o.value}
                  value={itemValue(o.value)}
                  onSelect={() => onPick(o.value)}
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
  );
}
