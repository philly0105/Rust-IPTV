import { Check, ChevronDown, Minus, Search, X } from 'lucide-react';
import { useId, useLayoutEffect, useRef, type ComponentPropsWithRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from './cn';
import { useMergedRef } from './Tooltip';

/**
 * The text field look shared by Input, Textarea, Select, SearchInput and any field a feature
 * has to build itself (CommitInput, a filter box in a dialog): the 3:1 control border, a hover
 * firm-up, and on focus the focus-colour border with a 3px glow (the global rule in globals.css
 * draws the glow; there is no offset outline on fields). The glow sits outside the box, so a
 * scroll container holding fields keeps a little padding on every side (Dialog's body does).
 */
const fieldBase =
  'w-full rounded-md border border-border bg-surface text-fg placeholder:text-fg-subtle ' +
  'hover:border-fg-subtle focus-visible:border-focus disabled:cursor-not-allowed disabled:opacity-50 ' +
  'aria-[invalid=true]:border-danger motion-safe:transition-colors';

/** Field classes for a hand-built input: `fieldClass('sm', 'font-mono')`. Sizes match Input (md) and SearchInput (sm). */
export function fieldClass(size: 'sm' | 'md' = 'md', className?: string): string {
  return cn(fieldBase, 'px-3 text-sm', size === 'sm' ? 'h-8' : 'h-10', className);
}

interface FieldChrome {
  /** Visible label rendered above the control and wired with htmlFor. */
  label?: ReactNode;
  /** Help text under the control (aria-describedby). */
  hint?: ReactNode;
  /** Error text; marks the control aria-invalid. */
  error?: ReactNode;
}

function FieldFrame({
  id,
  label,
  hint,
  error,
  className,
  children,
}: FieldChrome & { id: string; className?: string; children: ReactNode }) {
  if (!label && !hint && !error) return <>{children}</>;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
      )}
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-sm text-fg-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, { hint, error }: FieldChrome): string | undefined {
  if (error) return `${id}-error`;
  if (hint) return `${id}-hint`;
  return undefined;
}

export interface InputProps extends ComponentPropsWithRef<'input'>, FieldChrome {
  /** Fires with the string value; `onChange` (native) still works. */
  onValueChange?: (value: string) => void;
  /** Class for the wrapper when label/hint/error are present. */
  wrapperClassName?: string;
}

export function Input({
  label,
  hint,
  error,
  id: idProp,
  className,
  wrapperClassName,
  onChange,
  onValueChange,
  ...rest
}: InputProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error} className={wrapperClassName}>
      <input
        id={id}
        className={cn(fieldBase, 'h-10 px-3 text-sm', className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, { hint, error })}
        onChange={(e) => {
          onChange?.(e);
          onValueChange?.(e.target.value);
        }}
        {...rest}
      />
    </FieldFrame>
  );
}

export interface TextareaProps extends ComponentPropsWithRef<'textarea'>, FieldChrome {
  onValueChange?: (value: string) => void;
  wrapperClassName?: string;
}

export function Textarea({
  label,
  hint,
  error,
  id: idProp,
  className,
  wrapperClassName,
  onChange,
  onValueChange,
  rows = 4,
  ...rest
}: TextareaProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error} className={wrapperClassName}>
      <textarea
        id={id}
        rows={rows}
        className={cn(fieldBase, 'px-3 py-2 text-sm leading-relaxed', className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, { hint, error })}
        onChange={(e) => {
          onChange?.(e);
          onValueChange?.(e.target.value);
        }}
        {...rest}
      />
    </FieldFrame>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<ComponentPropsWithRef<'select'>, 'children'>, FieldChrome {
  options: SelectOption[];
  onValueChange?: (value: string) => void;
  wrapperClassName?: string;
}

/** Native select (best keyboard and screen reader support), restyled. */
export function Select({
  options,
  label,
  hint,
  error,
  id: idProp,
  className,
  wrapperClassName,
  onChange,
  onValueChange,
  ...rest
}: SelectProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const selectClass = cn(fieldBase, 'h-10 appearance-none ps-3 pe-9 text-sm', className);
  // `w-auto` asks for a select as wide as its longest option. Chrome's own width for an
  // `appearance: none` select falls a few px short at some UI scales and densities, which cut
  // "Recently added" to "Recently adde" (L1-visual-20). An invisible copy of every label, with
  // the same padding, border and type, sizes a one-cell grid instead, and the select fills it.
  const fit = selectClass.split(' ').includes('w-auto');
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error} className={wrapperClassName}>
      <div className={cn('relative', fit && 'grid', !label && !hint && !error && wrapperClassName)}>
        {fit && (
          <span
            aria-hidden
            data-select-sizer=""
            className={cn(
              selectClass,
              'pointer-events-none invisible col-start-1 row-start-1 flex h-0 min-h-0 flex-col overflow-hidden border-transparent py-0 whitespace-nowrap',
            )}
          >
            {options.map((o) => (
              <span key={o.value}>{o.label}</span>
            ))}
          </span>
        )}
        <select
          id={id}
          className={cn(selectClass, fit && 'col-start-1 row-start-1 justify-self-stretch')}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, { hint, error })}
          onChange={(e) => {
            onChange?.(e);
            onValueChange?.(e.target.value);
          }}
          {...rest}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden
          size={16}
          className="pointer-events-none absolute top-1/2 end-3 -translate-y-1/2 text-fg-muted"
        />
      </div>
    </FieldFrame>
  );
}

export interface SwitchProps extends Omit<ComponentPropsWithRef<'button'>, 'onChange' | 'role' | 'children' | 'value' | 'type'> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/**
 * The switch's colours per state, exported so src/ui/test/contrast.test.ts checks the pairs the
 * switch really draws (it reads the token names out of these classes). The knob takes the
 * state's own high-contrast tone: a white knob was 1.2:1 on the light off track and 1.8:1 on the
 * bright amber fill. The on track's edge is the accent's indicator tone, which is the fill itself
 * in dark and a deep shade around the bright light-theme fill, so the on track keeps a 3:1
 * outline on a white panel too (WCAG 1.4.11).
 */
export const SWITCH_TONES = {
  off: { track: 'border-border bg-surface-3 hover:border-fg-subtle', knob: 'bg-fg-muted' },
  on: { track: 'border-accent-mark bg-accent-solid hover:bg-accent-solid-hover', knob: 'bg-accent-solid-fg' },
} as const;

/**
 * The one switch (role="switch"; Space and Enter toggle, as on any button). Off: a recessed
 * track with the 3:1 control border and a muted knob. On: the solid accent fill with a knob in
 * its text colour (SWITCH_TONES). The knob slides with motion allowed. Name it with a
 * <label htmlFor> (a label click toggles it) or aria-label. Toggle and the settings SwitchRow
 * render it.
 */
export function Switch({ checked, onCheckedChange, className, onClick, ...rest }: SwitchProps) {
  const tones = checked ? SWITCH_TONES.on : SWITCH_TONES.off;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) onCheckedChange(!checked);
      }}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border motion-safe:transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        tones.track,
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden
        data-switch-knob=""
        className={cn(
          'inline-block size-4.5 rounded-full shadow-1 motion-safe:transition-transform motion-safe:duration-(--duration-fast)',
          tones.knob,
          checked ? 'translate-x-5.5 rtl:-translate-x-5.5' : 'translate-x-0.5 rtl:-translate-x-0.5',
        )}
      />
    </button>
  );
}

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
  /** Hide the visible label (it stays the accessible name). */
  hideLabel?: boolean;
}

/** A labelled Switch: label and description on the start side, the switch on the end. */
export function Toggle({ checked, onChange, label, description, disabled, id: idProp, className, hideLabel }: ToggleProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className={cn('min-w-0', hideLabel && 'sr-only')}>
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        {description && (
          <p id={`${id}-desc`} className="mt-0.5 text-sm text-fg-muted">
            {description}
          </p>
        )}
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-describedby={description ? `${id}-desc` : undefined}
      />
    </div>
  );
}

export interface CheckboxProps extends Omit<ComponentPropsWithRef<'input'>, 'type' | 'size'> {
  /** The mixed state (some of a group chosen). Drawn as a bar; the input's `indeterminate` is set too. */
  indeterminate?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /** Classes for the box's wrapper (margins, alignment). `className` styles the input itself. */
  wrapperClassName?: string;
}

/**
 * Checkbox: a native input (so labels, forms, Space and screen readers work as usual) drawn as
 * an 18px box with the 3:1 control border; checked and mixed fill with the solid accent. Wrap it
 * in a <label> with its text, or give it aria-label.
 */
export function Checkbox({ indeterminate = false, onChange, onCheckedChange, className, wrapperClassName, ref, ...rest }: CheckboxProps) {
  const inner = useRef<HTMLInputElement | null>(null);
  const mergedRef = useMergedRef(ref, inner);
  useLayoutEffect(() => {
    if (inner.current) inner.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <span className={cn('relative inline-flex size-4.5 shrink-0', wrapperClassName)}>
      <input
        ref={mergedRef}
        type="checkbox"
        onChange={(e) => {
          onChange?.(e);
          onCheckedChange?.(e.target.checked);
        }}
        className={cn(
          'peer m-0 size-full cursor-pointer appearance-none rounded-xs border border-border bg-surface motion-safe:transition-colors',
          'not-checked:not-indeterminate:hover:border-fg-subtle checked:border-accent-solid checked:bg-accent-solid indeterminate:border-accent-solid indeterminate:bg-accent-solid',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...rest}
      />
      <Check
        aria-hidden
        strokeWidth={3}
        className="pointer-events-none absolute inset-0 m-auto size-3 text-accent-solid-fg opacity-0 peer-checked:opacity-100 peer-indeterminate:opacity-0"
      />
      <Minus
        aria-hidden
        strokeWidth={3}
        className="pointer-events-none absolute inset-0 m-auto size-3 text-accent-solid-fg opacity-0 peer-indeterminate:opacity-100"
      />
    </span>
  );
}

export interface SliderProps extends Omit<ComponentPropsWithRef<'input'>, 'type' | 'value' | 'defaultValue' | 'onChange' | 'min' | 'max' | 'step' | 'size'> {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** Every move, as a number (drag, arrow keys, Home/End). Commit on pointer up, key up or blur if saving is costly. */
  onValueChange: (value: number) => void;
}

/**
 * The one range slider: a native input (arrows, Home/End, Page keys) drawn by the `slider`
 * utility (globals.css). The part up to the value fills in the accent's mark tone, the rest is a
 * recessed track with the 3:1 control border, and the thumb is the solid accent with a ring of the
 * surface; the fill follows the input's direction, so it grows from the right in RTL. Focus is
 * the global outline. Name it with a <label htmlFor> or aria-label, and pass `aria-valuetext`
 * when the number alone does not say it ("6.5 stars", "110 %").
 */
export function Slider({ value, min = 0, max = 100, step = 1, onValueChange, className, style, ...rest }: SliderProps) {
  const fill = max > min ? (Math.max(min, Math.min(max, value)) - min) / (max - min) : 0;
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onValueChange(Number(e.currentTarget.value))}
      className={cn('slider', className)}
      style={{ ...style, ['--slider-fill' as string]: `${Math.round(fill * 10000) / 100}%` }}
      {...rest}
    />
  );
}

export interface RadioProps extends Omit<ComponentPropsWithRef<'input'>, 'type' | 'size'> {
  /** Classes for the circle's wrapper (margins, alignment). */
  wrapperClassName?: string;
}

/**
 * Radio: a native input (arrow keys move within its `name` group) drawn as an 18px circle with
 * the control border; checked draws the accent ring and dot. Most screens want RadioGroup.
 */
export function Radio({ className, wrapperClassName, ...rest }: RadioProps) {
  return (
    <span className={cn('relative inline-flex size-4.5 shrink-0', wrapperClassName)}>
      <input
        type="radio"
        className={cn(
          'peer m-0 size-full cursor-pointer appearance-none rounded-full border border-border bg-surface motion-safe:transition-colors',
          'not-checked:hover:border-fg-subtle checked:border-2 checked:border-accent-mark disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...rest}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 m-auto size-2 scale-0 rounded-full bg-accent-mark peer-checked:scale-100 motion-safe:transition-transform motion-safe:duration-(--duration-fast)"
      />
    </span>
  );
}

export interface RadioGroupOption<T extends string> {
  value: T;
  label: ReactNode;
  description?: ReactNode;
  /** A line under the description (a warning, a missing dependency). */
  note?: ReactNode;
  disabled?: boolean;
  testId?: string;
}

export interface RadioGroupProps<T extends string> {
  /** Accessible name of the group. */
  label: string;
  value: T;
  options: RadioGroupOption<T>[];
  onValueChange: (value: T) => void;
  /** Shared `name` of the inputs; generated when left out. */
  name?: string;
  className?: string;
}

/**
 * A vertical list of choices with a line of help each (pick a player, a quality). Each row is
 * a label, so the whole row picks it; the chosen row takes the neutral selected fill. For two
 * to four short options in a row use SegmentedControl.
 */
export function RadioGroup<T extends string>({ label, value, options, onValueChange, name: nameProp, className }: RadioGroupProps<T>) {
  const autoName = useId();
  const name = nameProp ?? autoName;
  return (
    <div role="radiogroup" aria-label={label} className={cn('flex flex-col gap-0.5', className)}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <label
            key={o.value}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-md px-3 py-3 motion-safe:transition-colors',
              selected ? 'bg-selected' : 'hover:bg-hover',
              o.disabled && 'cursor-not-allowed opacity-60',
            )}
          >
            <Radio
              name={name}
              value={o.value}
              checked={selected}
              disabled={o.disabled}
              onChange={() => onValueChange(o.value)}
              wrapperClassName="mt-0.5"
              data-testid={o.testId}
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium text-fg">{o.label}</span>
              {o.description ? <span className="text-sm text-fg-muted">{o.description}</span> : null}
              {o.note ? <span className="text-sm text-warning">{o.note}</span> : null}
            </span>
          </label>
        );
      })}
    </div>
  );
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
          'ps-9 pe-9 text-sm [&::-webkit-search-cancel-button]:hidden',
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
          className="absolute end-1 inline-flex size-[calc(28rem/15)] items-center justify-center rounded-sm text-fg-subtle hover:bg-hover hover:text-fg active:bg-active motion-safe:transition-colors"
        >
          <X aria-hidden size={14} />
        </button>
      )}
    </div>
  );
}
