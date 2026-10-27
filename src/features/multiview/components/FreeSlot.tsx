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
 * sets its height: the 1+3 side slot of a 1440 px window keeps two rows above "More channels", a
 * 2x2 slot all three. Rows and "More channels" are 44 px on a touch screen, so there each row
 * waits for a wider (so taller) slot. Stacked, the slot takes its content's height and keeps them all.
 */
const ROW_ROOM = [
  'block',
  'hidden @[20rem]/slot:block pointer-fine:@[16rem]/slot:block @max-2xl/wall:block',
  'hidden @[26rem]/slot:block pointer-fine:@[21rem]/slot:block @max-2xl/wall:block',
];
const SKELETON_ROOM = [
  'flex',
  'hidden @[20rem]/slot:flex pointer-fine:@[16rem]/slot:flex @max-2xl/wall:flex',
  'hidden @[26rem]/slot:flex pointer-fine:@[21rem]/slot:flex @max-2xl/wall:flex',
];
/** The "Recent and favorite channels" caption, above three rows. */
const CAPTION_ROOM = 'hidden @[28rem]/slot:block pointer-fine:@[24rem]/slot:block @max-2xl/wall:block';

function SlotNumber({ number }: { number: number }) {
  return (
    <span aria-hidden className="absolute start-2 top-2 flex size-6 items-center justify-center rounded-sm bg-surface-3 font-numeric text-sm tabular-nums text-fg-muted">
      {number}
    </span>
  );
}

/** What a plain free frame shows: a plus and "Add channel". */
function AddFace({ label }: { label: string }) {
  return (
    <>
      <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full border border-edge bg-surface-2 group-hover/slot:border-border group-hover/slot:text-fg">
        <Plus className="size-5" />
      </span>
      <span className="text-center text-sm font-medium">{label}</span>
    </>
  );
}

export interface FreeSlotProps {
  slot: number;
  className: string;
  /** A tile is being moved: free slots take no channel meanwhile. */
  disabled: boolean;
  /** The slot the next channel goes into (tiles fill the slots in order): it offers the quick picks. */
  next: boolean;
  /** The wall is empty: the next slot also says how the wall works. */
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
  // The first slot of an empty wall says how the wall works, and is described by it. On a fitted
  // wall the toolbar shows the line in the room sound and clear take later (WallToolbar), so here
  // it is for screen readers only; the same 45rem stage switches both.
  const explains = next && intro;
  const hint = (shown: string) =>
    explains ? (
      <span id={hintId} data-testid="multiview-empty-hint" className={cn('max-w-[28rem] text-center text-sm font-normal text-pretty text-fg-muted', shown)}>
        {t('emptyBody')}
      </span>
    ) : null;

  if (!next || (!picksLoading && picks.length === 0)) {
    // Stacked (a wall under 42rem, a phone), the slots after the next one are left out and the
    // next one is a short row: N full-width 16:9 frames were screens of dashes to scroll past.
    // The toolbar's Add channel and the next slot still reach the picker. On an empty wall the
    // row grows to say how the wall works above the plus: with nothing recent or favorite yet
    // (a new user), it is the only place a phone says it.
    const stacked = explains ? '@max-2xl:aspect-auto @max-2xl:py-3' : '@max-2xl:aspect-auto @max-2xl:h-14 @max-2xl:flex-row @max-2xl:gap-3';
    return (
      <button
        type="button"
        data-slot-focus={slot}
        data-testid="multiview-empty-slot"
        data-slot={number}
        disabled={disabled}
        aria-label={t('slotEmptyLabel', { slot: number })}
        aria-describedby={explains ? hintId : undefined}
        onClick={() => onAdd(slot)}
        className={cn(
          FRAME,
          '@container/slot group/slot flex flex-col items-center justify-center gap-2 p-2 text-fg-muted outline-none',
          next ? stacked : 'hidden @2xl:flex',
          'hover:border-accent hover:bg-surface hover:text-fg active:bg-surface-2',
          'focus-visible:border-solid focus-visible:border-focus focus-visible:text-fg',
          'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-divider disabled:hover:bg-surface/50',
          'motion-safe:transition-colors motion-safe:duration-150',
          className,
        )}
      >
        <SlotNumber number={number} />
        {hint('px-12 @[45rem]/stage:sr-only')}
        <AddFace label={t('addChannel')} />
      </button>
    );
  }

  return (
    // A click on the frame around the rows opens the picker, as anywhere on the other free
    // frames; "More channels" is the keyboard's way to it.
    <div
      role="group"
      aria-label={t('slotEmptyLabel', { slot: number })}
      aria-describedby={explains ? hintId : undefined}
      data-testid="multiview-next-slot"
      data-slot={number}
      onClick={(e) => {
        if (disabled || (e.target as Element).closest('button')) return;
        onAdd(slot);
      }}
      className={cn(
        FRAME,
        '@container/slot flex flex-col @max-2xl:aspect-auto',
        // Lit like the other free frames, except while the pointer is on a channel row.
        !disabled && 'hover:[&:not(:has(li:hover))]:border-accent hover:[&:not(:has(li:hover))]:bg-surface',
        'has-[>button:focus-visible]:border-solid has-[>button:focus-visible]:border-focus',
        'motion-safe:transition-colors motion-safe:duration-150',
        className,
      )}
    >
      <SlotNumber number={number} />
      {/* Stacked, the toolbar has no room for the line, and the slot takes its content's height,
          so it shows here at any width; the padding keeps it clear of the slot number. */}
      {hint('self-center px-12 pt-3 @[45rem]/stage:sr-only')}
      {/* Under 16rem a row would show a few letters of a name, and IPTV names share their first
          ones ("US| NBA TV FHD", "US| NBC FHD"): the slot is a plain frame then, like the others. */}
      <button
        type="button"
        data-slot-focus={slot}
        data-testid="multiview-next-slot-add"
        disabled={disabled}
        aria-label={t('slotEmptyLabel', { slot: number })}
        onClick={() => onAdd(slot)}
        className={cn(
          'group/slot flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-2 text-fg-muted outline-none @[16rem]/slot:hidden @max-2xl/wall:min-h-14',
          'hover:text-fg focus-visible:text-fg disabled:cursor-not-allowed disabled:opacity-40',
        )}
      >
        <AddFace label={t('addChannel')} />
      </button>
      {/* The slot number takes the start corner, so the rows start after it where they would
          reach it, and use the rest of the slot's width. */}
      <div data-testid="multiview-next-slot-picks" className="hidden flex-1 flex-col items-center justify-center p-3 ps-10 @[16rem]/slot:flex @[23rem]/slot:ps-3">
        <div className="flex w-full max-w-[18rem] min-w-0 flex-col gap-1.5">
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
              <p aria-hidden className={cn('text-caption text-fg-muted', CAPTION_ROOM)}>
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
            icon={<Search aria-hidden size={16} className="shrink-0" />}
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
    </div>
  );
}
