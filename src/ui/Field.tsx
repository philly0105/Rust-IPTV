import { ChevronDown, Search, X } from 'lucide-react';
import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from './cn';

const fieldBase =
  'w-full rounded-md border border-border bg-surface text-fg placeholder:text-fg-subtle ' +
  'hover:border-fg-subtle focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50 ' +
  'aria-[invalid=true]:border-danger motion-safe:transition-colors';

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
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error} className={wrapperClassName}>
      <div className={cn('relative', !label && !hint && !error && wrapperClassName)}>
        <select
          id={id}
          className={cn(fieldBase, 'h-10 appearance-none ps-3 pe-9 text-sm', className)}
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

/** Switch with role="switch"; Space and Enter toggle (native button behavior). */
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
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={description ? `${id}-desc` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border motion-safe:transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'border-accent bg-accent' : 'border-border bg-surface-3',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'inline-block h-4.5 w-4.5 rounded-full shadow-1 motion-safe:transition-transform',
            checked ? 'translate-x-5.5 bg-accent-fg rtl:-translate-x-5.5' : 'translate-x-0.75 bg-fg-muted rtl:-translate-x-0.75',
          )}
        />
      </button>
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
  ...rest
}: SearchInputProps) {
  const { t } = useTranslation('common');
  return (
    <div className={cn('relative flex items-center', className)}>
      <Search aria-hidden size={16} className="pointer-events-none absolute start-3 text-fg-subtle" />
      <input
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
          onClick={() => onChange('')}
          className="absolute end-1 inline-flex size-[28px] items-center justify-center rounded-sm text-fg-subtle hover:bg-surface-2 hover:text-fg active:bg-surface-3 motion-safe:transition-colors"
        >
          <X aria-hidden size={14} />
        </button>
      )}
    </div>
  );
}
