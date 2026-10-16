/**
 * Jump to a date and time in the guide (Run 2 C5): day chips from two days
 * back to thirteen ahead, a 30-minute time select, and Now. Days and slots
 * come from the local calendar, so a 23 h or 25 h DST day lists exactly the
 * times that exist (the repeated hour twice, labelled with its zone).
 */

import { CalendarClock } from 'lucide-react';
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, cn, Dialog, Select, type SelectOption } from '@/ui';

import {
  atWallTime,
  daySlots,
  formatClock,
  formatClockZone,
  formatDay,
  jumpDays,
  localDayDiff,
  localDayStart,
  wallMinutes,
} from '../lib/epgTime';

export interface JumpToDialogProps {
  open: boolean;
  onClose(): void;
  /** The grid window's start: the dialog opens on its day and time. */
  start: number;
  now: number;
  /** A chosen instant on a 30-minute slot. */
  onJump(at: number): void;
  /** Back to the live window. */
  onNow(): void;
}

/** Options for the time select: clock labels, with the zone added where a fall-back hour repeats a label. */
export function slotOptions(slots: readonly number[], locale: string): SelectOption[] {
  const labels = slots.map((t) => formatClock(t, locale));
  const seen = new Map<string, number>();
  for (const l of labels) seen.set(l, (seen.get(l) ?? 0) + 1);
  return slots.map((t, i) => ({ value: String(t), label: (seen.get(labels[i]!) ?? 0) > 1 ? formatClockZone(t, locale) : labels[i]! }));
}

/** "today", "tomorrow", "yesterday" in the UI language, or nothing for other days. */
function relativeDay(diff: number, locale: string): string | undefined {
  if (diff < -1 || diff > 1) return undefined;
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(diff, 'day');
}

export function JumpToDialog({ open, onClose, start, now, onJump, onNow }: JumpToDialogProps) {
  const { t, i18n } = useTranslation('guide');
  const lang = i18n.language;
  const days = useMemo(() => jumpDays(now), [localDayStart(now)]); // eslint-disable-line react-hooks/exhaustive-deps
  const [day, setDay] = useState(() => localDayStart(start));
  const [at, setAt] = useState(start);
  const chipRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Each opening starts from the window on screen (or today, when that is outside the chips).
  // Set while rendering, not in an effect: the dialog's first frame, and the focus it gives the
  // selected chip on open, must already show this opening's day rather than the last one's.
  const [shownOpen, setShownOpen] = useState(false);
  if (open !== shownOpen) {
    setShownOpen(open);
    if (open) {
      const d = localDayStart(start);
      const inRange = days.includes(d);
      const nextDay = inRange ? d : localDayStart(now);
      setDay(nextDay);
      setAt(inRange ? start : atWallTime(nextDay, wallMinutes(start)));
    }
  }

  const slots = useMemo(() => daySlots(day), [day]);
  const options = useMemo(() => slotOptions(slots, lang), [slots, lang]);
  const selectedIndex = Math.max(0, days.indexOf(day));

  const pickDay = (d: number) => {
    setDay(d);
    // Keep the wall-clock time; on a DST day it moves to the nearest time that exists.
    setAt(atWallTime(d, wallMinutes(at)));
  };

  const submit = () => {
    onJump(slots.includes(at) ? at : atWallTime(day, wallMinutes(at)));
    onClose();
  };

  const onChipKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    let next = i;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = i + ((e.key === 'ArrowRight') === rtl ? -1 : 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = i + ((e.key === 'ArrowLeft') === rtl ? 1 : -1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = days.length - 1;
    else if (e.key === 'Enter') {
      e.preventDefault();
      submit();
      return;
    } else return;
    e.preventDefault();
    next = Math.min(days.length - 1, Math.max(0, next));
    pickDay(days[next]!);
    chipRefs.current[next]?.focus();
  };

  const target = slots.includes(at) ? at : atWallTime(day, wallMinutes(at));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={t('jumpTitle')}
      testId="guide-jump"
      footer={
        <>
          <Button
            variant="ghost"
            className="me-auto"
            onClick={() => {
              onNow();
              onClose();
            }}
            data-testid="guide-jump-now"
          >
            {t('jumpNow')}
          </Button>
          <Button variant="primary" icon={<CalendarClock className="size-4" aria-hidden />} onClick={submit} data-testid="guide-jump-go">
            {t('jumpGo')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {/* The readout: where the guide will land, set large like a tuner's display. */}
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1" aria-live="polite" data-testid="guide-jump-readout">
          <span className="font-display text-[calc(34rem/15)] leading-none font-semibold tabular-nums text-fg">{formatClock(target, lang)}</span>
          <span className="text-sm text-fg-muted first-letter:uppercase">{relativeDay(localDayDiff(target, now), lang) ?? formatDay(target, lang)}</span>
        </p>

        <div className="flex flex-col gap-2">
          <p id="guide-jump-days" className="text-sm font-medium text-fg">
            {t('jumpDay')}
          </p>
          <div role="radiogroup" aria-labelledby="guide-jump-days" className="grid grid-cols-[repeat(auto-fill,minmax(5.75rem,1fr))] gap-1.5">
            {days.map((d, i) => {
              const diff = localDayDiff(d, now);
              const selected = d === day;
              const rel = relativeDay(diff, lang);
              return (
                <button
                  key={d}
                  ref={(el) => {
                    chipRefs.current[i] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={i === selectedIndex ? 0 : -1}
                  // The dialog opens on the roving tab stop (the selected day), not the first chip.
                  data-autofocus={i === selectedIndex ? '' : undefined}
                  onClick={() => pickDay(d)}
                  onKeyDown={(e) => onChipKey(e, i)}
                  data-testid="guide-jump-day"
                  data-day={d}
                  className={cn(
                    'relative flex min-h-12 flex-col items-start justify-center rounded-md border px-2.5 py-1.5 text-start outline-none',
                    'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface',
                    'motion-safe:transition-colors',
                    selected
                      ? 'border-accent bg-accent text-accent-fg'
                      : diff < 0
                        ? 'border-divider bg-surface text-fg-muted hover:bg-surface-2 active:bg-surface-3'
                        : 'border-border bg-surface-2 text-fg hover:bg-surface-3 active:bg-pressed',
                  )}
                >
                  <span className={cn('text-[calc(11rem/15)] leading-tight first-letter:uppercase', selected ? 'text-accent-fg' : diff === 0 ? 'text-live' : 'text-fg-subtle')}>
                    {rel ?? ' '}
                  </span>
                  <span className="text-[calc(13rem/15)] leading-tight font-medium tabular-nums">{formatDay(d, lang)}</span>
                </button>
              );
            })}
          </div>
        </div>

        <Select
          label={t('jumpTime')}
          value={String(target)}
          options={options}
          onValueChange={(v) => setAt(Number(v))}
          wrapperClassName="max-w-56"
          data-testid="guide-jump-time"
        />
      </div>
    </Dialog>
  );
}
