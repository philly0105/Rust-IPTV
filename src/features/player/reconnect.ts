/**
 * Smart reconnect (`settings.streamReconnect`) and the hand-off to failover.
 *
 * Every playback failure of the built-in engines and embedded mpv lands here as a store
 * transition to `status: 'error'`; a stream whose position stops moving while it should be
 * playing counts as a failure too (a stall). Then, in order:
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
import {
  errorMessage,
  knownSourceKind,
  MIN_RESUME_SECONDS,
  peekSettings,
  resolveSource,
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
/** A playing stream whose position has not moved for this long has stalled. */
export const STALL_MS = 12_000;
/** Playback this long without a failure restores the full retry budget. */
export const HEALTHY_MS = 30_000;
const TICK_MS = 1_000;

const STALL_MESSAGE = 'The stream stopped sending data';
const TIMEOUT_MESSAGE = 'Timed out waiting for the stream';

export type ReconnectPhase = 'idle' | 'retrying' | 'switching';

export interface ReconnectState {
  phase: ReconnectPhase;
  /** 1-based retry number while `retrying`. */
  attempt: number;
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

function keyOf(src: PlayerSource): string {
  return src.ref ? `${itemKey(src.ref)}|${src.episodeId ?? ''}` : `url|${src.url}`;
}

function newSession(key: string): Session {
  return { key, attempts: 0, windowStart: 0, gaveUp: false, busy: false, resumeAt: 0, stallPos: null, accountChecked: false };
}

function setPhase(phase: ReconnectPhase, attempt = 0): void {
  const cur = useReconnectStore.getState();
  if (cur.phase !== phase || cur.attempt !== attempt) useReconnectStore.setState({ phase, attempt });
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
  const delay = RECONNECT_DELAYS_MS[ses.attempts];
  const canRetry = reconnectOn && r.retry && delay !== undefined && now - ses.windowStart + delay <= RECONNECT_WINDOW_MS;
  // A copy failover just switched to that fails before it ever played: the next copy, no retries.
  const freshSwitch = isUntriedSwitch(src);

  if (failoverOn && r.canSwitch && (r.switchNow || freshSwitch || !canRetry)) {
    void switchOver(ses, src, canRetry && !freshSwitch, cls);
    return;
  }
  if (canRetry && delay !== undefined) {
    scheduleRetry(ses, delay);
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
  const delay = RECONNECT_DELAYS_MS[ses.attempts];
  if (thenRetry && delay !== undefined) scheduleRetry(ses, delay);
  else giveUp(ses, src);
}

function scheduleRetry(ses: Session, delay: number): void {
  ses.attempts++;
  hold();
  setPhase('retrying', ses.attempts);
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
  attemptTimer = setTimeout(() => {
    attemptTimer = null;
    const cur = sameItem(ses);
    const s = usePlayerStore.getState();
    if (!cur || !recovering(ses)) return;
    fail(ses, cur, 'timeout', { message: TIMEOUT_MESSAGE, code: 'timeout' }, s.positionSeconds);
  }, ATTEMPT_TIMEOUT_MS);

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
  ses.gaveUp = true;
  retryTimer = clear(retryTimer);
  attemptTimer = clear(attemptTimer);
  setPhase('idle');
  if (usePlayerStore.getState().status !== 'error' && sameItem(ses)) showError(ses);
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

/** Stall detector: a `playing` stream whose position stands still. */
function tick(): void {
  const s = usePlayerStore.getState();
  const now = Date.now();
  if (s.status !== 'playing' || !s.source || s.mode === 'external') {
    lastMoveAt = now;
    return;
  }
  if (s.positionSeconds !== lastPos) {
    lastPos = s.positionSeconds;
    lastMoveAt = now;
    return;
  }
  if (now - lastMoveAt < STALL_MS || !(peekSettings()?.streamReconnect ?? true)) return;
  lastMoveAt = now;
  const key = keyOf(s.source);
  if (!session || session.key !== key) session = newSession(key);
  // A recovery under way (a stalled mpv stream keeps saying `playing`) has its own timeout.
  if (session.busy || session.gaveUp || retryTimer || attemptTimer) return;
  session.stallPos = s.positionSeconds;
  fail(session, s.source, 'timeout', { message: STALL_MESSAGE, code: 'timeout' }, s.positionSeconds);
}

function syncTick(s: PlayerState): void {
  const want = s.status === 'playing' && !!s.source && s.mode !== 'external';
  if (want && !tickTimer) {
    lastPos = s.positionSeconds;
    lastMoveAt = Date.now();
    tickTimer = setInterval(tick, TICK_MS);
  } else if (!want && tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

function onPlayer(s: PlayerState, prev: PlayerState): void {
  const src = s.source;
  const key = src ? keyOf(src) : null;
  const prevKey = prev.source ? keyOf(prev.source) : null;
  if (session && session.key !== key) endSession();
  syncTick(s);
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
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  lastPos = -1;
  lastMoveAt = 0;
}
