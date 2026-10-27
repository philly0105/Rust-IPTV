import { LoaderCircle, Plus, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { itemKey } from '@/api/types';

import { Button, cn, TOUCH_TARGET } from '../deps';
import type { QuickPick } from '../quickPicks';
import { ChannelMark } from './ChannelMark';

/** The dashed frame every free slot draws: a monitor waiting for a channel. */
const FRAME = 'relative rounded-sm border-2 border-dashed border-divider bg-surface/50';

/** Widths of the placeholder names, varied like real channel names. */
const SKELETON_NAMES = ['w-24', 'w-16', 'w-20'];

/**
 * Which pick rows a slot has room for. Every slot is 16:9 on a fitted wall, so its width also
 * sets its height: a small 1+3 side slot keeps one or two rows above "More channels", a 2x2 slot
 * all three.
 */
const ROW_ROOM = ['', 'hidden @[16rem]/slot:block', 'hidden @[21rem]/slot:block'];
const SKELETON_ROOM = ['flex', 'hidden @[16rem]/slot:flex', 'hidden @[21rem]/slot:flex'];

function SlotNumber({ number }: { number: number }) {
  return (
    <span aria-hidden className="absolute start-2 top-2 flex size-6 items-center justify-center rounded-sm bg-surface-3 font-numeric text-sm tabular-nums text-fg-muted">
      {number}
    </span>
  );
}

export interface FreeSlotProps {
  slot: number;
  className: string;
  /** A tile is being moved: free slots take no channel meanwhile. */
  disabled: boolean;
  /** The slot the next channel goes into (tiles fill the slots in order): it offers the quick picks. */
  next: boolean;
  /** The wall is empty: the next slot also says what the wall does, where there is room. */
  intro: boolean;
  picks: readonly QuickPick[];
  picksLoading: boolean;
  /** Key of the pick being put up, while its parental check runs. */
  pending: string | null;
  onAdd(slot: number): void;
  onPick(p: QuickPick, slot: number): void;
}

/**
 * A free slot. The next one to fill lists up to three recent or favorite live channels that go up
 * with one click, and "More channels" for the picker; the others, and the next one when there is
 * nothing to offer, are one button that opens the picker.
 */
export function FreeSlot({ slot, className, disabled, next, intro, picks, picksLoading, pending, onAdd, onPick }: FreeSlotProps) {
  const { t } = useTranslation('multiview');
  const number = slot + 1;
  const hintId = `multiview-slot-hint-${number}`;
  // A slot's width also sets its height, so the line shows only in a large slot (a 2x2 slot on a
  // desktop window, the large 1+3 slot); the header says what the page is for in any case.
  const hint = (extra: string) =>
    next && intro ? (
      <span id={hintId} data-testid="multiview-empty-hint" className={cn('hidden max-w-[28rem] text-center text-sm font-normal text-pretty text-fg-muted @[32rem]/slot:block', extra)}>
        {t('emptyBody')}
      </span>
    ) : null;

  if (!next || (!picksLoading && picks.length === 0)) {
    return (
      <button
        type="button"
        data-slot-focus={slot}
        data-testid="multiview-empty-slot"
        data-slot={number}
        disabled={disabled}
        aria-label={t('slotEmptyLabel', { slot: number })}
        aria-describedby={next && intro ? hintId : undefined}
        onClick={() => onAdd(slot)}
        className={cn(
          FRAME,
          '@container/slot group/slot flex flex-col items-center justify-center gap-2 p-2 text-fg-muted outline-none',
          'hover:border-accent hover:bg-surface hover:text-fg active:bg-surface-2',
          'focus-visible:border-solid focus-visible:border-focus focus-visible:text-fg',
          'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-divider disabled:hover:bg-surface/50',
          'motion-safe:transition-colors motion-safe:duration-150',
          className,
        )}
      >
        <SlotNumber number={number} />
        <span aria-hidden className="flex size-10 items-center justify-center rounded-full border border-edge bg-surface-2 group-hover/slot:border-border group-hover/slot:text-fg">
          <Plus className="size-5" />
        </span>
        <span className="text-center text-sm font-medium">{t('addChannel')}</span>
        {hint('mt-1')}
      </button>
    );
  }

  return (
    <div
      role="group"
      aria-label={t('slotEmptyLabel', { slot: number })}
      data-testid="multiview-next-slot"
      data-slot={number}
      className={cn(FRAME, '@container/slot flex flex-col items-center justify-center p-3', className)}
    >
      <SlotNumber number={number} />
      {hint('mb-3')}
      {/* Clear of the slot number on either side, so a narrow slot never runs a row under it. */}
      <div className="flex w-[calc(100%-4.5rem)] max-w-[18rem] min-w-0 flex-col gap-1.5">
        {picksLoading ? (
          <div aria-hidden data-testid="multiview-quick-picks-skeleton" className="flex flex-col gap-1 motion-safe:animate-pulse">
            {SKELETON_NAMES.map((w, i) => (
              <div key={w} className={cn('h-8 items-center gap-2 rounded-md border border-edge bg-surface-2 ps-0.5', SKELETON_ROOM[i])}>
                <div className="size-6 rounded-sm bg-surface-3" />
                <div className={cn('h-3 rounded-sm bg-surface-3', w)} />
              </div>
            ))}
          </div>
        ) : (
          <>
            <p aria-hidden className="hidden text-caption text-fg-muted @[24rem]/slot:block">
              {t('quickPicksTitle')}
            </p>
            <ul aria-label={t('quickPicksTitle')} data-testid="multiview-quick-picks" className="flex flex-col gap-1">
              {picks.map((p, i) => {
                const k = itemKey(p.ref);
                const busy = pending === k;
                return (
                  <li key={k} className={ROW_ROOM[i]}>
                    <button
                      type="button"
                      aria-label={t('pickerAddLabel', { name: p.title })}
                      title={p.title}
                      aria-busy={busy || undefined}
                      disabled={disabled || (pending !== null && !busy)}
                      onClick={() => onPick(p, slot)}
                      className={cn(
                        'flex h-8 w-full min-w-0 items-center gap-2 rounded-md border border-edge bg-surface-2 ps-0.5 pe-2 text-start text-sm font-medium text-fg',
                        'hover:bg-surface-3 active:bg-pressed disabled:cursor-not-allowed disabled:opacity-50',
                        'motion-safe:transition-colors motion-safe:duration-150',
                        TOUCH_TARGET,
                      )}
                    >
                      <ChannelMark src={p.logo} sourceId={p.ref.sourceId} name={p.title} className="size-6.5" />
                      <span dir="auto" className="min-w-0 flex-1 truncate">
                        {p.title}
                      </span>
                      {busy ? (
                        <LoaderCircle aria-hidden className="size-4 shrink-0 text-fg-muted motion-safe:animate-spin" />
                      ) : (
                        <Plus aria-hidden className="size-4 shrink-0 text-fg-muted" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <Button
          variant="ghost"
          size="sm"
          icon={<Search aria-hidden size={16} />}
          data-slot-focus={slot}
          data-testid="multiview-empty-slot"
          aria-label={t('slotMoreLabel', { slot: number })}
          disabled={disabled}
          onClick={() => onAdd(slot)}
          className="w-full"
        >
          {t('moreChannels')}
        </Button>
      </div>
    </div>
  );
}
