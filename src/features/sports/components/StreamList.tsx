/**
 * The streams matched to one game (lib/match.ts): the first three, rows with an action ahead of
 * rows without, then "Show all". Each row names
 * the channel, why it matched (the guide, an event channel's name, or a network carrying the game)
 * and offers what fits the game's phase: Watch from 15 minutes before the start, Replay from the
 * channel's archive once it is over, Record before it starts. The player loads on the press.
 */

import { Circle, History, Play } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { sameRef, type EpgProgram, type ItemRef, type Settings } from '@/api/types';

import {
  Badge,
  Button,
  ChannelLogo,
  MetaLine,
  canCatchUp,
  displayChannelName,
  errorDescription,
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
/** Rows shown before "Show all". */
export const STREAMS_SHOWN = 3;

const REASON_KEYS: Record<MatchReason, string> = { guide: 'reasonGuide', event: 'reasonEvent', team: 'reasonTeam', network: 'reasonNetwork' };

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

function StreamRow({ game, match, title, ctx }: { game: Game; match: StreamMatch; title: string; ctx: StreamContext }) {
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
  return (
    <li className="flex min-w-0 items-center gap-3 py-2" data-testid="sports-stream" data-reason={match.reason}>
      <ChannelLogo src={match.channel.logoUrl} name={name} size={32} sourceId={match.sourceId} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span dir="auto" className="truncate text-body-sm font-medium text-fg">
          {name}
        </span>
        <MetaLine
          as="span"
          items={[
            <Badge key="reason" variant={match.reason === 'guide' ? 'success' : 'neutral'}>
              {t(REASON_KEYS[match.reason])}
            </Badge>,
            match.regional ? (
              <Badge key="regional" variant="warning" title={t('regionalHint')} data-testid="sports-regional">
                {t('regional')}
              </Badge>
            ) : null,
            ctx.multiSource ? (
              <span key="source" dir="auto" data-testid="sports-stream-source">
                {match.sourceName}
              </span>
            ) : null,
            program ? (
              <span key="time" className="tabular-nums">
                {formatTimeRange(ms(program.start), ms(program.end), i18n.language)}
              </span>
            ) : null,
          ]}
        />
      </div>
      {button ? <div className="shrink-0">{button}</div> : null}
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
  const list = useMemo(() => {
    const l = streams ?? [];
    const acts = (m: StreamMatch) => streamAction(game, m, ctx.now, ctx.canRecord, title) !== null;
    return [...l.filter(acts), ...l.filter((m) => !acts(m))];
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
  return (
    <div className="flex flex-col">
      <ul className="flex flex-col divide-y divide-divider" aria-label={t('streamsFor', { title })} data-testid="sports-streams">
        {shown.map((m) => (
          <StreamRow key={`${m.sourceId}|${m.channel.ref.itemId}`} game={game} match={m} title={title} ctx={ctx} />
        ))}
      </ul>
      {list.length > STREAMS_SHOWN ? (
        <Button variant="ghost" size="sm" className="self-start" aria-expanded={all} onClick={() => setAll((v) => !v)} data-testid="sports-show-all">
          {all ? t('showFewer') : t('showAllStreams', { count: list.length })}
        </Button>
      ) : null}
    </div>
  );
}
