import { clsx } from 'clsx';
import { useEffect, useId, useState, type ReactNode } from 'react';

import { ErrorState, SegmentedControl, Skeleton, Switch, cn, fieldClass } from '@/ui';

/** One settings page: heading, optional lead, and grouped rows. */
export function SettingsSection({ title, description, children, testId }: { title: string; description?: string; children: ReactNode; testId?: string }) {
  return (
    <section className="flex flex-col gap-8" aria-labelledby="settings-section-title" data-testid={testId}>
      <header className="flex max-w-2xl flex-col gap-1.5">
        <h2 id="settings-section-title" className="text-title text-fg">
          {title}
        </h2>
        {description ? <p className="text-fg-muted">{description}</p> : null}
      </header>
      {children}
    </section>
  );
}

/** A titled block of rows. */
export function SettingsGroup({ title, description, children, actions }: { title?: string; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      {title || actions ? (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            {title ? <h3 className="font-display text-base font-semibold text-fg">{title}</h3> : null}
            {description ? <p className="text-sm text-fg-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className="flex flex-col divide-y divide-divider rounded-lg border border-edge bg-surface">{children}</div>
    </div>
  );
}

/**
 * Label + description on the left, control on the right; stacks on narrow
 * containers. `children` receives the control id.
 */
export function SettingsRow({
  label,
  description,
  error,
  children,
  stack,
}: {
  label: ReactNode;
  description?: ReactNode;
  error?: string | null;
  children: (ids: { id: string; describedBy?: string; invalid?: boolean }) => ReactNode;
  /** Control below the label at every width (long inputs). */
  stack?: boolean;
}) {
  const id = useId();
  const descId = `${id}-desc`;
  const errId = `${id}-err`;
  const describedBy = [error ? errId : null, description ? descId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={clsx('flex flex-col gap-3 px-4 py-4', !stack && '@2xl:flex-row @2xl:items-center @2xl:justify-between @2xl:gap-8')}>
      <div className="flex min-w-0 flex-col gap-0.5 @2xl:max-w-[60%]">
        <label htmlFor={id} className="font-medium text-fg">
          {label}
        </label>
        {description ? (
          <p id={descId} className="text-sm text-fg-muted">
            {description}
          </p>
        ) : null}
      </div>
      <div className={clsx('flex min-w-0 flex-col gap-1.5', stack ? 'w-full' : '@2xl:w-auto @2xl:shrink-0 @2xl:items-end')}>
        {children({ id, describedBy, invalid: error ? true : undefined })}
        {error ? (
          <p id={errId} role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** A switch row: label and description, and the kit Switch on the end (a label click toggles it). */
export function SwitchRow({
  label,
  description,
  checked,
  onChange,
  disabled,
  testId,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="font-medium text-fg">
          {label}
        </label>
        {description ? (
          <p id={`${id}-desc`} className="text-sm text-fg-muted">
            {description}
          </p>
        ) : null}
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        aria-describedby={description ? `${id}-desc` : undefined}
        disabled={disabled}
        data-testid={testId}
      />
    </div>
  );
}

/**
 * Text input that keeps a local draft and commits on blur or Enter after
 * validation. Escape restores the saved value. `invalid` (from
 * `SettingsRow`'s render prop) sets aria-invalid and the danger border.
 * It wears the kit's field look (fieldClass), and `className` merges through
 * tailwind-merge, so a width such as `w-28` replaces the default `w-full`.
 */
export function CommitInput({
  value,
  onCommit,
  validate,
  id,
  describedBy,
  placeholder,
  type = 'text',
  className,
  mono,
  inputMode,
  onError,
  disabled,
  invalid,
  testId,
}: {
  value: string;
  onCommit: (v: string) => void;
  validate?: (v: string) => string | null;
  id?: string;
  describedBy?: string;
  placeholder?: string;
  type?: 'text' | 'password' | 'url' | 'number';
  className?: string;
  mono?: boolean;
  inputMode?: 'text' | 'url' | 'numeric';
  onError: (key: string | null) => void;
  disabled?: boolean;
  invalid?: boolean;
  testId?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft === value) {
      onError(null);
      return;
    }
    const err = validate?.(draft) ?? null;
    onError(err);
    if (!err) onCommit(draft);
  };
  return (
    <input
      id={id}
      type={type}
      inputMode={inputMode}
      value={draft}
      disabled={disabled}
      placeholder={placeholder}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      autoComplete="off"
      spellCheck={false}
      data-testid={testId}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape' && draft !== value) {
          e.preventDefault();
          e.stopPropagation();
          setDraft(value);
          onError(null);
        }
      }}
      className={fieldClass('md', cn(mono && 'font-mono', className))}
    />
  );
}

/**
 * Segmented single choice (radio group) for 2..4 options: the kit SegmentedControl. In a narrow
 * container (a phone) it spans the row with equal segments whose labels wrap inside them; from
 * @2xl it shrinks to its content.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  id,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
  id?: string;
}) {
  return (
    <SegmentedControl<T>
      id={id}
      label={label}
      value={value}
      options={options}
      onChange={onChange}
      className="w-full @2xl:inline-flex @2xl:w-fit"
      itemClassName="flex-1 py-1.5 text-center text-balance break-words @2xl:flex-none"
    />
  );
}

export function SectionSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-6" data-testid="settings-loading">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-96 max-w-full" />
      <div className="flex flex-col gap-px overflow-hidden rounded-lg border border-edge">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-16 rounded-none" />
        ))}
      </div>
    </div>
  );
}

export function SectionError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div data-testid="settings-error">
      <ErrorState error={error} onRetry={onRetry} />
    </div>
  );
}
