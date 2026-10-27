import { useId, type KeyboardEvent, type ReactNode } from 'react';

import { TOUCH_TARGET } from './Button';
import { cn } from './cn';
import { GLASS_FOCUS } from './focus';
import { useTooltip, withTooltipProps } from './Tooltip';

/** `default` on app surfaces; `glass` inside the player's glass menus. */
export type SegmentedTone = 'default' | 'glass';

/**
 * The colours of the segmented look per tone, exported so src/ui/test/contrast.test.ts checks the
 * pairs it really draws (it reads the token names out of these classes). The chosen segment is
 * one raised, neutral thumb (amber marks actions, not choices: DS-STATE-FILLS) with a ring that
 * keeps 3:1 against the track (WCAG 1.4.11): the raised fill alone was 1.24:1 on the dark track
 * and 1.09:1 on the light one. Glass segments take the glass accent for focus, since the theme's
 * focus colour is a deep shade in light that does not read on glass.
 */
export const SEGMENT_TONES = {
  default: {
    track: 'outline-edge bg-surface-2',
    thumb: 'bg-raised text-fg shadow-1 ring-1 ring-border',
    rest: 'text-fg-muted hover:bg-hover hover:text-fg active:bg-active',
    focus: '',
  },
  glass: {
    track: 'bg-white/6',
    thumb: 'bg-white/16 text-white ring-1 ring-on-glass-muted',
    rest: 'text-white/80 hover:bg-white/10 hover:text-white',
    focus: GLASS_FOCUS,
  },
} as const;

/**
 * Forced colours (Windows High Contrast) drop the thumb's fill and ring, which left nothing to
 * tell the chosen segment by. It takes the system's selected colours instead.
 */
const SEGMENT_FORCED = 'forced-color-adjust-none forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]';

/**
 * The segmented look, shared with the pill Tabs: a recessed track and one raised, neutral thumb
 * for the chosen segment (SEGMENT_TONES). The track's edge is an outline drawn just inside it
 * rather than a border, so it adds nothing to the height: a 30 px segment in the track's padding
 * makes the control as tall as an `md` button or field (h-10), and the compact size as tall as an
 * `sm` one (h-8), so a segmented control lines up with the select, search field or button beside
 * it. With a border it stood 2 px taller than both. Not an inset ring: that is a box-shadow, which
 * forced colours drop, leaving the unchosen segments as loose text; they repaint an outline in the
 * system's text colour instead. The track itself never takes focus, so the focus outline does not
 * replace this one.
 *
 * On a touch screen the track takes the buttons' 44 px floor (TOUCH_TARGET) at either size, as
 * fields do, and the segments stretch to fill it: buttons grow to 44 px there, so a 30 or 38 px
 * track no longer matched them, and a 30 px segment was a small target.
 */
export const SEGMENT_TRACK: Record<SegmentedTone, string> = {
  default: `flex gap-1 rounded-md p-1 outline-1 -outline-offset-1 ${TOUCH_TARGET} ${SEGMENT_TONES.default.track}`,
  glass: `flex gap-1 rounded-md p-0.5 ${TOUCH_TARGET} ${SEGMENT_TONES.glass.track}`,
};

/** `md` (default) for forms and toolbars, as tall as an `md` button; `sm` for a compact header row beside `sm` buttons, as tall as them (h-8). */
export type SegmentedSize = 'sm' | 'md';

const SM_TRACK = 'gap-0.5 p-0.5';
const SM_SEGMENT = 'min-h-7 px-2';

export function segmentClass(selected: boolean, tone: SegmentedTone = 'default'): string {
  const tones = SEGMENT_TONES[tone];
  return cn(
    'inline-flex min-h-8 min-w-0 items-center justify-center gap-1.5 rounded-sm px-3 text-sm font-medium motion-safe:transition-colors disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:opacity-40',
    selected ? cn(tones.thumb, SEGMENT_FORCED) : tones.rest,
    tones.focus,
    // A segment that cannot be chosen keeps its resting look under the pointer.
    'aria-disabled:hover:bg-transparent',
    tone === 'default' ? 'aria-disabled:hover:text-fg-muted' : 'aria-disabled:hover:text-white/80',
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  /** Accessible name; also the visible text unless `content` is given. */
  label: string;
  /** Visible content when it is not the label (an icon, a sample). The label then shows as a tooltip. */
  content?: ReactNode;
  /** Out of use, with no reason given: the segment is a disabled button (no pointer events, skipped by the arrows). */
  disabled?: boolean;
  /**
   * Cannot be chosen now, and says why ("Holds two channels. Close a tile first."). The segment
   * stays focusable and hoverable (aria-disabled), the arrows stop on it without choosing it,
   * its tooltip shows the reason and it is the segment's description.
   */
  disabledReason?: string;
  className?: string;
  testId?: string;
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
  size?: SegmentedSize;
  testId?: string;
}

function Segment<T extends string>({
  option,
  selected,
  tone,
  size,
  itemClassName,
  onChange,
  onKeyDown,
}: {
  option: SegmentedOption<T>;
  selected: boolean;
  tone: SegmentedTone;
  size: SegmentedSize;
  itemClassName?: string;
  onChange: (value: T) => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const reasonId = useId();
  const reason = option.disabledReason;
  const iconOnly = option.content !== undefined;
  // A segment showing an icon or a sample names itself in a tooltip; one that cannot be chosen
  // says why there (under its name when the name is not on screen).
  const tip = reason ? (
    iconOnly ? (
      <span className="flex flex-col">
        <span>{option.label}</span>
        <span>{reason}</span>
      </span>
    ) : (
      reason
    )
  ) : iconOnly ? (
    option.label
  ) : null;
  const { triggerProps, tooltip } = useTooltip({ content: tip, describe: false, tone });
  const own = { onKeyDown, 'aria-describedby': reason ? reasonId : undefined };
  return (
    <>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        aria-label={iconOnly ? option.label : undefined}
        aria-disabled={reason ? true : undefined}
        tabIndex={selected ? 0 : -1}
        disabled={option.disabled}
        data-value={option.value}
        data-testid={option.testId}
        onClick={() => {
          if (!reason) onChange(option.value);
        }}
        className={cn(segmentClass(selected, tone), size === 'sm' && SM_SEGMENT, itemClassName, option.className)}
        {...withTooltipProps(own, triggerProps)}
      >
        {option.content ?? option.label}
      </button>
      {reason ? (
        // The description: read through aria-describedby even while hidden.
        <span id={reasonId} hidden>
          {reason}
        </span>
      ) : null}
      {tooltip}
    </>
  );
}

/**
 * Single choice among two to six short options shown side by side (a radio group drawn as
 * segments). Arrow keys follow the screen (mirrored in RTL) and choose as they move, Home and
 * End jump, and only the chosen segment is in the Tab order. Up and Down move too on app
 * surfaces; in the glass tone they are left to the menu around it. The keys are claimed, so
 * page and player shortcuts never see them. A segment with a `disabledReason` takes focus from
 * the arrows (so its reason is heard) but is never chosen.
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
  size = 'md',
  testId,
}: SegmentedControlProps<T>) {
  const reachable = options.filter((o) => !o.disabled);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    // From the focused segment: it may be one the arrows stopped on without choosing it.
    const from = e.currentTarget.dataset['value'];
    const i = reachable.findIndex((o) => o.value === from);
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    const fwd = (i + 1) % reachable.length;
    const back = i < 0 ? reachable.length - 1 : (i - 1 + reachable.length) % reachable.length;
    let target: number | null = null;
    if (e.key === (rtl ? 'ArrowLeft' : 'ArrowRight') || (tone === 'default' && e.key === 'ArrowDown')) target = fwd;
    else if (e.key === (rtl ? 'ArrowRight' : 'ArrowLeft') || (tone === 'default' && e.key === 'ArrowUp')) target = back;
    else if (e.key === 'Home') target = 0;
    else if (e.key === 'End') target = reachable.length - 1;
    if (target === null) return;
    e.preventDefault();
    e.stopPropagation();
    const next = reachable[target];
    if (!next || next.value === from) return;
    const group = e.currentTarget.parentElement;
    const segment = (v: string) => [...(group?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])].find((el) => el.dataset['value'] === v);
    if (next.disabledReason) {
      segment(next.value)?.focus();
      return;
    }
    if (next.value !== value) onChange(next.value);
    requestAnimationFrame(() => group?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
  };
  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={label}
      aria-describedby={describedBy}
      data-testid={testId}
      className={cn(SEGMENT_TRACK[tone], size === 'sm' && SM_TRACK, 'w-fit', className)}
    >
      {options.map((o) => (
        <Segment key={o.value} option={o} selected={o.value === value} tone={tone} size={size} itemClassName={itemClassName} onChange={onChange} onKeyDown={onKeyDown} />
      ))}
    </div>
  );
}
