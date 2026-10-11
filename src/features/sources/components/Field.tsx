import { clsx } from 'clsx';
import { useId, type ReactNode } from 'react';

export interface FieldControlProps {
  id: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}

/**
 * Label + control + hint/error, wired for screen readers. The control is
 * rendered by `children(props)` so any primitive can take the ids.
 */
export function Field({
  label,
  hint,
  error,
  optional,
  optionalLabel,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  optionalLabel?: string;
  className?: string;
  children: (props: FieldControlProps) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={clsx('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={id} className="flex items-baseline gap-2 text-sm font-medium text-fg">
        {label}
        {optional ? <span className="text-xs font-normal text-fg-subtle">{optionalLabel}</span> : null}
      </label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy })}
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p id={hintId} className="text-sm text-fg-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A quiet group heading inside a form. */
export function FieldGroup({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-4">
      <legend className="mb-1 font-display text-base font-semibold text-fg">{title}</legend>
      {description ? <p className="-mt-2 text-sm text-fg-muted">{description}</p> : null}
      {children}
    </fieldset>
  );
}
