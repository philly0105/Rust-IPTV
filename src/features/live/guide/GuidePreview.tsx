/**
 * The band above the guide grid (CB-GUIDE-PREVIEW): the player on the inline start, so playing
 * from the guide no longer floats the mini player over the grid's later programmes, and the
 * programme under the cursor or the pointer on the other side: its channel, title, time with
 * progress, genre, three lines of description and the actions (Watch, catch-up, Remind, Record).
 * Channels DVR, TiviMate and the Apple TV app put the same strip over their guides.
 *
 * Shown from md up on windows tall enough to keep a useful grid under it; it can be hidden from
 * the toolbar (a UI preference in localStorage). Nothing plays by itself: the band shows the
 * player only once something plays.
 */

import { CalendarClock, History, Play, Radio, Tv } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { Channel, EpgProgram, SourceKind } from '@/api/types';
import { PlayerStage } from '@/features/player';
import { Button, LivePill, MetaLine, Skeleton } from '@/ui';
// recording:
import { ProgramActions } from '@/features/recording';

import { ChannelLogo } from '../components/ChannelLogo';
import { displayChannelName } from '../lib/channelName';
import { canCatchUp, formatDay, formatRange, localDayKey, minutesLeft, ms, programProgress, programWhen } from '../lib/epgTime';
import { genreColor, genreOf } from './genre';
import { useProgramDescription } from './programDescription';

const PREVIEW_KEY = 'guide.preview';

/** Whether the band is open (UI preference; open unless the user hid it). */
export function storedPreviewOpen(): boolean {
  try {
    return localStorage.getItem(PREVIEW_KEY) !== '0';
  } catch {
    return true;
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
  now: number;
  /** The guide's source kind (catch-up support); undefined for rows of another source. */
  kind?: SourceKind;
  stripPrefix: boolean;
  /** `epgOffsetMinutes` in ms: the description is asked for the guide's own times. */
  offsetMs: number;
  onWatch(channel: Channel): void;
  onCatchup(channel: Channel, program: EpgProgram): void;
}

export function GuidePreview(props: GuidePreviewProps) {
  const { t } = useTranslation('guide');
  const { channel, program } = props;
  const name = channel ? displayChannelName(channel.name, props.stripPrefix) : '';
  return (
    <section
      aria-label={t('previewTitle')}
      data-testid="guide-preview"
      className="flex h-[13.5rem] shrink-0 gap-4 border-b border-divider bg-surface px-3 py-3"
    >
      <div className="relative aspect-video h-full shrink-0 overflow-hidden rounded-lg bg-black shadow-1 ring-1 ring-edge">
        <PlayerStage className="h-full w-full">
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[radial-gradient(120%_90%_at_50%_20%,rgb(38_48_66)_0%,transparent_70%)] px-3 text-center">
            {channel ? (
              <>
                <ChannelLogo src={channel.logoUrl} name={name} size={44} sourceId={channel.ref.sourceId} className="shadow-2" />
                {/* Secondary: the band's one primary action is the details' Watch. */}
                <Button size="sm" variant="secondary" icon={<Play size={14} className="fill-current" />} onClick={() => props.onWatch(channel)} className="max-w-full">
                  <span className="truncate">{t('watchNow', { channel: name })}</span>
                </Button>
              </>
            ) : (
              <Tv size={24} aria-hidden className="text-on-glass-muted" />
            )}
          </div>
        </PlayerStage>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {channel && program ? (
          <PreviewDetails {...props} channel={channel} program={program} name={name} />
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

function PreviewDetails(props: GuidePreviewProps & { channel: Channel; program: EpgProgram; name: string }) {
  const { t, i18n } = useTranslation('live');
  const { channel, program, now, kind, name } = props;
  const lang = i18n.language;
  const when = programWhen(program, now);
  const catchupOk = canCatchUp(program, channel, kind, now);
  const genre = genreOf(program.category);
  const { description, pending } = useProgramDescription(channel.ref, program, props.offsetMs);
  const start = ms(program.start);
  return (
    <>
      <p className="flex min-w-0 items-center gap-2 text-caption text-fg-muted">
        <ChannelLogo src={channel.logoUrl} name={name} size={20} sourceId={channel.ref.sourceId} />
        {channel.number !== undefined ? <span className="font-numeric tabular-nums">{channel.number}</span> : null}
        <span dir="auto" className="min-w-0 truncate">
          {name}
        </span>
      </p>
      <h2 dir="auto" className="mt-1 truncate text-title-sm text-match-parent text-fg" data-testid="guide-preview-title">
        {program.title}
      </h2>
      <MetaLine
        className="mt-1"
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
      {when === 'now' ? (
        <span aria-hidden className="mt-2 block h-[3px] w-full max-w-xs overflow-hidden rounded-full bg-surface-3">
          <span className="block h-full rounded-full bg-accent" style={{ width: `${programProgress(program, now) * 100}%` }} />
        </span>
      ) : null}
      {description ? (
        <p dir="auto" className="mt-2 line-clamp-3 max-w-prose text-body-sm text-match-parent text-fg-muted" data-testid="guide-preview-description">
          {description}
        </p>
      ) : pending ? (
        <div aria-hidden className="mt-3 flex max-w-prose flex-col gap-2">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ) : null}
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
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
          <Button size="sm" variant={catchupOk ? 'ghost' : 'secondary'} icon={<Play size={14} />} onClick={() => props.onWatch(channel)}>
            {t('playChannel', { name })}
          </Button>
        ) : null}
        {/* recording: */}
        <ProgramActions channelRef={channel.ref} channelName={name} program={program} now={now} />
      </div>
    </>
  );
}
