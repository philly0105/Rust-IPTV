/**
 * The band above the guide grid (CB-GUIDE-PREVIEW): the player on the inline start, so playing
 * from the guide no longer floats the mini player over the grid's later programmes, and the
 * programme under the cursor or the pointer on the other side: its channel, title with the
 * actions at its end (Watch, catch-up, Remind, Record), time with progress, genre and what comes
 * next, and two lines of description. Channels DVR, TiviMate and the Apple TV app put the same
 * strip over their guides.
 *
 * Shown from md up on windows tall enough to keep a useful grid under it; it can be hidden from
 * the toolbar (a UI preference in localStorage), and starts hidden on windows under 1000 px tall.
 * Nothing plays by itself: until something plays, the picture is the channel's logo, and a press
 * on it starts the channel.
 */

import { CalendarClock, History, Play, Radio, Tv } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Channel, EpgProgram, SourceKind } from '@/api/types';
import { PlayerStage } from '@/features/player';
import { Button, cn, LivePill, MetaLine, Skeleton, useScaledPx } from '@/ui';
// recording:
import { ProgramActions } from '@/features/recording';

import { ChannelLogo } from '../components/ChannelLogo';
import { displayChannelName } from '../lib/channelName';
import { canCatchUp, formatClock, formatDay, formatRange, localDayKey, minutesLeft, ms, programProgress, programWhen } from '../lib/epgTime';
import { genreColor, genreOf } from './genre';
import { useProgramDescription } from './programDescription';

const PREVIEW_KEY = 'guide.preview';
/**
 * Below this details width (px at 100 %) Remind, Record and Record series are icons, so the
 * actions stay on the title's line beside a readable title: wrapped, they pushed the title and
 * the description out of the band, whose height is fixed (the grid under it never moves).
 */
const PREVIEW_LABELLED_ACTIONS_PX = 720;

/** Whether the user opened or hid the band (UI preference); undefined until they chose. */
export function storedPreviewOpen(): boolean | undefined {
  try {
    const v = localStorage.getItem(PREVIEW_KEY);
    return v === null ? undefined : v !== '0';
  } catch {
    return undefined;
  }
}

export function storePreviewOpen(open: boolean): void {
  try {
    localStorage.setItem(PREVIEW_KEY, open ? '1' : '0');
  } catch {
    // storage unavailable: the choice lasts for the visit
  }
}

export interface GuidePreviewProps {
  channel?: Channel;
  program?: EpgProgram;
  /** The programme after `program` on its channel, when the guide has it. */
  next?: EpgProgram;
  now: number;
  /** The guide's source kind (catch-up support); undefined for rows of another source. */
  kind?: SourceKind;
  stripPrefix: boolean;
  /** `epgOffsetMinutes` in ms: the description is asked for the guide's own times. */
  offsetMs: number;
  onWatch(channel: Channel): void;
  onCatchup(channel: Channel, program: EpgProgram): void;
  /**
   * The pointer came onto or left the band: a hovered cell's programme stays in it while the
   * pointer is on its way to these buttons (EpgGridPage).
   */
  onPointerEnter?(): void;
  onPointerLeave?(): void;
}

/** True while the element is narrower than `px` (false until it is measured, and in tests). */
function useNarrowerThan(px: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width > 0 && width < px] as const;
}

export function GuidePreview(props: GuidePreviewProps) {
  const { t } = useTranslation('guide');
  const { channel, program } = props;
  const name = channel ? displayChannelName(channel.name, props.stripPrefix) : '';
  const [detailsRef, narrow] = useNarrowerThan(useScaledPx(PREVIEW_LABELLED_ACTIONS_PX));
  return (
    // One height whatever the programme says, so the grid under it never moves as the cursor goes;
    // a little more on touch, where the buttons are 44 px tall.
    <section
      aria-label={t('previewTitle')}
      data-testid="guide-preview"
      onPointerEnter={props.onPointerEnter}
      onPointerLeave={props.onPointerLeave}
      className="flex h-[10.5rem] shrink-0 gap-4 border-b border-divider bg-surface px-3 py-3 pointer-coarse:h-[11.5rem]"
    >
      <div className="relative aspect-video h-full shrink-0 overflow-hidden rounded-lg bg-black shadow-1 ring-1 ring-edge">
        <PlayerStage className="h-full w-full">
          {channel ? (
            // The picture is the press target, as a thumbnail is: no second Watch button beside the
            // details' one. Out of the tab order, which reaches that button; a play mark on hover.
            <button
              type="button"
              tabIndex={-1}
              aria-label={t('watchNow', { channel: name })}
              onClick={() => props.onWatch(channel)}
              data-testid="guide-preview-picture"
              className="group/pic absolute inset-0 flex items-center justify-center bg-[radial-gradient(120%_90%_at_50%_18%,hsl(220_20%_18%/0.85),transparent_68%)] outline-none"
            >
              <ChannelLogo src={channel.logoUrl} name={name} size={44} sourceId={channel.ref.sourceId} className="shadow-2 motion-safe:transition-opacity group-hover/pic:opacity-40" />
              <span
                aria-hidden
                className="absolute inline-flex size-10 items-center justify-center rounded-full bg-glass-strong text-on-glass opacity-0 ring-1 ring-glass-border motion-safe:transition-opacity group-hover/pic:opacity-100"
              >
                <Play size={18} className="fill-current" />
              </span>
            </button>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-[radial-gradient(120%_90%_at_50%_18%,hsl(220_20%_18%/0.85),transparent_68%)]">
              <Tv size={24} aria-hidden className="text-on-glass-muted" />
            </div>
          )}
        </PlayerStage>
      </div>
      <div ref={detailsRef} className="flex min-w-0 flex-1 flex-col">
        {channel && program ? (
          <PreviewDetails {...props} channel={channel} program={program} name={name} narrow={narrow} />
        ) : (
          <div className="flex h-full flex-col justify-center gap-1 text-fg-muted">
            <CalendarClock size={18} aria-hidden className="text-fg-subtle" />
            <p className="text-body-sm">{t('previewHint')}</p>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Everything but the description keeps its height (shrink-0); the description has two lines and
 * gives way first, so the title is never cut in half. The actions sit at the end of the title's
 * line, so the band is a third shorter and the grid under it keeps more rows.
 */
function PreviewDetails(props: GuidePreviewProps & { channel: Channel; program: EpgProgram; name: string; narrow: boolean }) {
  const { t, i18n } = useTranslation('live');
  const { t: tg } = useTranslation('guide');
  const { channel, program, next, now, kind, name, narrow } = props;
  const lang = i18n.language;
  const when = programWhen(program, now);
  const catchupOk = canCatchUp(program, channel, kind, now);
  const genre = genreOf(program.category);
  const { description, pending } = useProgramDescription(channel.ref, program, props.offsetMs);
  const start = ms(program.start);
  return (
    <>
      <p className="flex min-w-0 shrink-0 items-center gap-2 text-caption text-fg-muted">
        <ChannelLogo src={channel.logoUrl} name={name} size={20} sourceId={channel.ref.sourceId} />
        {channel.number !== undefined ? <span className="font-numeric tabular-nums">{channel.number}</span> : null}
        <span dir="auto" className="min-w-0 truncate">
          {name}
        </span>
      </p>
      <div className="mt-1 flex min-w-0 shrink-0 items-center gap-3" data-testid="guide-preview-title-row">
        <h2 dir="auto" title={program.title} className="min-w-0 flex-1 truncate text-title-sm text-match-parent text-fg" data-testid="guide-preview-title">
          {program.title}
        </h2>
        {/* One line: the record buttons are icons on a narrow band and a long "Play …" label truncates. */}
        <div className={cn('ms-auto flex min-w-0 shrink-0 flex-nowrap items-center gap-2', narrow && 'max-w-[60%]')} data-testid="guide-preview-actions">
          {when === 'now' ? (
            <Button size="sm" variant="primary" icon={<Radio size={14} />} onClick={() => props.onWatch(channel)}>
              {t('watchLive')}
            </Button>
          ) : null}
          {catchupOk ? (
            <Button size="sm" variant={when === 'now' ? 'secondary' : 'primary'} icon={<History size={14} />} onClick={() => props.onCatchup(channel, program)}>
              {when === 'now' ? t('startOver') : t('watchCatchup')}
            </Button>
          ) : null}
          {when !== 'now' ? (
            <Button size="sm" variant={catchupOk ? 'ghost' : 'secondary'} icon={<Play size={14} />} onClick={() => props.onWatch(channel)} className="min-w-0" title={narrow ? t('playChannel', { name }) : undefined}>
              <span className="truncate">{t('playChannel', { name })}</span>
            </Button>
          ) : null}
          {/* recording: */}
          <ProgramActions channelRef={channel.ref} channelName={name} program={program} now={now} variant={narrow ? 'icons' : 'buttons'} />
        </div>
      </div>
      <div className="mt-1 flex min-w-0 shrink-0 items-center gap-4">
        <MetaLine
          className="min-w-0 shrink-0"
          items={[
            when === 'now' ? <LivePill key="live" size="sm" dot="none" /> : null,
            <span key="time" className="tabular-nums">
              {when !== 'now' && localDayKey(start) !== localDayKey(now) ? `${formatDay(start, lang)} ` : ''}
              {formatRange(program, lang)}
            </span>,
            when === 'now' ? t('minutesLeft', { count: minutesLeft(program, now) }) : null,
            program.category ? (
              <span key="genre" className="inline-flex items-center gap-1.5">
                {genre ? <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: genreColor(genre) }} /> : null}
                <span className="truncate">{program.category}</span>
              </span>
            ) : null,
          ]}
        />
        {/* What follows on the channel, in the band's free width (the details' text stops at a readable measure). */}
        {next ? (
          <p className="ms-auto flex min-w-0 items-baseline gap-1.5 text-caption text-fg-muted" data-testid="guide-preview-next">
            <span className="shrink-0 text-fg-subtle">{tg('previewNext')}</span>
            <span className="shrink-0 tabular-nums">{formatClock(ms(next.start), lang)}</span>
            <span dir="auto" className="min-w-0 truncate text-match-parent text-fg" title={next.title}>
              {next.title}
            </span>
          </p>
        ) : null}
      </div>
      {when === 'now' ? (
        <span aria-hidden className="mt-1.5 block h-[3px] w-full max-w-xs shrink-0 overflow-hidden rounded-full bg-surface-3">
          <span className="block h-full rounded-full bg-accent-mark" style={{ width: `${programProgress(program, now) * 100}%` }} />
        </span>
      ) : null}
      {description ? (
        <p dir="auto" className="mt-1.5 line-clamp-2 min-h-0 max-w-prose text-body-sm text-match-parent text-fg-muted" data-testid="guide-preview-description">
          {description}
        </p>
      ) : pending ? (
        <div aria-hidden className="mt-2 flex min-h-0 max-w-prose flex-col gap-2 overflow-hidden">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ) : null}
    </>
  );
}
