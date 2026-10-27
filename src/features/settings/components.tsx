import { clsx } from 'clsx';
import { Check, Info } from 'lucide-react';
import { createContext, useContext, useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorState, SegmentedControl, Skeleton, Switch, cn, fieldClass } from '@/ui';

/** Where a save stands, for the inline confirmation (SS-17). */
export type SaveState = 'idle' | 'saving' | 'saved';

/**
 * The page's save state and the row it came from (`data-settings-row` of the row the user last
 * pressed or focused). The row shows "Saved" in its bottom end corner, under its control; a save
 * from anywhere else (a theme card, a dialog) shows it beside the section title. One
 * confirmation, next to what changed, and clear of the mini player and toasts in the corner.
 */
// Marked pure, so a module that reaches this one only for a type or an unused export can drop it.
export const SaveFeedback = /* @__PURE__ */ createContext<{ state: SaveState; rowId: string | null }>({ state: 'idle', rowId: null });

/**
 * "Saving…" then a check and "Saved", fading in and out. Hidden from screen readers: the page's
 * polite status (SettingsPage) announces the same thing once.
 */
function SavedMark({ state, className }: { state: SaveState; className?: string }) {
  const { t } = useTranslation('settings');
  return (
    <span
      aria-hidden
      data-testid="settings-saved-mark"
      data-state={state}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 text-caption font-medium motion-safe:transition-opacity motion-safe:duration-(--duration-base)',
        state === 'idle' ? 'opacity-0' : 'opacity-100',
        state === 'saved' ? 'text-success' : 'text-fg-muted',
        className,
      )}
    >
      {state === 'saved' ? <Check size={12} /> : null}
      {state === 'saving' ? t('saving') : state === 'saved' ? t('saved') : null}
    </span>
  );
}

/**
 * The mark for one row: shown while the last save came from it. Always mounted and out of flow,
 * in the row's bottom end corner, so a save never changes the row's layout. Beside the label it
 * took a line of its own wherever the label filled its line (most rows at phone width): the row
 * grew for two seconds and the switch moved from under the finger. The corner is free in every
 * row: the bottom padding (py-3.5) holds the 12 px mark (leading-none) with 2 px to spare, and
 * the control sits above it, the description at the start.
 */
function RowMark({ rowId }: { rowId: string }) {
  const fb = useContext(SaveFeedback);
  return (
    <SavedMark
      state={fb.rowId === rowId ? fb.state : 'idle'}
      className="pointer-events-none absolute bottom-0.5 end-4 whitespace-nowrap leading-none"
    />
  );
}

/**
 * One settings page: its heading and grouped rows. The heading is a step under the shell header's
 * "Settings" (text-title-sm, the size of a section heading), so the header stays the one page
 * title and the heading reads as the current nav item's name. Below md (the phone layout, where
 * the shell header names the section) it is for screen readers only, so the first group starts
 * right under the header.
 *
 * No lead line under the heading: it only listed the groups that follow, and the phone's list of
 * sections, where a lead helps pick one, still shows it. `description` is accepted and not drawn,
 * for callers outside this feature that still pass one.
 */
export function SettingsSection({ title, children, testId }: { title: string; description?: string; children: ReactNode; testId?: string }) {
  const fb = useContext(SaveFeedback);
  return (
    <section className="relative flex flex-col gap-8 max-md:gap-6" aria-labelledby="settings-section-title" data-testid={testId}>
      {/* On a phone the header holds only the hidden heading, so it takes no row of its own
          (`contents`), and the section's gap does not open above the first group. The mark for a
          save from outside a row (a theme card, an accent swatch) then sits out of flow at the end
          of the first group's title line, at that line's height: as a flex child it pushed the
          groups down by itself and the gap for two seconds, under the finger that tapped. */}
      <header className="flex flex-wrap items-baseline gap-x-3 max-md:contents">
        <h2 id="settings-section-title" className="text-title-sm text-fg max-md:sr-only">
          {title}
        </h2>
        {fb.rowId === null && fb.state !== 'idle' ? (
          <SavedMark
            state={fb.state}
            className="max-md:pointer-events-none max-md:absolute max-md:end-0 max-md:top-0 max-md:leading-(--text-body--line-height)"
          />
        ) : null}
      </header>
      {children}
    </section>
  );
}

/**
 * A titled block of rows. In a section of more than one group every group has a title, so a
 * group without one never reads as the overflow of the one above; only a section's single group
 * may go without. `tone="danger"` is the danger zone: irreversible actions, with a danger outline
 * and heading, at the end of a section. `id` makes it a link target
 * (`/settings/general#sources`); `descriptionId` lets a control inside be described by the
 * group's description.
 */
export function SettingsGroup({
  title,
  description,
  descriptionId,
  children,
  actions,
  tone = 'default',
  id,
}: {
  title?: string;
  description?: ReactNode;
  descriptionId?: string;
  children: ReactNode;
  actions?: ReactNode;
  tone?: 'default' | 'danger';
  id?: string;
}) {
  return (
    <div id={id} className="flex scroll-mt-6 flex-col gap-3" data-tone={tone} data-settings-group={title ? 'titled' : 'untitled'}>
      {title || actions ? (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            {title ? (
              <h3 className={clsx('text-body font-semibold', tone === 'danger' ? 'text-danger' : 'text-fg')}>
                {title}
              </h3>
            ) : null}
            {description ? (
              <p id={descriptionId} className="text-body-sm text-pretty text-fg-muted">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={clsx('flex flex-col divide-y divide-divider rounded-lg border bg-surface', tone === 'danger' ? 'border-danger/40' : 'border-edge')}>{children}</div>
    </div>
  );
}

/** A row's label column: the label and the help text (capped for reading, not by a percentage). */
function RowLabel({ htmlFor, label, description, descId }: { htmlFor: string; label: ReactNode; description?: ReactNode; descId: string }) {
  return (
    <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-0.5">
      <label htmlFor={htmlFor} className="text-body font-medium text-fg">
        {label}
      </label>
      {description ? (
        <p id={descId} className="max-w-[38rem] text-body-sm text-pretty text-fg-muted">
          {description}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Label and help text at the start, the control at the end. The control drops under the label
 * when the row has no room for both, and on a phone-width column it spans the row. `children`
 * receives the control id.
 */
export function SettingsRow({
  label,
  description,
  error,
  children,
  stack,
  dimmed,
}: {
  label: ReactNode;
  description?: ReactNode;
  error?: string | null;
  children: (ids: { id: string; describedBy?: string; invalid?: boolean }) => ReactNode;
  /** Control below the label at every width (long inputs). */
  stack?: boolean;
  /** The row's setting does nothing right now (its feature is off): the whole row dims, as a disabled SwitchRow does. The control still needs its own `disabled`. */
  dimmed?: boolean;
}) {
  const id = useId();
  const descId = `${id}-desc`;
  const errId = `${id}-err`;
  const describedBy = [error ? errId : null, description ? descId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div
      data-settings-row={id}
      data-dimmed={dimmed || undefined}
      className={clsx('relative flex flex-wrap items-center justify-between gap-x-8 gap-y-3 px-4 py-3.5 motion-safe:transition-opacity', dimmed && 'opacity-60')}
    >
      <RowLabel htmlFor={id} label={label} description={description} descId={descId} />
      <div className={clsx('flex min-w-0 max-w-full flex-col gap-1.5', stack ? 'basis-full' : '@max-md:basis-full @md:items-end')}>
        {children({ id, describedBy, invalid: error ? true : undefined })}
        {error ? (
          <p id={errId} role="alert" className="text-body-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
      <RowMark rowId={id} />
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
    <div data-settings-row={id} className={clsx('relative flex items-center justify-between gap-6 px-4 py-3.5', disabled && 'opacity-60')}>
      <RowLabel htmlFor={id} label={label} description={description} descId={`${id}-desc`} />
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        aria-describedby={description ? `${id}-desc` : undefined}
        disabled={disabled}
        data-testid={testId}
      />
      <RowMark rowId={id} />
    </div>
  );
}

/** A quiet line inside a group (what a feature that is off would need, a server-mode note): an info icon and muted text, no control. */
export function SettingsNote({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="flex items-start gap-2 px-4 py-3 text-body-sm text-fg-muted" data-testid={testId}>
      <Info aria-hidden size={16} className="mt-0.5 shrink-0 text-fg-subtle" />
      <span className="min-w-0">{children}</span>
    </p>
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
 * @md it shrinks to its content.
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
      className="w-full @md:inline-flex @md:w-fit"
      itemClassName="flex-1 py-1.5 text-center text-balance break-words @md:flex-none"
    />
  );
}

export function SectionSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-6" data-testid="settings-loading">
      {/* The section heading (text-title-sm); there is no lead line under it any more. */}
      <Skeleton className="h-6 w-40 max-md:hidden" />
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
