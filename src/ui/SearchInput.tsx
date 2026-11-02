import { Search, X } from 'lucide-react';
import { useRef, type ComponentPropsWithRef } from 'react';
import { useTranslation } from 'react-i18next';

import { TOUCH_TARGET } from './Button';
import { cn } from './cn';
import { useMergedRef } from './Tooltip';

// The field look and SearchInput live apart from Field.tsx (F1-7): the header's search field is in
// the entry chunk, and as part of Field.tsx it brought Switch, Select, RadioGroup, Slider,
// Textarea and Checkbox along, which only lazy pages use. Field.tsx and the @/ui barrel re-export
// them.

/**
 * The text field look shared by Input, Textarea, Select, SearchInput and any field a feature
 * has to build itself (CommitInput, a filter box in a dialog): the 3:1 control border, a hover
 * firm-up, and on focus the focus-colour border with a 3px glow (the global rule in globals.css
 * draws the glow; there is no offset outline on fields). The glow sits outside the box, so a
 * scroll container holding fields keeps a little padding on every side (Dialog's body does).
 *
 * On a touch screen a field takes the buttons' 44 px floor (TOUCH_TARGET): at its own 30 or
 * 38 px it sat between 44 px buttons in every toolbar (Live's search between the groups button
 * and the quality filter, My List's search beside its menu), so no row of controls lined up,
 * and a 30 px field was a small target too. A minimum height, so a mouse keeps h-8 and h-10.
 */
export const fieldBase =
  'w-full rounded-md border border-border bg-surface text-fg placeholder:text-fg-subtle ' +
  'hover:border-fg-subtle focus-visible:border-focus disabled:cursor-not-allowed disabled:opacity-50 ' +
  'aria-[invalid=true]:border-danger motion-safe:transition-colors ' +
  TOUCH_TARGET;

/** Field classes for a hand-built input: `fieldClass('sm', 'font-mono')`. Sizes match Input (md) and SearchInput (sm). */
export function fieldClass(size: 'sm' | 'md' = 'md', className?: string): string {
  return cn(fieldBase, 'px-3 text-sm', size === 'sm' ? 'h-8' : 'h-10', className);
}

export interface SearchInputProps extends Omit<ComponentPropsWithRef<'input'>, 'onChange' | 'onSubmit' | 'value' | 'type' | 'size'> {
  value: string;
  onChange: (value: string) => void;
  /** Enter key. */
  onSubmit?: (value: string) => void;
  /** Accessible name when there is no visible label. Defaults to the placeholder. */
  label?: string;
  size?: 'sm' | 'md';
}

export function SearchInput({
  value,
  onChange,
  onSubmit,
  label,
  placeholder,
  className,
  size = 'md',
  onKeyDown,
  ref,
  ...rest
}: SearchInputProps) {
  const { t } = useTranslation('common');
  const input = useRef<HTMLInputElement | null>(null);
  const mergedRef = useMergedRef(ref, input);
  return (
    <div className={cn('relative flex items-center', className)}>
      <Search aria-hidden size={16} className="pointer-events-none absolute start-3 text-fg-subtle" />
      <input
        ref={mergedRef}
        type="search"
        role="searchbox"
        value={value}
        placeholder={placeholder ?? t('search')}
        aria-label={label ?? placeholder ?? t('search')}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === 'Enter') onSubmit?.(value);
          if (e.key === 'Escape' && value) {
            e.stopPropagation();
            onChange('');
          }
        }}
        className={cn(
          fieldBase,
          // pe-11 on touch: the clear button grows to 36 px there (end-1 plus 36 px reaches
          // 39.75 px in), so the text stops short of it and a tap at the end of a query moves
          // the caret instead of clearing the search.
          'ps-9 pe-9 text-sm pointer-coarse:pe-11 [&::-webkit-search-cancel-button]:hidden',
          size === 'sm' ? 'h-8' : 'h-10',
        )}
        {...rest}
      />
      {value && (
        <button
          type="button"
          aria-label={t('clearSearch')}
          onClick={() => {
            onChange('');
            // The button goes with the text; focus stays in the field instead of dropping to the page.
            input.current?.focus();
          }}
          // In the 44 px touch field the clear button grows to 36 px, the most it can take
          // inside the field's border; the input's end padding grows with it (pointer-coarse:pe-11).
          className="absolute end-1 inline-flex size-[calc(28rem/15)] items-center justify-center rounded-sm text-fg-subtle hover:bg-hover hover:text-fg active:bg-active motion-safe:transition-colors pointer-coarse:size-[calc(36rem/15)]"
        >
          <X aria-hidden size={14} />
        </button>
      )}
    </div>
  );
}
