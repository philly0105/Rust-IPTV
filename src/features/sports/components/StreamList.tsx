/**
 * The streams matched to one game (lib/match.ts): the best one, rows with an action ahead of rows
 * without, and a small "+2" at the end of its metadata that shows the rest, so a card stays one
 * stream tall. Each row names the channel, the picture quality its name gives, why it matched (the
 * guide, an event channel's name, a team's own channel, or a network carrying the game) and offers
 * what fits the game's phase: Watch from 15 minutes before the start, Replay from the channel's
 * archive once it is over, Record before it starts. Before Watch comes, where nothing can be recorded, a
 * row offers Remind me (a guide reminder, as the guide's own) or, with reminders off, says when Watch
 * comes. The player loads on the press.
 */

import { Bell, BellOff, ChevronDown, ChevronUp, Circle, Clock, History, Play, TriangleAlert, Volume2 } from 'lucide-react';
import { Fragment, useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { sameRef, type ChannelQuality, type EpgProgram, type ItemRef, type PlayerSource, type Reminder, type Settings } from '@/api/types';
// Straight from its module (sports/deps.ts re-exports only ChannelLogo from it), the same chunk.
import { ChannelName } from '@/features/live/components/ChannelLogo';
import { channelQuality } from '@/lib/channelQuality';

import {
  Badge,
  Button,
  ChannelLogo,
  cn,
  MetaLine,
  Tooltip,
  canCatchUp,
  displayChannelName,
  errorDescription,
  formatClock,
  formatTimeRange,
  PHONE_QUERY,
  loadPlayback,
  loadPlayerStage,
  loadPlayerStore,
  markFor,
  ms,
  useDisplayPrefs,
  useRecordingCapabilities,
  useRemindersEnabled,
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
    <span className="rounded-xs border border-edge px-1 text-caption leading-4 font-semibold text-fg-muted tabular-nums" data-testid="sports-stream-quality">
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
  /** Guide reminders are on (Settings, Recording): an upcoming game's rows offer Remind me. */
  remindersOn: boolean;
  /** Live TV's quality filter or the page's "1080p+" is on, so a missing stream may be its doing. */
  qualityFiltered: boolean;
  /** Part of the channel index failed: a game with no stream may have one that wasn't looked through. */
  streamsFailed: boolean;
  /** What the player plays, once a Watch or Replay on this page has loaded it; the row it came from says so. */
  playing: PlayerSource | undefined;
  /** A recording is waiting or running for this programme on this channel. */
  isRecording(ref: ItemRef, program: EpgProgram): boolean;
  /** The pending reminder for this programme on this channel. */
  reminderFor(ref: ItemRef, program: EpgProgram): Reminder | undefined;
  watch(match: StreamMatch, title: string, name: string): Promise<void>;
  replay(match: StreamMatch, program: EpgProgram, name: string): Promise<void>;
  record(match: StreamMatch, program: EpgProgram, name: string): Promise<boolean>;
  /** Sets a reminder for the programme, or removes `existing`. */
  remind(match: StreamMatch, program: EpgProgram, name: string, existing: Reminder | undefined): Promise<void>;
}

const selectMinQuality = (s: Settings) => s.liveMinQuality ?? null;

type PlayerStore = Awaited<ReturnType<typeof loadPlayerStore>>['usePlayerStore'];
const noSubscription = () => () => {};

/**
 * The player's source, read from its store once a press here has loaded it: the page never loads the
 * player itself (deps.ts), so until then nothing plays that this page started.
 */
function usePlayingSource(store: PlayerStore | null): PlayerSource | undefined {
  return useSyncExternalStore(store ? store.subscribe : noSubscription, () => store?.getState().source);
}

export function useStreamContext(now: number, sourceCount: number, hdOnly = false, streamsFailed = false): StreamContext {
  const { t } = useTranslation('sports');
  const { toast } = useToast();
  const prefs = useDisplayPrefs();
  const canRecord = useRecordingCapabilities().data?.supported === true;
  const remindersOn = useRemindersEnabled();
  const index = useScheduleIndex();
  const actions = useScheduleActions();
  const qualityFiltered = useSettingsValue(selectMinQuality).data != null || hdOnly;
  const navigate = useNavigate();
  const [store, setStore] = useState<PlayerStore | null>(null);
  const playing = usePlayingSource(store);

  const watch = useCallback(
    async (m: StreamMatch, title: string, name: string) => {
      try {
        const [{ playChannel }, { usePlayerStore }] = await Promise.all([loadPlayback(), loadPlayerStore()]);
        setStore(() => usePlayerStore);
        await playChannel(m.channel, m.sourceKind, title, name);
        // Channel up and down then walk the channel's group, not the last Live category. Only when this
        // channel is the one playing: a refused PIN leaves what played alone.
        if (sameRef(usePlayerStore.getState().source?.ref, m.channel.ref)) {
          const zapContext = { sourceId: m.sourceId, ...(m.channel.categoryId ? { categoryId: m.channel.categoryId } : {}) };
          usePlayerStore.setState({ zapContext });
          // On a phone the mini player is a thumbnail over the tab bar, and nobody watches a game in
          // that: Watch goes on to the big picture, where the bar's Expand would take it.
          if (window.matchMedia?.(PHONE_QUERY).matches) {
            const { expandPath } = await loadPlayerStage();
            const path = expandPath(usePlayerStore.getState().source, zapContext);
            if (path) void navigate(path);
          }
        }
      } catch (err) {
        toast({ variant: 'error', title: t('playFailed', { name }), description: errorDescription(err) });
      }
    },
    [t, toast, navigate],
  );

  const replay = useCallback(
    async (m: StreamMatch, program: EpgProgram, name: string) => {
      try {
        const [{ playCatchup }, { usePlayerStore }] = await Promise.all([loadPlayback(), loadPlayerStore()]);
        setStore(() => usePlayerStore);
        await playCatchup(m.channel, m.sourceKind, program, Date.now(), name);
      } catch (err) {
        toast({ variant: 'error', title: t('replayFailed'), description: errorDescription(err) });
      }
    },
    [t, toast],
  );

  const { record: schedule, toggleReminder } = actions;
  const record = useCallback(
    (m: StreamMatch, program: EpgProgram, name: string) =>
      schedule({ ref: m.channel.ref, channelName: name, program: { title: program.title, start: program.start, end: program.end } }),
    [schedule],
  );

  const remind = useCallback(
    (m: StreamMatch, program: EpgProgram, name: string, existing: Reminder | undefined) =>
      toggleReminder({ ref: m.channel.ref, channelName: name, program: { title: program.title, start: program.start, end: program.end } }, existing),
    [toggleReminder],
  );

  const isRecording = useCallback((ref: ItemRef, program: EpgProgram) => !!markFor(index, ref, program).recording, [index]);
  const reminderFor = useCallback((ref: ItemRef, program: EpgProgram) => markFor(index, ref, program).reminder, [index]);

  return useMemo(
    () => ({
      now,
      strip: prefs.stripCountryPrefix,
      multiSource: sourceCount > 1,
      canRecord,
      remindersOn,
      qualityFiltered,
      streamsFailed,
      playing,
      isRecording,
      reminderFor,
      watch,
      replay,
      record,
      remind,
    }),
    [now, prefs.stripCountryPrefix, sourceCount, canRecord, remindersOn, qualityFiltered, streamsFailed, playing, isRecording, reminderFor, watch, replay, record, remind],
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
  // A clock, not a play mark: nothing here can be pressed yet, and a play mark beside a time read as a
  // button. The words are on screen, not only the time: a bare clock left people pressing the row.
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-caption text-fg-muted tabular-nums" data-testid="sports-watch-from">
      <Clock aria-hidden size={12} />
      {t('watchFrom', { time })}
    </span>
  );
}

function StreamRow({
  game,
  match,
  title,
  ctx,
  first,
  best,
  toggle,
}: {
  game: Game;
  match: StreamMatch;
  title: string;
  ctx: StreamContext;
  first: boolean;
  /** The first of several rows: the stream the order puts first says it is the best one. */
  best: boolean;
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

  // The row whose stream the player has on: its action gives way to a quiet "Playing", in the accent
  // as Live TV marks its playing row, so with several games on the user sees which one this is.
  const playing =
    ctx.playing !== undefined &&
    sameRef(ctx.playing.ref, match.channel.ref) &&
    ((action?.kind === 'watch' && ctx.playing.isLive) || (action?.kind === 'replay' && !ctx.playing.isLive));

  let button = null;
  if (playing) {
    button = (
      <span className="inline-flex h-8 items-center gap-1.5 px-2 text-body-sm font-medium text-accent" data-testid="sports-playing">
        <Volume2 aria-hidden size={16} />
        {t('playing')}
      </span>
    );
  } else if (action?.kind === 'watch') {
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

  // Before Watch comes, with nothing to record: a guide reminder for the game's programme, which fires
  // with "Watch now" as the guide's own do. A press again takes it away.
  const later = action === null && watchesLater(game, ctx.now);
  const watchTime = later ? formatClock(game.startMs - WATCH_BEFORE_MS, i18n.language) : '';
  const remindProgram = later && ctx.remindersOn ? gameProgram(game, match, title) : null;
  const reminder = remindProgram ? ctx.reminderFor(match.channel.ref, remindProgram) : undefined;
  if (!button && remindProgram && (reminder || ms(remindProgram.start) > ctx.now)) {
    button = (
      <Tooltip content={t('watchFrom', { time: watchTime })}>
        <Button
          size="sm"
          variant="secondary"
          icon={reminder ? <BellOff size={16} aria-hidden /> : <Bell size={16} aria-hidden />}
          aria-pressed={!!reminder}
          loading={busy}
          aria-label={reminder ? undefined : t('remindLabel', { title, name })}
          onClick={() => run(() => ctx.remind(match, remindProgram, name, reminder))}
          data-testid="sports-remind"
        >
          {reminder ? t('reminderOn') : t('remindMe')}
        </Button>
      </Tooltip>
    );
  }

  const program = match.program;
  const quality = channelQuality(match.channel.name);
  // The guide slot's times say what the card doesn't: when a live game's broadcast runs, which slot a
  // replay plays, or that coverage starts before the game. A slot that starts with an upcoming game
  // only repeats the start time above, the third time on the card with the Watch clock, so it goes.
  const slotRepeatsStart =
    program !== null && game.phase === 'scheduled' && game.timeValid && !game.timeNote && Math.abs(ms(program.start) - game.startMs) < MINUTE;
  const slot = program && !slotRepeatsStart ? formatTimeRange(ms(program.start), ms(program.end), i18n.language) : null;
  const slotStart = program && !slotRepeatsStart ? formatClock(ms(program.start), i18n.language) : null;
  const reason = t(REASON_KEYS[match.reason]);
  // A guide slot already says the match came from the guide, so it stands in for "In guide": the
  // reason stays its tooltip and is read before it. So does the regional warning, whose tooltip says
  // why the channel matched: on the line, the reason is what pushed the slot or the warning to "N.".
  const slotIsReason = slot !== null && match.reason === 'guide';
  const reasonHidden = slotIsReason || match.regional;
  return (
    <li className="flex min-w-0 items-center gap-3 py-2" aria-current={playing ? 'true' : undefined} data-testid="sports-stream" data-reason={match.reason}>
      <ChannelLogo src={match.channel.logoUrl} name={name} size={32} sourceId={match.sourceId} />
      {/* A container, so the line below fits what it says to the room the row's action leaves. */}
      <div className="@container flex min-w-0 flex-1 flex-col gap-1">
        {/* Named as Live TV's list names it: the country tag after the name, quiet. */}
        <ChannelName name={match.channel.name} strip={ctx.strip} className="truncate text-body-sm font-medium text-fg" testId="sports-stream-name" />
        {/* One line: the quality, the warning and the slot's time keep their width, and only the
            source's name (or the reason) truncates; the toggle keeps its place at the end, so the row
            never grows a line that starts with a dot. Where the line is short (a phone, a card with an
            action), the slot shows its start only, its range in the tooltip, and "Best" goes after a
            quality tag: the order and the "+2" beside it already say this one is first. */}
        <span className="flex min-w-0 items-center gap-1.5">
          <MetaLine
            as="span"
            className={cn(
              'flex-nowrap [&>span]:shrink-0 [&>span:has([data-meta-shrink])]:shrink',
              quality && '@max-[15rem]:[&>span:has([data-testid=sports-best])]:hidden',
            )}
            items={[
              // First, so the rows' qualities line up down the list; the name's own marker is often cut
              // off or a superscript ("ᴴᴰ").
              quality ? <QualityTag key="quality" quality={quality} /> : null,
              // After the quality, which stays lined up down the list. Quiet words, not another badge: the
              // order already puts the surest, sharpest stream first.
              best ? (
                <span key="best" className="font-medium text-fg-muted" title={t('bestHint')} data-testid="sports-best">
                  {t('best')}
                </span>
              ) : null,
              // The regional warning, since it may be the wrong game: warning-toned text, not a filled
              // badge, as on an NFL Sunday nearly every card carries it. Before the reason, so where the
              // line runs short the warning is never what truncates.
              match.regional ? (
                <Fragment key="regional">
                  <span
                    className="flex min-w-0 items-center gap-1 text-warning"
                    title={t(match.reason === 'team' ? 'regionalTeamHint' : 'regionalHint')}
                    data-testid="sports-regional"
                  >
                    <TriangleAlert aria-hidden size={12} className="shrink-0" />
                    <span className="truncate">{t('regional')}</span>
                  </span>
                  {slotIsReason ? null : <span className="sr-only">{`, ${reason}`}</span>}
                </Fragment>
              ) : null,
              // Why it matched is quiet text: a badge on every card made status green the page's loudest colour.
              reasonHidden ? null : (
                <span key="reason" className="block truncate" data-meta-shrink="" data-testid="sports-reason">
                  {reason}
                </span>
              ),
              ctx.multiSource ? (
                <span key="source" dir="auto" className="block truncate" data-meta-shrink="" data-testid="sports-stream-source">
                  {match.sourceName}
                </span>
              ) : null,
              slot ? (
                <span
                  key="time"
                  className="block truncate tabular-nums"
                  title={slotIsReason ? `${reason}: ${slot}` : slot}
                  data-meta-shrink=""
                  data-testid="sports-stream-slot"
                >
                  {slotIsReason ? <span className="sr-only">{`${reason}, `}</span> : null}
                  <span className="@max-[15rem]:hidden">{slot}</span>
                  <span className="@min-[15rem]:hidden">{slotStart}</span>
                </span>
              ) : null,
            ]}
          />
          {toggle}
        </span>
      </div>
      {button ? <div className="shrink-0">{button}</div> : null}
      {!button && first && later ? (
        // Where nothing can be done yet (no recording, reminders off), the best row says when Watch comes.
        <WatchFrom time={watchTime} />
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
    if (ctx.streamsFailed) {
      return (
        <p className="text-caption text-fg-subtle" data-testid="sports-streams-failed">
          {t('streamsFailed')}
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
  // touch screens and 24 px for a mouse without making the line taller. Only 24 for a mouse: more
  // would reach up over the channel name, and hovering a long name would light the chip.
  const toggle =
    more > 0 ? (
      <Tooltip content={toggleLabel} describe={false}>
        <button
          type="button"
          aria-label={toggleLabel}
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
          className="relative inline-flex h-5 shrink-0 items-center gap-0.5 rounded-xs border border-edge bg-surface-2 px-1.5 text-caption font-medium text-fg tabular-nums after:absolute after:inset-x-0 after:-inset-y-0.5 pointer-coarse:after:-inset-x-1 pointer-coarse:after:-inset-y-3 hover:bg-surface-3 active:bg-pressed"
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
          best={i === 0 && list.length > 1}
          {...(i === 0 ? { toggle } : {})}
        />
      ))}
    </ul>
  );
}
