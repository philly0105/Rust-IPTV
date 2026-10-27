/**
 * The streams matched to one game (lib/match.ts): the best one, rows with an action ahead of rows
 * without, and a small "+2" at the end of its metadata that shows the rest, so a card stays one
 * stream tall. Each row names the channel, the picture quality its name gives, why it matched (the
 * guide, an event channel's name, a team's own channel, or a network carrying the game) and offers
 * what fits the game's phase: Watch from 15 minutes before the start, Replay from the channel's
 * archive once it is over, Record before it starts. The player loads on the press.
 */

import { ChevronDown, ChevronUp, Circle, Clock, History, Play } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { sameRef, type ChannelQuality, type EpgProgram, type ItemRef, type Settings } from '@/api/types';
// Straight from its module (sports/deps.ts re-exports only ChannelLogo from it), the same chunk.
import { ChannelName } from '@/features/live/components/ChannelLogo';
import { channelQuality } from '@/lib/channelQuality';

import {
  Badge,
  Button,
  ChannelLogo,
  MetaLine,
  Tooltip,
  canCatchUp,
  displayChannelName,
  errorDescription,
  formatClock,
  formatTimeRange,
  loadPlayback,
  loadPlayerStore,
  markFor,
  ms,
  useDisplayPrefs,
  useRecordingCapabilities,
  useScheduleActions,
  useScheduleIndex,
  useSettingsValue,
  useToast,
} from '../deps';
import { gameWindow } from '../lib/espn';
import type { MatchReason, StreamMatch } from '../lib/match';
import type { Game } from '../lib/types';

const MINUTE = 60_000;
/** Watch shows this long before the listed start: the broadcast's pre-game is on by then. */
export const WATCH_BEFORE_MS = 15 * MINUTE;
/** A synthetic programme starts this long before the listed start, so a replay or recording opens on the pre-game. */
const LEAD_MS = 10 * MINUTE;
/** Rows shown before "Show all": the best stream, with the action the game allows now. */
export const STREAMS_SHOWN = 1;

const REASON_KEYS: Record<MatchReason, string> = { guide: 'reasonGuide', event: 'reasonEvent', team: 'reasonTeam', network: 'reasonNetwork' };

/** The sizes the quality filter's choices name ("HD (720p) and up"), so a row's tag reads against the "1080p+" chip. */
export const QUALITY_LABEL: Record<ChannelQuality, string> = { sd: 'SD', hd: '720p', fhd: '1080p', uhd: '4K' };

function QualityTag({ quality }: { quality: ChannelQuality }) {
  return (
    <span className="rounded-xs border border-edge px-1 text-2xs leading-4 font-semibold text-fg-muted tabular-nums" data-testid="sports-stream-quality">
      {QUALITY_LABEL[quality]}
    </span>
  );
}

/** What every stream row reads, built once per page by {@link useStreamContext}. */
export interface StreamContext {
  now: number;
  /** Channel names under `settings.stripCountryPrefix`. */
  strip: boolean;
  /** More than one source: rows name theirs. */
  multiSource: boolean;
  canRecord: boolean;
  /** The Live TV quality filter is on, so a missing event channel may be its doing. */
  qualityFiltered: boolean;
  /** A recording is waiting or running for this programme on this channel. */
  isRecording(ref: ItemRef, program: EpgProgram): boolean;
  watch(match: StreamMatch, title: string, name: string): Promise<void>;
  replay(match: StreamMatch, program: EpgProgram, name: string): Promise<void>;
  record(match: StreamMatch, program: EpgProgram, name: string): Promise<boolean>;
}

const selectMinQuality = (s: Settings) => s.liveMinQuality ?? null;

export function useStreamContext(now: number, sourceCount: number): StreamContext {
  const { t } = useTranslation('sports');
  const { toast } = useToast();
  const prefs = useDisplayPrefs();
  const canRecord = useRecordingCapabilities().data?.supported === true;
  const index = useScheduleIndex();
  const actions = useScheduleActions();
  const qualityFiltered = useSettingsValue(selectMinQuality).data != null;

  const watch = useCallback(
    async (m: StreamMatch, title: string, name: string) => {
      try {
        const [{ playChannel }, { usePlayerStore }] = await Promise.all([loadPlayback(), loadPlayerStore()]);
        await playChannel(m.channel, m.sourceKind, title, name);
        // Channel up and down then walk the channel's group, not the last Live category. Only when this
        // channel is the one playing: a refused PIN leaves what played alone.
        if (sameRef(usePlayerStore.getState().source?.ref, m.channel.ref)) {
          usePlayerStore.setState({ zapContext: { sourceId: m.sourceId, ...(m.channel.categoryId ? { categoryId: m.channel.categoryId } : {}) } });
        }
      } catch (err) {
        toast({ variant: 'error', title: t('playFailed', { name }), description: errorDescription(err) });
      }
    },
    [t, toast],
  );

  const replay = useCallback(
    async (m: StreamMatch, program: EpgProgram, name: string) => {
      try {
        const { playCatchup } = await loadPlayback();
        await playCatchup(m.channel, m.sourceKind, program, Date.now(), name);
      } catch (err) {
        toast({ variant: 'error', title: t('replayFailed'), description: errorDescription(err) });
      }
    },
    [t, toast],
  );

  const { record: schedule } = actions;
  const record = useCallback(
    (m: StreamMatch, program: EpgProgram, name: string) =>
      schedule({ ref: m.channel.ref, channelName: name, program: { title: program.title, start: program.start, end: program.end } }),
    [schedule],
  );

  const isRecording = useCallback((ref: ItemRef, program: EpgProgram) => !!markFor(index, ref, program).recording, [index]);

  return useMemo(
    () => ({ now, strip: prefs.stripCountryPrefix, multiSource: sourceCount > 1, canRecord, qualityFiltered, isRecording, watch, replay, record }),
    [now, prefs.stripCountryPrefix, sourceCount, canRecord, qualityFiltered, isRecording, watch, replay, record],
  );
}

function iso(t: number): string {
  return new Date(t).toISOString();
}

/**
 * The programme a replay or recording covers, titled with the game: the guide's when the match came
 * from it, else from 10 minutes before the start. Games often run past the league's typical length
 * (overtime, extra innings, a late first pitch), and a catch-up link or a recording stops at the
 * end, so the end is generous: an hour past the typical length (gameWindow), or the guide slot's
 * end when that is later. Null for a game without a real start time (TBD, or a flex window note
 * whose time is a placeholder) and no guide programme; with one, the slot is kept as it is.
 */
export function gameProgram(game: Game, m: StreamMatch, title: string): EpgProgram | null {
  const end = game.timeValid && !game.timeNote ? gameWindow(game).to : null;
  if (m.program) return end !== null && end > ms(m.program.end) ? { ...m.program, title, end: iso(end) } : { ...m.program, title };
  if (end === null) return null;
  return {
    channelId: m.channel.ref.itemId,
    start: iso(game.startMs - LEAD_MS),
    end: iso(end),
    title,
    // Not a guide programme: nothing may build a series rule on it.
    fromProvider: true,
  };
}

export type StreamAction = { kind: 'watch' } | { kind: 'replay' | 'record'; program: EpgProgram } | null;

/** A game with a real start time whose Watch is still to come: more than {@link WATCH_BEFORE_MS} before the start. */
function watchesLater(game: Game, now: number): boolean {
  return game.phase === 'scheduled' && game.timeValid && !game.timeNote && game.startMs - now > WATCH_BEFORE_MS;
}

/** The one action a row offers for `game` at `now`, or null (no archive, no recording, or a postponed game). */
export function streamAction(game: Game, m: StreamMatch, now: number, canRecord: boolean, title: string): StreamAction {
  const soon = game.phase === 'scheduled' && game.timeValid && !game.timeNote && game.startMs - now <= WATCH_BEFORE_MS;
  if (game.phase === 'live' || soon) return { kind: 'watch' };
  const program = gameProgram(game, m, title);
  if (!program) return null;
  if (game.phase === 'final') {
    if (!canCatchUp(program, m.channel, m.sourceKind, now)) return null;
    // A game that ended minutes ago: ask the archive for nothing past now.
    const end = Math.max(ms(program.start) + MINUTE, Math.min(ms(program.end), now));
    return { kind: 'replay', program: { ...program, end: iso(end) } };
  }
  if (game.phase === 'scheduled' && canRecord) return { kind: 'record', program };
  return null;
}

function WatchFrom({ time }: { time: string }) {
  const { t } = useTranslation('sports');
  const label = t('watchFrom', { time });
  // A clock, not a play mark: nothing here can be pressed yet, and a play mark beside a time read as a button.
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-caption text-fg-subtle tabular-nums" title={label} data-testid="sports-watch-from">
      <Clock aria-hidden size={12} />
      <span aria-hidden>{time}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function StreamRow({
  game,
  match,
  title,
  ctx,
  first,
  toggle,
}: {
  game: Game;
  match: StreamMatch;
  title: string;
  ctx: StreamContext;
  first: boolean;
  /** The first row's Show all toggle, at the end of its metadata. */
  toggle?: ReactNode;
}) {
  const { t, i18n } = useTranslation('sports');
  const [busy, setBusy] = useState(false);
  const name = displayChannelName(match.channel.name, ctx.strip) || match.channel.name;
  const action = streamAction(game, match, ctx.now, ctx.canRecord, title);
  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    void work().finally(() => setBusy(false));
  };

  let button = null;
  if (action?.kind === 'watch') {
    button = (
      <Button
        size="sm"
        variant="secondary"
        icon={<Play size={16} aria-hidden />}
        loading={busy}
        aria-label={t('watchLabel', { title, name })}
        onClick={() => run(() => ctx.watch(match, title, name))}
        data-testid="sports-watch"
      >
        {t('watch')}
      </Button>
    );
  } else if (action?.kind === 'replay') {
    const program = action.program;
    button = (
      <Button
        size="sm"
        variant="secondary"
        icon={<History size={16} aria-hidden />}
        loading={busy}
        aria-label={t('replayLabel', { title, name })}
        onClick={() => run(() => ctx.replay(match, program, name))}
        data-testid="sports-replay"
      >
        {t('replay')}
      </Button>
    );
  } else if (action?.kind === 'record') {
    const program = action.program;
    button = ctx.isRecording(match.channel.ref, program) ? (
      <Badge variant="success" data-testid="sports-recording-set">
        {t('recordingSet')}
      </Badge>
    ) : (
      <Button
        size="sm"
        variant="secondary"
        icon={<Circle size={14} aria-hidden className="fill-live text-live" />}
        loading={busy}
        aria-label={t('recordLabel', { title, name })}
        onClick={() => run(() => ctx.record(match, program, name))}
        data-testid="sports-record"
      >
        {t('record')}
      </Button>
    );
  }

  const program = match.program;
  const quality = channelQuality(match.channel.name);
  // The guide slot's times say what the card doesn't: when a live game's broadcast runs, which slot a
  // replay plays, or that coverage starts before the game. A slot that starts with an upcoming game
  // only repeats the start time above, the third time on the card with the Watch clock, so it goes.
  const slotRepeatsStart =
    program !== null && game.phase === 'scheduled' && game.timeValid && !game.timeNote && Math.abs(ms(program.start) - game.startMs) < MINUTE;
  return (
    <li className="flex min-w-0 items-center gap-3 py-2" data-testid="sports-stream" data-reason={match.reason}>
      <ChannelLogo src={match.channel.logoUrl} name={name} size={32} sourceId={match.sourceId} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {/* Named as Live TV's list names it: the country tag after the name, quiet. */}
        <ChannelName name={match.channel.name} strip={ctx.strip} className="truncate text-body-sm font-medium text-fg" testId="sports-stream-name" />
        {/* Wraps as a whole: where the details and the toggle don't fit beside an action, the toggle
            goes under them rather than the details breaking in two. */}
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          <MetaLine
            as="span"
            items={[
              // First, so the rows' qualities line up down the list; the name's own marker is often cut
              // off or a superscript ("ᴴᴰ").
              quality ? <QualityTag key="quality" quality={quality} /> : null,
              // Why it matched is quiet text: a badge on every card made status green the page's loudest
              // colour. Only the regional warning stays a badge, since it may be the wrong game.
              <span key="reason" data-testid="sports-reason">
                {t(REASON_KEYS[match.reason])}
              </span>,
              match.regional ? (
                <Badge key="regional" variant="warning" title={t(match.reason === 'team' ? 'regionalTeamHint' : 'regionalHint')} data-testid="sports-regional">
                  {t('regional')}
                </Badge>
              ) : null,
              ctx.multiSource ? (
                <span key="source" dir="auto" data-testid="sports-stream-source">
                  {match.sourceName}
                </span>
              ) : null,
              program && !slotRepeatsStart ? (
                <span key="time" className="tabular-nums" data-testid="sports-stream-slot">
                  {formatTimeRange(ms(program.start), ms(program.end), i18n.language)}
                </span>
              ) : null,
            ]}
          />
          {toggle}
        </span>
      </div>
      {button ? <div className="shrink-0">{button}</div> : null}
      {!button && first && watchesLater(game, ctx.now) ? (
        // Where nothing can be done yet (no recording here), the best row says when Watch comes: a clock
        // and the time, small enough to leave the channel's name its room; the sentence is its name.
        <WatchFrom time={formatClock(game.startMs - WATCH_BEFORE_MS, i18n.language)} />
      ) : null}
    </li>
  );
}

export function StreamList({
  game,
  title,
  streams,
  loading,
  ctx,
}: {
  game: Game;
  /** "Away at Home": the player's subtitle and the recording's title. */
  title: string;
  streams: readonly StreamMatch[] | undefined;
  loading: boolean;
  ctx: StreamContext;
}) {
  const { t } = useTranslation('sports');
  const [all, setAll] = useState(false);
  // Rows that can act now (Watch, Replay, Record) come first, in matchGame's order within each
  // group, so a final game's one archived copy never hides behind "Show all" under rows with no button.
  // A name a source lists twice ("CA: TSN 1 (BK)" three times) is one row, the first of them: the
  // player's failover and its Alternate sources menu reach the other copies.
  const list = useMemo(() => {
    const l = streams ?? [];
    const acts = (m: StreamMatch) => streamAction(game, m, ctx.now, ctx.canRecord, title) !== null;
    const seen = new Set<string>();
    return [...l.filter(acts), ...l.filter((m) => !acts(m))].filter((m) => {
      const name = `${m.sourceId}\n${m.channel.name.trim()}`;
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    });
  }, [streams, game, ctx.now, ctx.canRecord, title]);
  if (list.length === 0) {
    if (loading) {
      return (
        <p className="text-caption text-fg-subtle" data-testid="sports-streams-loading">
          {t('findingStreams')}
        </p>
      );
    }
    return (
      <p className="text-caption text-fg-subtle" data-testid="sports-no-streams">
        {t('noStreams')}
        {ctx.qualityFiltered ? <span data-testid="sports-quality-note"> {t('qualityNote')}</span> : null}
      </p>
    );
  }
  const shown = all ? list : list.slice(0, STREAMS_SHOWN);
  const more = list.length - STREAMS_SHOWN;
  const toggleLabel = all ? t('showFewer') : t('showAllStreams', { count: list.length });
  // The rest of the streams open from a small "+2" at the end of the best row's metadata, not a row
  // of its own under it: on most cards that row was a fifth of the card. It stays where it is once
  // open (a chevron up), so the same press closes the list again. Its hit area reaches 44 px on
  // touch screens without making the line taller. Only for a coarse pointer, as the kit's
  // TOUCH_TARGET: for a mouse it would reach up over the channel name, and hovering a long name
  // would light the chip and open its tooltip.
  const toggle =
    more > 0 ? (
      <Tooltip content={toggleLabel} describe={false}>
        <button
          type="button"
          aria-label={toggleLabel}
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
          className="relative inline-flex h-5 shrink-0 items-center gap-0.5 rounded-xs border border-edge bg-surface-2 px-1.5 text-caption font-medium text-fg tabular-nums pointer-coarse:after:absolute pointer-coarse:after:-inset-x-1 pointer-coarse:after:-inset-y-3 hover:bg-surface-3 active:bg-pressed"
          data-testid="sports-show-all"
        >
          {all ? null : <span aria-hidden>{`+${more}`}</span>}
          {all ? <ChevronUp aria-hidden size={12} /> : <ChevronDown aria-hidden size={12} />}
        </button>
      </Tooltip>
    ) : null;
  return (
    <ul className="flex flex-col divide-y divide-divider" aria-label={t('streamsFor', { title })} data-testid="sports-streams">
      {shown.map((m, i) => (
        <StreamRow
          key={`${m.sourceId}|${m.channel.ref.itemId}`}
          game={game}
          match={m}
          title={title}
          ctx={ctx}
          first={i === 0}
          {...(i === 0 ? { toggle } : {})}
        />
      ))}
    </ul>
  );
}
