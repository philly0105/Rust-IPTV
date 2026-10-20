import { type KeyboardEvent, type ReactNode } from 'react';

import { cn } from './cn';
import { useTooltip, withTooltipProps } from './Tooltip';

/** `default` on app surfaces; `glass` inside the player's glass menus. */
export type SegmentedTone = 'default' | 'glass';

/**
 * The segmented look, shared with the pill Tabs: a recessed track and one raised, neutral thumb
 * for the chosen segment (bg-raised + shadow-1). Amber marks actions, not choices, so the thumb
 * is never an accent fill (DS-STATE-FILLS).
 */
export const SEGMENT_TRACK: Record<SegmentedTone, string> = {
  default: 'flex gap-1 rounded-md border border-edge bg-surface-2 p-1',
  glass: 'flex gap-1 rounded-md bg-white/6 p-0.5',
};

export function segmentClass(selected: boolean, tone: SegmentedTone = 'default'): string {
  return cn(
    'inline-flex min-h-8 min-w-0 items-center justify-center gap-1.5 rounded-sm px-3 text-sm font-medium motion-safe:transition-colors disabled:opacity-40',
    tone === 'default'
      ? selected
        ? 'bg-raised text-fg shadow-1'
        : 'text-fg-muted hover:bg-hover hover:text-fg active:bg-active'
      : selected
        ? 'bg-white/16 text-white ring-1 ring-white/35'
        : 'text-white/80 hover:bg-white/10 hover:text-white',
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  /** Accessible name; also the visible text unless `content` is given. */
  label: string;
  /** Visible content when it is not the label (an icon, a sample). The label then shows as a tooltip. */
  content?: ReactNode;
  disabled?: boolean;
  className?: string;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  /** Accessible name of the group. */
  label: string;
  id?: string;
  describedBy?: string;
  tone?: SegmentedTone;
  /** Classes for the track (width, wrapping). */
  className?: string;
  /** Classes for every segment (equal widths: `flex-1`). */
  itemClassName?: string;
  testId?: string;
}

function Segment<T extends string>({
  option,
  selected,
  tone,
  itemClassName,
  onChange,
  onKeyDown,
}: {
  option: SegmentedOption<T>;
  selected: boolean;
  tone: SegmentedTone;
  itemClassName?: string;
  onChange: (value: T) => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  // A segment showing an icon or a sample names itself in a tooltip.
  const { triggerProps, tooltip } = useTooltip({ content: option.content === undefined ? null : option.label, describe: false, tone });
  const own = { onKeyDown };
  return (
    <>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        aria-label={option.content === undefined ? undefined : option.label}
        tabIndex={selected ? 0 : -1}
        disabled={option.disabled}
        data-value={option.value}
        onClick={() => onChange(option.value)}
        className={cn(segmentClass(selected, tone), itemClassName, option.className)}
        {...withTooltipProps(own, triggerProps)}
      >
        {option.content ?? option.label}
      </button>
      {tooltip}
    </>
  );
}

/**
 * Single choice among two to six short options shown side by side (a radio group drawn as
 * segments). Arrow keys follow the screen (mirrored in RTL) and choose as they move, Home and
 * End jump, and only the chosen segment is in the Tab order. Up and Down move too on app
 * surfaces; in the glass tone they are left to the menu around it. The keys are claimed, so
 * page and player shortcuts never see them.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
  id,
  describedBy,
  tone = 'default',
  className,
  itemClassName,
  testId,
}: SegmentedControlProps<T>) {
  const enabled = options.filter((o) => !o.disabled);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = enabled.findIndex((o) => o.value === value);
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    const fwd = (i + 1) % enabled.length;
    const back = i < 0 ? enabled.length - 1 : (i - 1 + enabled.length) % enabled.length;
    let target: number | null = null;
    if (e.key === (rtl ? 'ArrowLeft' : 'ArrowRight') || (tone === 'default' && e.key === 'ArrowDown')) target = fwd;
    else if (e.key === (rtl ? 'ArrowRight' : 'ArrowLeft') || (tone === 'default' && e.key === 'ArrowUp')) target = back;
    else if (e.key === 'Home') target = 0;
    else if (e.key === 'End') target = enabled.length - 1;
    if (target === null) return;
    e.preventDefault();
    e.stopPropagation();
    const next = enabled[target];
    if (!next || next.value === value) return;
    onChange(next.value);
    const group = e.currentTarget.parentElement;
    requestAnimationFrame(() => group?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
  };
  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={label}
      aria-describedby={describedBy}
      data-testid={testId}
      className={cn(SEGMENT_TRACK[tone], 'w-fit', className)}
    >
      {options.map((o) => (
        <Segment key={o.value} option={o} selected={o.value === value} tone={tone} itemClassName={itemClassName} onChange={onChange} onKeyDown={onKeyDown} />
      ))}
    </div>
  );
}
