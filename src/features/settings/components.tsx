import { clsx } from 'clsx';
import { useEffect, useId, useState, type ReactNode } from 'react';

import { ErrorState, Skeleton } from '@/ui';

/** One settings page: heading, optional lead, and grouped rows. */
export function SettingsSection({ title, description, children, testId }: { title: string; description?: string; children: ReactNode; testId?: string }) {
  return (
    <section className="flex flex-col gap-8" aria-labelledby="settings-section-title" data-testid={testId}>
      <header className="flex max-w-2xl flex-col gap-1.5">
        <h2 id="settings-section-title" className="font-display text-2xl font-semibold text-fg">
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
      <div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">{children}</div>
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

/** A switch row: the whole row is the label. */
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
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={description ? `${id}-desc` : undefined}
        disabled={disabled}
        data-testid={testId}
        onClick={() => onChange(!checked)}
        className={clsx(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border disabled:opacity-50 motion-safe:transition-colors',
          checked ? 'border-accent bg-accent' : 'border-border bg-surface-3',
        )}
      >
        <span
          aria-hidden
          className={clsx(
            'inline-block size-4 rounded-full shadow-1 motion-safe:transition-transform',
            checked ? 'translate-x-6 bg-accent-fg' : 'translate-x-1 bg-fg-muted',
          )}
        />
      </button>
    </div>
  );
}

/**
 * Text input that keeps a local draft and commits on blur or Enter after
 * validation. Escape restores the saved value.
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
      className={clsx(
        'h-10 w-full rounded-md border border-border bg-surface-2 px-3 text-fg placeholder:text-fg-subtle disabled:opacity-50',
        mono && 'font-mono text-sm',
        className,
      )}
    />
  );
}

/** Segmented single choice (radio group) for 2..4 options. */
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
    <div id={id} role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-md border border-border bg-surface-2 p-1">
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              const i = options.findIndex((x) => x.value === value);
              const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              const next = options[(i + step + options.length) % options.length];
              if (next) {
                onChange(next.value);
                const group = e.currentTarget.parentElement;
                requestAnimationFrame(() => group?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
              }
            }}
            className={clsx(
              'rounded-sm px-3 py-1.5 text-sm font-medium motion-safe:transition-colors',
              selected ? 'bg-accent text-accent-fg' : 'text-fg-muted hover:bg-surface-3 hover:text-fg',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function SectionSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-6" data-testid="settings-loading">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-96 max-w-full" />
      <div className="flex flex-col gap-px overflow-hidden rounded-lg border border-border">
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
