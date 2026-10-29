/**
 * Smart reconnect (`settings.streamReconnect`) and the hand-off to failover.
 *
 * Every playback failure of the built-in engines and embedded mpv lands here as a store
 * transition to `status: 'error'`; a stream whose position stops moving while it should be
 * playing counts as a failure too (a stall: STALL_MS, or LIVE_STALL_MS for a live stream the
 * engine reports as buffering; a movie or episode only once its data stops arriving too).
 * Then, in order:
 *
 * 1. Errors that will not fix themselves (`errors.ts` classes auth, notFound, unsupported,
 *    connectionLimit, and server) switch a live channel to another copy at once
 *    (`failover.ts`). For auth and connectionLimit, which concern the whole account, copies on
 *    other sources go first (connectionLimit skips the failed source's copies).
 * 2. Anything else is retried quietly with backoff (1 s, 2 s, 4 s; at most three tries, all
 *    started within 20 s of the first failure). The player shows "Reconnecting" instead of the
 *    error. A VOD item comes back at the position it dropped at. Stalker links are resolved
 *    again first, since they expire. While the first retry waits, the account's connections
 *    are checked once (`account.status`); a full account ends the retries as connectionLimit.
 *    A stall counts as recovered only once the position moves again (embedded mpv reports
 *    `playing` for a frozen stream).
 * 3. When the retries give up, a live channel switches to another copy; a movie gets the VOD
 *    failover. Otherwise the error shows as before.
 *
 * A stream that never played gets one quick retry (STARTUP_RETRIES), not the ladder: a provider
 * that answers 503 or does not answer at all on the first try rarely does on the fourth, and
 * the user is waiting on a spinner. A live start that timed out tries another copy first. The
 * engines leave retries to this module (mpegts.js only restarts a stream that played), so the
 * "Reconnecting n of m" count is the real number of reloads. While a stream that never played
 * is still loading after SLOW_START_MS, the phase is `connecting` ("Still connecting", with
 * "Try another source" for a live channel that has copies elsewhere).
 *
 * The retry budget resets after HEALTHY_MS of good playback. Missing players and a lost
 * connection are left alone (the error UI retries by itself when the connection is back).
 */

import { create } from 'zustand';

import { itemKey, type PlayerSource, type RpcErrorCode } from '@/api/types';

import { fetchConnectionCounts, shouldCheckConnections } from './connectionLimit';
import type { EngineError } from './engines';
import { browserOnline, classifyStreamError, rpcErrorCode, type StreamErrorClass, type StreamErrorInput } from './errors';
import { bindLiveFailover, failoverLive, failoverVod, isChannelRef, isUntriedSwitch } from './failover';
import { useMediaStore } from './media';
import { traceTimeshift } from './timeshiftDiagnostics';
import {
  errorMessage,
  isPendingZap,
  knownSourceKind,
  MIN_RESUME_SECONDS,
  peekSettings,
  resolveSource,
  releaseFailedEmbeddedVod,
  retryResolve,
  usePlayerStore,
  type PlayerState,
  type PlayItemArgs,
} from './store';

/** Wait before each retry; its length is the retry budget. */
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000] as const;
/** Every retry starts within this long of the first failure. */
export const RECONNECT_WINDOW_MS = 20_000;
/** A retry that has not reached playback by then failed. */
export const ATTEMPT_TIMEOUT_MS = 8_000;
/** Slow catch-up providers get time to answer a retried timeshift request. */
export const CATCHUP_ATTEMPT_TIMEOUT_MS = 150_000;
export const CATCHUP_RECONNECT_WINDOW_MS = 180_000;
/** A playing stream whose position has not moved for this long has stalled. */
export const STALL_MS = 12_000;
/** A finite timeshift stream may pause between archive chunks without having failed. */
export const CATCHUP_STALL_MS = 60_000;
/**
 * A live stream whose engine says it is waiting for data (the element's `waiting`, mpv's
 * `paused-for-cache`) has stalled once its position stood this long: live has no buffer left
 * to come back to, and the frozen frame under a spinner is what the user watches meanwhile.
 * VOD uses STALL_MS; catch-up gets a longer pause for slow archive responses.
 */
export const LIVE_STALL_MS = 5_000;
/**
 * A live stream whose engine received bytes this recently (`bytesLoaded`, hls.js) is still
 * downloading its next segment: it gets STALL_MS instead of LIVE_STALL_MS. A rebuild would throw
 * the nearly finished segment away and start behind the edge again.
 */
export const LIVE_DATA_GRACE_MS = 2_000;
/** Playback this long without a failure restores the full retry budget. */
export const HEALTHY_MS = 30_000;
/** Retries for a stream that never played (the full ladder is for streams that played and dropped). */
export const STARTUP_RETRIES = 1;
/** A stream that never played and is still loading after this long says so ("Still connecting"). */
export const SLOW_START_MS = 4_000;
const TICK_MS = 1_000;

const STALL_MESSAGE = 'The stream stopped sending data';
const TIMEOUT_MESSAGE = 'Timed out waiting for the stream';

export type ReconnectPhase = 'idle' | 'connecting' | 'retrying' | 'switching';

export interface ReconnectState {
  phase: ReconnectPhase;
  /** 1-based retry number while `retrying`. */
  attempt: number;
  /** Retries this run allows: the ladder's length, or STARTUP_RETRIES for a stream that never played. */
  max: number;
}

/** What the player shows while it recovers ("Reconnecting 2 of 3", "Finding another source"). */
export const useReconnectStore = create<ReconnectState>()(() => ({ phase: 'idle', attempt: 0, max: RECONNECT_DELAYS_MS.length }));

export interface Recovery {
  /** Retrying the same stream may help. */
  retry: boolean;
  /** Switching a live channel to another copy may help. */
  canSwitch: boolean;
  /** Switch before any retry. */
  switchNow: boolean;
}

/** How each error class (unchanged, from `errors.ts`) is recovered. */
export function recoveryFor(cls: StreamErrorClass): Recovery {
  switch (cls) {
    case 'engineMissing':
    case 'offline':
      return { retry: false, canSwitch: false, switchNow: false };
    case 'auth':
    case 'notFound':
    case 'unsupported':
    // A full account only gets worse with retries; another source has its own account.
    case 'connectionLimit':
      return { retry: false, canSwitch: true, switchNow: true };
    case 'server':
      // Another copy first; with none, a 5xx is often a passing overload worth retrying.
      return { retry: true, canSwitch: true, switchNow: true };
    case 'timeout':
    case 'network':
    case 'media':
    case 'crashed':
    case 'generic':
      return { retry: true, canSwitch: true, switchNow: false };
    default: {
      const _exhaustive: never = cls;
      return _exhaustive;
    }
  }
}

interface FailureInfo {
  message?: string | undefined;
  code?: RpcErrorCode | undefined;
}

interface Session {
  /** The item it is for (stable across a resume patch or a refreshed Stalker link). */
  key: string;
  /** Retries since the last healthy playback. */
  attempts: number;
  /** When the current run of failures began (0: none). */
  windowStart: number;
  /** Gave up: the error shows; only a user Retry (or another item) starts over. */
  gaveUp: boolean;
  /** A failover lookup is running. */
  busy: boolean;
  /** VOD: where playback dropped. */
  resumeAt: number;
  /**
   * Recovering from a stall at this position (null: not a stall). Embedded mpv keeps the frozen
   * file loaded and reports `playing` regardless, so only a moved position counts as recovered.
   */
  stallPos: number | null;
  /** The account's connections were checked for this run of failures. */
  accountChecked: boolean;
  last?: FailureInfo;
}

let session: Session | null = null;
let engineKind: EngineError['kind'] | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let attemptTimer: ReturnType<typeof setTimeout> | null = null;
let healthyTimer: ReturnType<typeof setTimeout> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let lastPos = -1;
let lastMoveAt = 0;
/** Where the data held at the position ended on the last tick (`heldUntil`). */
let lastHeld = -1;
/** A live engine's `bytesLoaded` on the last tick (-1: it doesn't say), and when it last grew. */
let lastBytes = -1;
let lastBytesAt = 0;
/** `keyOf` the item that reached playback: only it gets the full retry ladder. */
let playedKey: string | null = null;
let slowTimer: ReturnType<typeof setTimeout> | null = null;
let slowFor: string | null = null;

function keyOf(src: PlayerSource): string {
  return src.ref ? `${itemKey(src.ref)}|${src.episodeId ?? ''}` : `url|${src.url}`;
}

function newSession(key: string): Session {
  return { key, attempts: 0, windowStart: 0, gaveUp: false, busy: false, resumeAt: 0, stallPos: null, accountChecked: false };
}

function setPhase(phase: ReconnectPhase, attempt = 0, max?: number): void {
  const cur = useReconnectStore.getState();
  const nextMax = max ?? cur.max;
  if (cur.phase !== phase || cur.attempt !== attempt || cur.max !== nextMax) useReconnectStore.setState({ phase, attempt, max: nextMax });
}

/** Retries this session allows: the ladder once the item played, else one quick try. */
function budgetOf(ses: Session): number {
  return playedKey === ses.key ? RECONNECT_DELAYS_MS.length : STARTUP_RETRIES;
}

/** The wait before the session's next retry, or undefined when its budget is spent. */
function nextDelay(ses: Session): number | undefined {
  return ses.attempts < budgetOf(ses) ? RECONNECT_DELAYS_MS[ses.attempts] : undefined;
}

function clear(t: ReturnType<typeof setTimeout> | null): null {
  if (t) clearTimeout(t);
  return null;
}

function endSession(): void {
  retryTimer = clear(retryTimer);
  attemptTimer = clear(attemptTimer);
  healthyTimer = clear(healthyTimer);
  session = null;
  engineKind = null;
  setPhase('idle');
}

/** The built-in player's engine reports the coarse kind of its fatal error before the status. */
export function noteEngineError(kind: EngineError['kind']): void {
  engineKind = kind;
}

/** Keep the player in `loading` (the reconnect notice, not the error) while recovery runs. */
function hold(): void {
  if (useMediaStore.getState().errorCode) useMediaStore.setState({ errorCode: undefined });
  const s = usePlayerStore.getState();
  if (s.status !== 'loading' || s.error !== undefined) usePlayerStore.setState({ status: 'loading', error: undefined });
}

function sameItem(ses: Session): PlayerSource | undefined {
  const src = usePlayerStore.getState().source;
  return session === ses && src && keyOf(src) === ses.key ? src : undefined;
}

function fail(ses: Session, src: PlayerSource, cls: StreamErrorClass, info: FailureInfo, position: number): void {
  retryTimer = clear(retryTimer);
  attemptTimer = clear(attemptTimer);
  healthyTimer = clear(healthyTimer);
  engineKind = null;
  ses.last = info;
  if (!src.isLive && position > ses.resumeAt) ses.resumeAt = position;

  const settings = peekSettings();
  const reconnectOn = settings?.streamReconnect ?? true;
  const failoverOn = (settings?.liveFailover ?? true) && src.isLive && isChannelRef(src.ref);
  const r = recoveryFor(cls);
  const now = Date.now();
  if (!ses.windowStart) ses.windowStart = now;
  const delay = nextDelay(ses);
  const windowMs = src.catchupProgramStart ? CATCHUP_RECONNECT_WINDOW_MS : RECONNECT_WINDOW_MS;
  const canRetry = reconnectOn && r.retry && delay !== undefined && now - ses.windowStart + delay <= windowMs;
  traceTimeshift(src, 'reconnect decision', {
    class: cls, message: info.message, code: info.code, attempt: ses.attempts,
    canRetry, delay, position, playedBefore: playedKey === ses.key,
  });
  // A copy failover just switched to that fails before it ever played: the next copy, no retries.
  const freshSwitch = isUntriedSwitch(src);
  // A live start that timed out: a hung provider stays hung, so another copy goes first.
  const switchFirst = r.switchNow || (cls === 'timeout' && playedKey !== ses.key);

  if (failoverOn && r.canSwitch && (switchFirst || freshSwitch || !canRetry)) {
    void switchOver(ses, src, canRetry && !freshSwitch, cls);
    return;
  }
  if (canRetry && delay !== undefined) {
    scheduleRetry(ses, src, delay);
    return;
  }
  giveUp(ses, src);
}

async function switchOver(ses: Session, src: PlayerSource, thenRetry: boolean, cls: StreamErrorClass): Promise<void> {
  ses.busy = true;
  hold();
  setPhase('switching');
  const switched = await failoverLive(src, cls).catch(() => false);
  ses.busy = false;
  // Switched (the new copy has its own session), or the user moved on.
  if (switched || !sameItem(ses)) return;
  const delay = nextDelay(ses);
  if (thenRetry && delay !== undefined) scheduleRetry(ses, src, delay);
  else giveUp(ses, src);
}

function scheduleRetry(ses: Session, src: PlayerSource, delay: number): void {
  ses.attempts++;
  hold();
  setPhase('retrying', ses.attempts, budgetOf(ses));
  retryTimer = setTimeout(() => {
    retryTimer = null;
    attempt(ses);
  }, delay);
}

function argsOf(src: PlayerSource & { ref: NonNullable<PlayerSource['ref']> }): PlayItemArgs {
  const args: PlayItemArgs = { ref: src.ref, title: src.title, isLive: src.isLive, isRadio: src.isRadio, sourceKind: 'stalker' };
  if (src.episodeId) args.episodeId = src.episodeId;
  if (src.subtitle) args.subtitle = src.subtitle;
  if (src.posterUrl) args.posterUrl = src.posterUrl;
  return args;
}

/** Still waiting for this session's stream to come back (a stall waits for the position to move). */
function recovering(ses: Session): boolean {
  return ses.stallPos !== null || usePlayerStore.getState().status === 'loading';
}

function attempt(ses: Session): void {
  const src = sameItem(ses);
  if (!src || !recovering(ses)) return;
  traceTimeshift(src, 'reconnect attempt', { attempt: ses.attempts, resumeAt: ses.resumeAt });
  attemptTimer = setTimeout(() => {
    attemptTimer = null;
    const cur = sameItem(ses);
    const s = usePlayerStore.getState();
    if (!cur || !recovering(ses)) return;
    fail(ses, cur, 'timeout', { message: TIMEOUT_MESSAGE, code: 'timeout' }, s.positionSeconds);
  }, src.catchupProgramStart ? CATCHUP_ATTEMPT_TIMEOUT_MS : ATTEMPT_TIMEOUT_MS);

  // The stream URL lookup itself failed: look it up again.
  if (!src.url) {
    if (!retryResolve()) giveUp(ses, src);
    return;
  }
  const resumed = (s: PlayerSource): PlayerSource =>
    !s.isLive && ses.resumeAt > MIN_RESUME_SECONDS ? { ...s, resumeSeconds: ses.resumeAt } : s;
  const ref = src.ref;
  if (ref && knownSourceKind(ref.sourceId) === 'stalker') {
    // Stalker links are short-lived: resolve a fresh one (a new url reloads the media by itself).
    resolveSource(argsOf({ ...src, ref })).then(
      (fresh) => {
        if (sameItem(ses) !== src) return;
        usePlayerStore.setState({ source: resumed({ ...src, ...fresh }) });
        if (fresh.url === src.url) useMediaStore.getState().commands?.retry();
      },
      (err: unknown) => {
        if (sameItem(ses) !== src) return;
        const code = rpcErrorCode(err);
        const message = errorMessage(err);
        fail(ses, src, classifyStreamError({ message, code, online: browserOnline() }), { message, code }, 0);
      },
    );
    return;
  }
  const next = resumed(src);
  if (next !== src) usePlayerStore.setState({ source: next, positionSeconds: ses.resumeAt });
  useMediaStore.getState().commands?.retry();
}

function showError(ses: Session): void {
  useMediaStore.setState({ errorCode: ses.last?.code });
  usePlayerStore.setState({ status: 'error', error: ses.last?.message ?? TIMEOUT_MESSAGE });
}

function giveUp(ses: Session, src: PlayerSource): void {
  traceTimeshift(src, 'reconnect gave up', { attempt: ses.attempts, message: ses.last?.message });
  ses.gaveUp = true;
  retryTimer = clear(retryTimer);
  attemptTimer = clear(attemptTimer);
  setPhase('idle');
  if (usePlayerStore.getState().status !== 'error' && sameItem(ses)) showError(ses);
  if (sameItem(ses)) releaseFailedEmbeddedVod();
  if (!src.isLive) failoverVod(src);
}

/**
 * A full account often fails as a bare 5xx, a timeout or a dropped connection. While the first
 * retry waits, ask the account (once per run of failures, as the error UI would); when it is
 * full, stop retrying it and treat the failure as `connectionLimit` (another source, or the
 * error). Stalls are not checked: the stalled stream still holds its own connection.
 */
function checkAccount(ses: Session, src: PlayerSource, input: StreamErrorInput): void {
  const sourceId = src.ref?.sourceId;
  if (ses.accountChecked || !shouldCheckConnections(input, sourceId)) return;
  ses.accountChecked = true;
  void fetchConnectionCounts(sourceId).then((connections) => {
    if (classifyStreamError({ ...input, connections }) !== 'connectionLimit') return;
    const cur = sameItem(ses);
    if (!cur || ses.gaveUp || ses.busy || (!retryTimer && !attemptTimer)) return;
    fail(ses, cur, 'connectionLimit', ses.last ?? {}, usePlayerStore.getState().positionSeconds);
  });
}

function onPlaying(ses: Session, position: number): void {
  if (ses.stallPos !== null) {
    // Embedded mpv says `playing` while the stalled file is still loaded: not recovered yet.
    if (position === ses.stallPos) return;
    ses.stallPos = null;
  }
  if (attemptTimer) traceTimeshift(sameItem(ses), 'reconnect playback resumed', { position, attempt: ses.attempts });
  attemptTimer = clear(attemptTimer);
  setPhase('idle');
  // This run of failures is over; the retry count lasts until playback has held for a while.
  ses.windowStart = 0;
  if (healthyTimer) return;
  healthyTimer = setTimeout(() => {
    healthyTimer = null;
    if (session === ses && usePlayerStore.getState().status === 'playing') {
      ses.attempts = 0;
      ses.accountChecked = false;
    }
  }, HEALTHY_MS);
}

/**
 * Where the data held at `position` ends, in seconds: the element's buffered range around it, or
 * the end of embedded mpv's cache. -1 when nothing is held.
 */
function heldUntil(position: number): number {
  const m = useMediaStore.getState();
  let end = m.mpv?.seekable?.end ?? -1;
  for (const r of m.buffered) {
    if (r.start <= position + 1 && r.end >= position - 1 && r.end > end) end = r.end;
  }
  return end;
}

/** A live stream's engine bytes (`MediaCommands.bytesLoaded`); -1 for VOD or an engine that doesn't say. */
function liveBytes(isLive: boolean): number {
  if (!isLive) return -1;
  return useMediaStore.getState().commands?.bytesLoaded?.() ?? -1;
}

/**
 * Stall detector: a `playing` stream whose position stands still. A movie or episode whose data
 * is still coming in is waiting on a slow server, not stalled: a reload would throw away what
 * arrived and ask the server again, so it counts as stalled only once the data stops too.
 */
function tick(): void {
  const s = usePlayerStore.getState();
  const now = Date.now();
  if (s.status !== 'playing' || !s.source || s.mode === 'external') {
    lastMoveAt = now;
    return;
  }
  const held = s.source.isLive ? -1 : heldUntil(s.positionSeconds);
  const arriving = held > lastHeld;
  lastHeld = held;
  const bytes = liveBytes(s.source.isLive);
  if (bytes > lastBytes && lastBytes >= 0) lastBytesAt = now;
  lastBytes = bytes;
  if (s.positionSeconds !== lastPos) {
    lastPos = s.positionSeconds;
    lastMoveAt = now;
    return;
  }
  if (arriving) {
    lastMoveAt = now;
    return;
  }
  // A slow archive seek may scan tens of megabytes before it can append a frame. The loader's
  // network speed confirms that it is making progress even while the media buffer is empty.
  const archiveNetworkAt = useMediaStore.getState().archiveNetworkAt;
  if (s.source.catchupProgramStart && archiveNetworkAt && now - archiveNetworkAt < 3_000) {
    lastMoveAt = now;
    return;
  }
  const downloading = now - lastBytesAt < LIVE_DATA_GRACE_MS;
  const stallAfter = s.source.catchupProgramStart ? CATCHUP_STALL_MS : s.source.isLive && useMediaStore.getState().waiting && !downloading ? LIVE_STALL_MS : STALL_MS;
  const inactiveMs = now - lastMoveAt;
  if (inactiveMs < stallAfter || !(peekSettings()?.streamReconnect ?? true)) return;
  lastMoveAt = now;
  const key = keyOf(s.source);
  if (!session || session.key !== key) session = newSession(key);
  // A recovery under way (a stalled mpv stream keeps saying `playing`) has its own timeout.
  if (session.busy || session.gaveUp || retryTimer || attemptTimer) return;
  session.stallPos = s.positionSeconds;
  traceTimeshift(s.source, 'reconnect stalled position', {
    position: s.positionSeconds, heldUntil: held, waiting: useMediaStore.getState().waiting,
    millisecondsWithoutProgress: inactiveMs,
  });
  fail(session, s.source, 'timeout', { message: STALL_MESSAGE, code: 'timeout' }, s.positionSeconds);
}

function syncTick(s: PlayerState): void {
  const want = s.status === 'playing' && !!s.source && s.mode !== 'external';
  if (want && !tickTimer) {
    lastPos = s.positionSeconds;
    lastMoveAt = Date.now();
    lastHeld = s.source?.isLive ? -1 : heldUntil(s.positionSeconds);
    lastBytes = liveBytes(!!s.source?.isLive);
    lastBytesAt = 0;
    tickTimer = setInterval(tick, TICK_MS);
  } else if (!want && tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

/**
 * A stream that never played, still loading after SLOW_START_MS: phase `connecting`, so the
 * player can say so and offer another copy. Recovery steps (retrying, switching) keep theirs.
 */
function syncSlowStart(s: PlayerState, key: string | null): void {
  const want = !!key && s.status === 'loading' && !!s.source?.url && s.mode !== 'external' && playedKey !== key;
  if (!want) {
    slowTimer = clear(slowTimer);
    slowFor = null;
    if (useReconnectStore.getState().phase === 'connecting') setPhase('idle');
    return;
  }
  // Already counting (or already said so) for this item.
  if (slowFor === key) return;
  slowTimer = clear(slowTimer);
  slowFor = key;
  slowTimer = setTimeout(() => {
    slowTimer = null;
    const cur = usePlayerStore.getState();
    if (!cur.source || keyOf(cur.source) !== key || cur.status !== 'loading' || playedKey === key) return;
    if (useReconnectStore.getState().phase === 'idle') setPhase('connecting');
  }, SLOW_START_MS);
}

/**
 * "Try another source" while a live channel is still connecting: switch to another copy now
 * instead of waiting for the start to time out. With none that plays, it keeps waiting.
 */
export async function tryAnotherSource(): Promise<boolean> {
  const src = usePlayerStore.getState().source;
  if (!src?.url || !src.isLive || !isChannelRef(src.ref)) return false;
  const key = keyOf(src);
  if (!session || session.key !== key) session = newSession(key);
  const ses = session;
  if (ses.busy) return false;
  ses.busy = true;
  setPhase('switching');
  const switched = await failoverLive(src, 'timeout').catch(() => false);
  ses.busy = false;
  if (switched || !sameItem(ses)) return switched;
  if (useReconnectStore.getState().phase === 'switching') setPhase(usePlayerStore.getState().status === 'loading' ? 'connecting' : 'idle');
  return false;
}

/** `onPlayer` went all the way through since the last reset: what it keeps follows the store. */
let followed = false;

function onPlayer(s: PlayerState, prev: PlayerState): void {
  // Playback progress moves only the position, several times a second. The item, its status and
  // the mode decide everything below; the position matters only to a stall that has to move again
  // to count as recovered (`onPlaying`). Keys are not built again for it (P2-PLAYER-6).
  if (followed && s.source === prev.source && s.status === prev.status && s.mode === prev.mode && s.error === prev.error) {
    if (s.status === 'playing' && session && s.source && !isPendingZap(s.source) && s.mode !== 'external') onPlaying(session, s.positionSeconds);
    return;
  }
  followed = true;
  // A zap's placeholder (the last picture under the next channel's name) has no stream of its own to recover.
  const src = isPendingZap(s.source) ? undefined : s.source;
  const key = src ? keyOf(src) : null;
  const prevKey = prev.source ? keyOf(prev.source) : null;
  if (session && session.key !== key) endSession();
  if (playedKey !== null && playedKey !== key) playedKey = null;
  if (s.status === 'playing' && key && src?.url) playedKey = key;
  syncTick(s);
  syncSlowStart(s, key);
  if (!src || !key || s.mode === 'external') return;

  if (session?.gaveUp && s.status !== 'error') {
    // Embedded mpv still reports the stalled file as playing: the error stays up.
    if (session.stallPos !== null && s.status === 'playing' && s.positionSeconds === session.stallPos) {
      showError(session);
      return;
    }
    // A user Retry (or the error UI's own) after giving up starts a fresh budget.
    session = newSession(key);
  }

  if (s.status === 'error' && (prev.status !== 'error' || prevKey !== key)) {
    const ses = session ?? (session = newSession(key));
    if (ses.gaveUp) return;
    // Already recovering (a late error from the failed load): keep the notice up.
    if (retryTimer || ses.busy) {
      hold();
      return;
    }
    const code = useMediaStore.getState().errorCode;
    const input: StreamErrorInput = { message: s.error, kind: engineKind, code, online: browserOnline() };
    fail(ses, src, classifyStreamError(input), { message: s.error, code }, prev.positionSeconds || s.positionSeconds);
    if (retryTimer) checkAccount(ses, src, input);
    return;
  }
  if (s.status === 'playing' && session) onPlaying(session, s.positionSeconds);
}

/** Start following the player (once, from the dock). Returns the unbind. */
export function bindRecovery(): () => void {
  const unsub = usePlayerStore.subscribe(onPlayer);
  const unLive = bindLiveFailover();
  return () => {
    unsub();
    unLive();
    __resetReconnect();
  };
}

/** Testing only. */
export function __resetReconnect(): void {
  endSession();
  followed = false;
  playedKey = null;
  slowTimer = clear(slowTimer);
  slowFor = null;
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  lastPos = -1;
  lastMoveAt = 0;
  lastHeld = -1;
  lastBytes = -1;
  lastBytesAt = 0;
}
