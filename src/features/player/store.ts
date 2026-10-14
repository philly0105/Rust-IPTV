/**
 * Player store (SPEC C8). One playback session per window.
 *
 * The store owns *what* plays and its observable state. Media elements (hls.js,
 * shaka, <video>, embedded mpv) register a `PlaybackController` so store actions
 * (`togglePlay`, `seekTo`, ...) drive whichever surface is active, and report
 * progress back through `reportProgress`/`reportStatus`.
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand';

import { isDesktop, rpc } from '@/api/transport';
import { QUIT_FLUSH_EVENT, type QuitFlushDetail } from '@/api/window';
import type {
  Channel,
  ItemRef,
  ItemSnapshot,
  PlaybackPosition,
  PlayerKind,
  PlayerSource,
  Settings,
  SourceKind,
  VideoPlayer,
} from '@/api/types';
import { itemKey } from '@/api/types';
import { displayChannelName } from '@/features/live/lib/channelName';

import { rpcErrorCode } from './errors';
import { resetMedia, showOsd, UP_NEXT_SECONDS, useMediaStore } from './media';
import { ensurePlaybackAllowed, type PlaybackGateItem } from './parentalHook';
import { lockedNow, onPlaybackHidden } from './parentalLocks';

export type PlayerMode = 'inline' | 'embedded-mpv' | 'external' | 'radio';

export interface ZapContext {
  sourceId: string;
  categoryId?: string;
}

export interface PlayerState {
  source?: PlayerSource;
  mode: PlayerMode;
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'error';
  error?: string;
  isFullscreen: boolean;
  dock: 'stage' | 'mini' | 'hidden';
  volume: number;
  muted: boolean;
  positionSeconds: number;
  durationSeconds?: number;
  queue: PlayerSource[];
  zapContext?: ZapContext;
}

export interface PlayerActions {
  play(source: PlayerSource, opts?: { queue?: PlayerSource[]; mode?: PlayerMode }): Promise<void>;
  stop(): void;
  togglePlay(): void;
  seekBy(seconds: number): void;
  seekTo(seconds: number): void;
  setVolume(v: number): void;
  adjustVolume(delta: number): void;
  toggleMute(): void;
  toggleFullscreen(): void;
  setDock(d: PlayerState['dock']): void;
  next(): void;
  prev(): void;
}

/** Implemented by the active media surface (inline element or embedded mpv bridge). */
export interface PlaybackController {
  play(): void;
  pause(): void;
  seekTo(seconds: number): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
}

// ---------------------------------------------------------------------------
// Module state (not part of the public store shape)
// ---------------------------------------------------------------------------

const VOLUME_KEY = 'player.volume';
export const RESUME_KEY = 'player.resume';
export const SAVE_INTERVAL_MS = 5000;

let controller: PlaybackController | null = null;
let stageCount = 0;
let saveTimer: ReturnType<typeof setInterval> | null = null;
/** Incremented per play(); play's own async steps check it to drop stale results. */
let playToken = 0;
/** Incremented by every user-level request (playItem, playSource, play, stop); pending resolutions compare it. */
let requestSeq = 0;
let settingsCache: Settings | null = null;
let settingsPromise: Promise<Settings | null> | null = null;
const sourceKindCache = new Map<string, SourceKind>();
/**
 * The resolution that failed before anything could load (stream URL lookup, a queue entry):
 * Retry runs it again, since there is no media URL for the surface to reload.
 */
let failedResolve: (() => Promise<void>) | null = null;
/**
 * The item the parental gate last let through (`itemKey` of its ref). Entry points ask the
 * gate before anything shows; `play` and queue advances only ask again when they switch to a
 * different item, so a replay, a failover to the same item or the next episode of an allowed
 * series never prompts twice.
 */
let allowedRefKey: string | null = null;
/** Saved positions this close to the start are not worth a resume (and no "Resumed at 0:03"). */
export const MIN_RESUME_SECONDS = 5;
/**
 * The double-click window: above the longest double-click time Windows allows (900 ms), so a
 * slow double click still counts. A click on an ended item waits this long before it replays
 * (a double click there only toggles fullscreen, C6), and a double click within it undoes its
 * first click's pause toggle. Both video surfaces use it for both.
 */
export const DOUBLE_CLICK_MS = 1000;

function readStoredVolume(): { volume: number; muted: boolean } {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(VOLUME_KEY) : null;
    if (raw) {
      const v = JSON.parse(raw) as { volume?: unknown; muted?: unknown };
      const volume = typeof v.volume === 'number' && Number.isFinite(v.volume) ? clamp01(v.volume) : 1;
      return { volume, muted: v.muted === true };
    }
  } catch {
    // corrupt value: defaults
  }
  return { volume: 1, muted: false };
}

/**
 * Told when the volume or mute changes through the store's actions (`setVolume`,
 * `adjustVolume`, `toggleMute`), never for a surface echo (`reportVolume`): the sleep timer's
 * fade tells a person's change apart from mpv reporting back the levels the fade set.
 */
const volumeIntentListeners = new Set<() => void>();

export function subscribeVolumeIntent(fn: () => void): () => void {
  volumeIntentListeners.add(fn);
  return () => {
    volumeIntentListeners.delete(fn);
  };
}

function volumeIntent(): void {
  for (const fn of volumeIntentListeners) fn();
}

/**
 * Puts the volume level back and leaves mute as it is (the sleep timer restoring the level its
 * fade lowered, after the person muted meanwhile). A restore, not a person's change: no intent.
 */
export function restoreVolumeLevel(v: number): void {
  const volume = clamp01(v);
  const { muted } = usePlayerStore.getState();
  controller?.setVolume(volume);
  usePlayerStore.setState({ volume });
  storeVolume(volume, muted);
}

function storeVolume(volume: number, muted: boolean): void {
  try {
    localStorage.setItem(VOLUME_KEY, JSON.stringify({ volume, muted }));
  } catch {
    // storage unavailable
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

// ---------------------------------------------------------------------------
// Helpers exported for the feature (and tests)
// ---------------------------------------------------------------------------

/** Guess the player kind for a raw stream url. */
export function kindFromUrl(url: string): PlayerKind {
  const path = url.split(/[?#]/)[0]?.toLowerCase() ?? '';
  if (path.endsWith('.m3u8') || path.endsWith('.m3u') || /[?&](type|output|extension)=m3u8?\b/i.test(url)) return 'hls';
  if (path.endsWith('.mpd')) return 'dash';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('/')) return 'file';
  return 'direct';
}

/** VOD content whose position is tracked (`positions.set`). */
export function tracksPosition(source: PlayerSource | undefined): source is PlayerSource & { ref: ItemRef } {
  return (
    !!source?.ref && !source.isLive && (source.ref.contentType === 'movie' || source.ref.contentType === 'series')
  );
}

export function snapshotOf(source: PlayerSource): ItemSnapshot | undefined {
  if (!source.ref) return undefined;
  const snap: ItemSnapshot = { title: source.title, contentType: source.ref.contentType };
  if (source.subtitle) snap.subtitle = source.subtitle;
  if (source.posterUrl) snap.posterUrl = source.posterUrl;
  return snap;
}

/**
 * Seconds before the end that still count as "at the end". mpv with `keep-open` pauses
 * a little short of `duration`; the element reports exactly `duration`.
 */
export const ENDED_EPSILON = 0.75;

/**
 * "Ended" is not a C8 status (the union is `idle|loading|playing|paused|error`), so it is
 * derived: a VOD item paused at its end. Live and radio never end.
 */
export function isEndedState(
  s: Pick<PlayerState, 'source' | 'status' | 'positionSeconds' | 'durationSeconds'>,
): boolean {
  return (
    !!s.source &&
    !s.source.isLive &&
    s.status === 'paused' &&
    !!s.durationSeconds &&
    Number.isFinite(s.durationSeconds) &&
    s.positionSeconds >= s.durationSeconds - ENDED_EPSILON
  );
}

/** Selector form: `usePlayerStore(selectEnded)`. */
export const selectEnded = (s: PlayerState): boolean => isEndedState(s);

export function sameSource(a: PlayerSource | undefined, b: PlayerSource | undefined): boolean {
  if (!a || !b) return false;
  if (a.ref && b.ref) {
    return (
      a.ref.sourceId === b.ref.sourceId &&
      a.ref.contentType === b.ref.contentType &&
      a.ref.itemId === b.ref.itemId &&
      (a.episodeId ?? '') === (b.episodeId ?? '')
    );
  }
  return a.url === b.url;
}

/** Cached settings; refreshed by `settings.changed` (see `setSettingsCache`). */
export async function getSettings(): Promise<Settings | null> {
  if (settingsCache) return settingsCache;
  settingsPromise ??= rpc('settings.get')
    .then((s) => {
      setSettingsCache(s);
      return s;
    })
    .catch(() => null)
    .finally(() => {
      settingsPromise = null;
    });
  return settingsPromise;
}

const settingsListeners = new Set<() => void>();

export function setSettingsCache(s: Settings | null): void {
  settingsCache = s;
  for (const l of settingsListeners) l();
}

export function subscribeSettings(l: () => void): () => void {
  settingsListeners.add(l);
  return () => settingsListeners.delete(l);
}

export function peekSettings(): Settings | null {
  return settingsCache;
}

/** The kind of a source this session already looked up, without asking the core. */
export function knownSourceKind(sourceId: string): SourceKind | undefined {
  return sourceKindCache.get(sourceId);
}

/** The source's kind, looked up once per session (`sources.get`); rejects when that fails. */
export async function sourceKindOf(sourceId: string): Promise<SourceKind> {
  const cached = sourceKindCache.get(sourceId);
  if (cached) return cached;
  const src = await rpc('sources.get', { id: sourceId });
  sourceKindCache.set(sourceId, src.kind);
  return src.kind;
}

/** Map `settings.player` to a mode. Radio stays in-app unless an external player is chosen. */
export function modeForSettings(player: VideoPlayer | undefined, source: PlayerSource): PlayerMode {
  if (player === 'mpv' || player === 'vlc') return 'external';
  if (source.isRadio) return 'radio';
  if (player === 'embedded-mpv') return 'embedded-mpv';
  return 'inline';
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string') return err;
  return 'Playback failed';
}

// ---------------------------------------------------------------------------
// Resume persistence (sessionStorage)
// ---------------------------------------------------------------------------

export interface ResumeRecord {
  source: PlayerSource;
  positionSeconds: number;
  mode: PlayerMode;
  savedAt: number;
}

export function readResume(): ResumeRecord | null {
  try {
    const raw = sessionStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as Partial<ResumeRecord>;
    if (!rec.source || typeof rec.source.url !== 'string' || typeof rec.source.kind !== 'string') return null;
    return {
      source: rec.source,
      positionSeconds: typeof rec.positionSeconds === 'number' && rec.positionSeconds > 0 ? rec.positionSeconds : 0,
      mode: rec.mode ?? 'inline',
      savedAt: typeof rec.savedAt === 'number' ? rec.savedAt : 0,
    };
  } catch {
    return null;
  }
}

function writeResume(): void {
  const state = usePlayerStore.getState();
  const { source, positionSeconds, mode } = state;
  try {
    // A finished item must not come back at its last frame after a reload.
    // No url: a failed lookup, nothing a reload could replay.
    if (!source?.url || mode === 'external' || isEndedState(state)) {
      sessionStorage.removeItem(RESUME_KEY);
      return;
    }
    const rec: ResumeRecord = { source, positionSeconds, mode, savedAt: Date.now() };
    sessionStorage.setItem(RESUME_KEY, JSON.stringify(rec));
  } catch {
    // storage full or unavailable
  }
}

function clearResume(): void {
  try {
    sessionStorage.removeItem(RESUME_KEY);
  } catch {
    // ignore
  }
}

/** Last position we pushed to the backend, so ticks without progress do not write. */
let lastSavedPosition = -1;

/** Sends the VOD position; the promise settles when the core has it (or the send failed). */
function savePosition(): Promise<void> {
  const { source, positionSeconds, durationSeconds } = usePlayerStore.getState();
  if (!tracksPosition(source)) return Promise.resolve();
  const pos = Math.floor(positionSeconds);
  if (pos <= 0 || pos === lastSavedPosition) return Promise.resolve();
  lastSavedPosition = pos;
  const args: Parameters<typeof rpc<'positions.set'>>[1] = {
    ref: source.ref,
    positionSeconds: pos,
  };
  if (source.episodeId) args.episodeId = source.episodeId;
  const dur = durationSeconds ?? undefined;
  if (dur && Number.isFinite(dur)) args.durationSeconds = Math.floor(dur);
  const snap = snapshotOf(source);
  if (snap) args.snapshot = snap;
  return rpc('positions.set', args).then(
    () => undefined,
    () => {
      lastSavedPosition = -1; // retry on next tick
    },
  );
}

/** Persist now: resume record and VOD position. Called every 5 s, on stop, and on page hide. */
export function flushProgress(): void {
  writeResume();
  void savePosition();
}

/**
 * Quit or window close (tray Quit, the window's X, Alt+F4): save like `pagehide` would, and let
 * the quit wait for the position to land, up to the 2.5 s flush budget (`QUIT_FLUSH_BUDGET_MS`).
 */
function flushBeforeQuit(e: Event): void {
  writeResume();
  (e as CustomEvent<QuitFlushDetail>).detail?.waitUntil(savePosition());
}

function startSaver(): void {
  stopSaver();
  saveTimer = setInterval(() => {
    const { status } = usePlayerStore.getState();
    if (status === 'playing' || status === 'paused') flushProgress();
  }, SAVE_INTERVAL_MS);
}

function stopSaver(): void {
  if (saveTimer) clearInterval(saveTimer);
  saveTimer = null;
}

let unloadBound = false;
function bindUnload(): void {
  if (unloadBound || typeof window === 'undefined') return;
  unloadBound = true;
  window.addEventListener('pagehide', flushProgress);
  window.addEventListener('beforeunload', flushProgress);
  window.addEventListener(QUIT_FLUSH_EVENT, flushBeforeQuit);
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

const initialVolume = readStoredVolume();

export const usePlayerStore: UseBoundStore<StoreApi<PlayerState & PlayerActions>> = create<
  PlayerState & PlayerActions
>()((set, get) => ({
  mode: 'inline',
  status: 'idle',
  isFullscreen: false,
  dock: 'hidden',
  volume: initialVolume.volume,
  muted: initialVolume.muted,
  positionSeconds: 0,
  queue: [],

  async play(source, opts) {
    const token = ++playToken;
    requestSeq++;
    failedResolve = null;
    // A pending Up next must not fire while this request resolves and replace it.
    cancelUpNext();
    // Direct callers (failover, a queue advance) that switch items pass the parental gate here;
    // a refusal leaves whatever was playing as it was.
    if (source.ref && !gatePassed(source.ref)) {
      const allowed = await passGate({ ref: source.ref, title: source.title });
      if (!allowed || token !== playToken) return;
    }
    bindUnload();
    // Persist the outgoing item before switching.
    if (get().source) flushProgress();
    lastSavedPosition = -1;

    const settings = await getSettings();
    if (token !== playToken) return;
    let mode = opts?.mode ?? modeForSettings(settings?.player, source);
    // Embedded mpv needs the desktop shell; everywhere else the built-in player takes over.
    if (mode === 'embedded-mpv' && !isDesktop) mode = 'inline';
    const queue = opts?.queue ?? (get().queue.some((q) => sameSource(q, source)) ? get().queue : []);

    resetMedia();
    set({
      source,
      mode,
      queue,
      status: 'loading',
      error: undefined,
      positionSeconds: source.resumeSeconds ?? 0,
      durationSeconds: undefined,
      dock: mode === 'external' ? 'hidden' : stageCount > 0 ? 'stage' : 'mini',
    });

    if (source.ref) {
      const snapshot = snapshotOf(source);
      if (snapshot) rpc('recent.add', { ref: source.ref, snapshot }).catch(() => undefined);
    }

    if (mode === 'external') {
      stopSaver();
      clearResume();
      const player = settings?.player === 'vlc' ? 'vlc' : 'mpv';
      try {
        await rpc('player.openExternal', { player, source });
        if (token === playToken) set({ status: 'playing' });
      } catch (err) {
        if (token === playToken) set({ status: 'error', error: errorMessage(err), dock: stageCount > 0 ? 'stage' : 'mini' });
      }
      return;
    }

    writeResume();
    startSaver();
  },

  stop() {
    playToken++;
    requestSeq++;
    if (get().source) flushProgress();
    stopSaver();
    clearResume();
    lastSavedPosition = -1;
    controller?.pause();
    resetMedia();
    if (get().mode === 'embedded-mpv') rpc('mpv.detach').catch(() => undefined);
    if (typeof document !== 'undefined' && document.fullscreenElement) {
      document.exitFullscreen().catch(() => undefined);
    }
    set({
      source: undefined,
      status: 'idle',
      error: undefined,
      positionSeconds: 0,
      durationSeconds: undefined,
      queue: [],
      dock: 'hidden',
      isFullscreen: false,
      mode: 'inline',
    });
  },

  togglePlay() {
    const { status, source } = get();
    if (!source || get().mode === 'external') return;
    if (isEndedState(get())) {
      replay();
      return;
    }
    if (status === 'playing' || status === 'loading') {
      controller?.pause();
      if (!controller) set({ status: 'paused' });
    } else {
      controller?.play();
      if (!controller) set({ status: 'playing' });
    }
  },

  seekBy(seconds) {
    const { positionSeconds } = get();
    get().seekTo(positionSeconds + seconds);
  },

  seekTo(seconds) {
    const { source, durationSeconds } = get();
    if (!source || get().mode === 'external') return;
    let target = Math.max(0, seconds);
    if (durationSeconds && Number.isFinite(durationSeconds)) {
      target = Math.min(target, durationSeconds);
      // Seeking back into a finished episode means "keep watching": no auto-advance now, and
      // reaching the end again offers the next item again.
      if (target < durationSeconds - ENDED_EPSILON) {
        cancelUpNext();
        upNextHandledFor = undefined;
      }
    }
    controller?.seekTo(target);
    set({ positionSeconds: target });
  },

  setVolume(v) {
    const volume = clamp01(v);
    const muted = volume === 0 ? get().muted : false;
    controller?.setVolume(volume);
    if (!muted) controller?.setMuted(false);
    set({ volume, muted });
    storeVolume(volume, muted);
    volumeIntent();
  },

  adjustVolume(delta) {
    get().setVolume(Math.round((get().volume + delta) * 100) / 100);
  },

  toggleMute() {
    const muted = !get().muted;
    controller?.setMuted(muted);
    set({ muted });
    storeVolume(get().volume, muted);
    volumeIntent();
  },

  toggleFullscreen() {
    if (!get().source) return;
    set({ isFullscreen: !get().isFullscreen });
  },

  setDock(d) {
    set({ dock: d });
  },

  next() {
    const nextSource = nextInQueue();
    if (!nextSource) return;
    // The countdown would otherwise start a second advance while this one resolves.
    cancelUpNext();
    void playQueued(nextSource);
  },

  prev() {
    const prevSource = prevInQueue();
    if (!prevSource) return;
    cancelUpNext();
    void playQueued(prevSource);
  },
}));

// ---------------------------------------------------------------------------
// Surface integration (used by InlinePlayer, the mpv bridge, the dock)
// ---------------------------------------------------------------------------

export function setController(c: PlaybackController | null): () => void {
  controller = c;
  if (c) {
    const { volume, muted } = usePlayerStore.getState();
    c.setVolume(volume);
    c.setMuted(muted);
  }
  return () => {
    if (controller === c) controller = null;
  };
}

export function reportProgress(positionSeconds: number, durationSeconds?: number): void {
  const patch: Partial<PlayerState> = { positionSeconds };
  if (durationSeconds !== undefined && Number.isFinite(durationSeconds) && durationSeconds > 0) {
    patch.durationSeconds = durationSeconds;
  }
  usePlayerStore.setState(patch);
}

export function reportStatus(status: PlayerState['status'], error?: string): void {
  const s = usePlayerStore.getState();
  if (!s.source) return;
  if (status !== 'error' && useMediaStore.getState().errorCode) useMediaStore.setState({ errorCode: undefined });
  if (s.status === status && s.error === error) return;
  usePlayerStore.setState(status === 'error' ? { status, error } : { status, error: undefined });
}

export function reportVolume(volume: number, muted: boolean): void {
  const s = usePlayerStore.getState();
  if (Math.abs(s.volume - volume) < 0.005 && s.muted === muted) return;
  usePlayerStore.setState({ volume: clamp01(volume), muted });
  storeVolume(clamp01(volume), muted);
}

export function reportFullscreen(isFullscreen: boolean): void {
  if (usePlayerStore.getState().isFullscreen !== isFullscreen) usePlayerStore.setState({ isFullscreen });
}

/**
 * Called by the surface when media ends: park at the end (derived "ended", see `isEndedState`),
 * drop the resume record, mark the VOD position finished, then offer the next queue item.
 */
export function handleEnded(): void {
  const s = usePlayerStore.getState();
  if (!s.source || s.source.isLive) return;
  const patch: Partial<PlayerState> = { status: 'paused' };
  if (s.durationSeconds && Number.isFinite(s.durationSeconds)) patch.positionSeconds = s.durationSeconds;
  usePlayerStore.setState(patch);
  // Mark as finished: at >= 95 % the core deletes a movie's row (unless marked watched) and keeps an
  // episode's as a watched row at its end (C13); `withSavedPosition` never resumes from either.
  if (tracksPosition(s.source) && s.durationSeconds) void savePosition();
  clearResume();
  offerUpNext();
}

// ---------------------------------------------------------------------------
// Up next: the countdown lives here, not in the card, so auto-advance happens even when no
// card is mounted (hidden fullscreen chrome, a surface between layouts).
// ---------------------------------------------------------------------------

let upNextTimer: ReturnType<typeof setTimeout> | null = null;
let upNextArmed: MediaUpNext | undefined;
type MediaUpNext = NonNullable<ReturnType<typeof useMediaStore.getState>['upNext']>;
/**
 * The finished item whose Up next was already offered (then counted down, played or
 * cancelled). The end can be reported more than once (a surface remount, a late duplicate
 * event, the queue arriving after the end); each item advances at most once.
 */
let upNextHandledFor: PlayerSource | undefined;

/** The dock shows a 10 s "Next episode" card; the store's timer (below) advances at zero. */
function offerUpNext(): void {
  const s = usePlayerStore.getState();
  if (!s.source || upNextHandledFor === s.source || useMediaStore.getState().upNext) return;
  const next = nextInQueue();
  if (!next || !(peekSettings()?.playerAutoplayNextEpisode ?? true)) return;
  upNextHandledFor = s.source;
  useMediaStore.setState({ upNext: { source: next, deadline: Date.now() + UP_NEXT_SECONDS * 1000 } });
}

/**
 * The queue is owned by whoever plays a list (the series page rebuilds and refreshes it while
 * an episode plays). Keep a pending Up next pointed at the queue's current next entry (a
 * refreshed short-lived link replaces the old one), and offer it when the queue only arrives
 * after the item already ended.
 */
usePlayerStore.subscribe((s, prev) => {
  if (s.queue === prev.queue) return;
  const pending = useMediaStore.getState().upNext;
  if (pending) {
    const next = nextInQueue();
    if (next && next !== pending.source) useMediaStore.setState({ upNext: { source: next, deadline: pending.deadline } });
    return;
  }
  if (isEndedState(s)) offerUpNext();
});

/**
 * Startup and stall watchdog. Some failures never reach the engine as an error: a stream that
 * answers 401 with `WWW-Authenticate: Basic` leaves both WebView2 and mpv waiting with no
 * event. After `STARTUP_TIMEOUT_MS` in `loading` on the same item, raise a timeout so the error
 * overlay shows its Retry. (The 401 itself is not visible from here, so this is a timeout, not
 * an auth error; streams whose 401 the engine does report still classify as auth.)
 */
export const STARTUP_TIMEOUT_MS = 30_000;
let stallTimer: ReturnType<typeof setTimeout> | null = null;
let stallFor: PlayerSource | undefined;

function clearStallTimer(): void {
  if (stallTimer) clearTimeout(stallTimer);
  stallTimer = null;
  stallFor = undefined;
}

usePlayerStore.subscribe((s) => {
  const watching = s.status === 'loading' && !!s.source?.url && s.mode !== 'external';
  if (watching && stallTimer && stallFor === s.source) return;
  clearStallTimer();
  if (!watching) return;
  const src = s.source;
  stallFor = src;
  stallTimer = setTimeout(() => {
    stallTimer = null;
    stallFor = undefined;
    const now = usePlayerStore.getState();
    if (now.source !== src || now.status !== 'loading') return;
    useMediaStore.setState({ errorCode: 'timeout' });
    reportStatus('error', 'Timed out waiting for the stream');
  }, STARTUP_TIMEOUT_MS);
});

useMediaStore.subscribe((s) => {
  if (s.upNext === upNextArmed) return;
  upNextArmed = s.upNext;
  if (upNextTimer) clearTimeout(upNextTimer);
  upNextTimer = null;
  const pending = s.upNext;
  if (!pending) return;
  upNextTimer = setTimeout(
    () => {
      upNextTimer = null;
      if (useMediaStore.getState().upNext !== pending) return;
      useMediaStore.setState({ upNext: undefined });
      void playQueued(pending.source);
    },
    Math.max(0, pending.deadline - Date.now()),
  );
});

/** "Play now" on the Up next card. */
export function playUpNextNow(): void {
  const pending = useMediaStore.getState().upNext;
  if (!pending) return;
  useMediaStore.setState({ upNext: undefined });
  void playQueued(pending.source);
}

/** "Cancel" on the Up next card: stay on the finished item. */
export function cancelUpNext(): void {
  if (useMediaStore.getState().upNext) useMediaStore.setState({ upNext: undefined });
}

/**
 * Play a queue entry, keeping the queue. Entries may be placeholders (a `ref` and `episodeId`
 * with an empty `url`): those are resolved now, so short-lived links (Stalker) are fresh.
 * Either way the entry picks up its saved position.
 */
async function playQueued(entry: PlayerSource): Promise<void> {
  const { queue, mode } = usePlayerStore.getState();
  // A queue of different items (not episodes of one series) asks the gate before the entry shows.
  if (entry.ref && !gatePassed(entry.ref)) {
    const seq = requestSeq;
    if (!(await passGate({ ref: entry.ref, title: entry.title })) || seq !== requestSeq) return;
  }
  const run = async (): Promise<void> => {
    const seq = ++requestSeq;
    let resolved = entry;
    try {
      if (entry.ref && !entry.url) {
        const sourceKind = await sourceKindOf(entry.ref.sourceId);
        const args: PlayItemArgs = {
          ref: entry.ref,
          title: entry.title,
          isLive: entry.isLive,
          isRadio: entry.isRadio,
          sourceKind,
        };
        if (entry.episodeId) args.episodeId = entry.episodeId;
        if (entry.subtitle) args.subtitle = entry.subtitle;
        if (entry.posterUrl) args.posterUrl = entry.posterUrl;
        resolved = await resolveSource(args);
        resolved = await withResume(resolved);
      } else {
        resolved = await freshResume(resolved);
      }
    } catch (err) {
      if (seq !== requestSeq) return;
      failResolve(err, { ...entry, url: '' }, run);
      return;
    }
    if (seq !== requestSeq) return;
    // The list owner may have rebuilt or refreshed the queue meanwhile: keep its newest copy.
    const latest = usePlayerStore.getState().queue;
    await usePlayerStore.getState().play(resolved, { queue: latest.some((q) => sameSource(q, entry)) ? latest : queue, mode });
  };
  if (!entry.url) usePlayerStore.setState({ status: 'loading', error: undefined });
  await run();
}

/** A resolution failed: show the error on the item it was for, and let Retry run it again. */
function failResolve(err: unknown, placeholder: PlayerSource, again: () => Promise<void>): void {
  failedResolve = again;
  // The empty url makes the surfaces drop whatever played before (see InlinePlayer, MpvSurface).
  const code = rpcErrorCode(err);
  useMediaStore.setState({ errorCode: code });
  usePlayerStore.setState({ status: 'error', error: errorMessage(err), source: placeholder });
}

/**
 * Retry after a failure that happened before any media existed (no stream URL yet).
 * Returns false when the surface should reload its media instead.
 */
export function retryResolve(): boolean {
  const s = usePlayerStore.getState();
  if (!failedResolve || !s.source || s.source.url) return false;
  const again = failedResolve;
  failedResolve = null;
  usePlayerStore.setState({ status: 'loading', error: undefined });
  useMediaStore.setState({ errorCode: undefined });
  void again().catch(() => undefined);
  return true;
}

/**
 * Put the play state back to `paused` (the double click undoing its first click's toggle).
 * Unlike `togglePlay` it does not read `status`, which lags the engine by an event.
 */
export function setPaused(paused: boolean): void {
  const s = usePlayerStore.getState();
  if (!s.source || s.mode === 'external') return;
  if (paused) controller?.pause();
  else controller?.play();
  if (!controller) usePlayerStore.setState({ status: paused ? 'paused' : 'playing' });
}

/** Start the current item again from the beginning (the dock's replay affordance). */
export function replay(): void {
  const s = usePlayerStore.getState();
  if (!s.source || s.mode === 'external') return;
  useMediaStore.setState({ upNext: undefined });
  upNextHandledFor = undefined;
  lastSavedPosition = -1;
  if (!controller) {
    const { resumeSeconds: _drop, ...fresh } = s.source;
    void s.play(fresh, { queue: s.queue, mode: s.mode });
    return;
  }
  controller.seekTo(0);
  controller.play();
  usePlayerStore.setState({ positionSeconds: 0, status: 'loading', error: undefined });
  writeResume();
}

export function nextInQueue(): PlayerSource | undefined {
  const s = usePlayerStore.getState();
  const idx = s.queue.findIndex((q) => sameSource(q, s.source));
  return idx >= 0 ? s.queue[idx + 1] : undefined;
}

export function prevInQueue(): PlayerSource | undefined {
  const s = usePlayerStore.getState();
  const idx = s.queue.findIndex((q) => sameSource(q, s.source));
  return idx > 0 ? s.queue[idx - 1] : undefined;
}

/** PlayerStage mount/unmount bookkeeping (dock 'stage' while any stage is mounted). */
export function registerStage(): () => void {
  stageCount++;
  if (usePlayerStore.getState().source && usePlayerStore.getState().mode !== 'external') {
    usePlayerStore.setState({ dock: 'stage' });
  }
  return () => {
    stageCount = Math.max(0, stageCount - 1);
    if (stageCount === 0) {
      const s = usePlayerStore.getState();
      usePlayerStore.setState({ dock: s.source && s.mode !== 'external' ? 'mini' : 'hidden', isFullscreen: false });
    }
  };
}

export function stageMounted(): boolean {
  return stageCount > 0;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export interface PlayItemArgs {
  ref: ItemRef;
  episodeId?: string;
  title: string;
  subtitle?: string;
  posterUrl?: string;
  isLive: boolean;
  isRadio?: boolean;
  sourceKind: SourceKind;
  /** The item's category when the caller knows it; the parental gate looks it up otherwise. */
  categoryId?: string;
}

/** True when `ref` is the item playing now or the one the parental gate last let through. */
function gatePassed(ref: ItemRef): boolean {
  const key = itemKey(ref);
  const current = usePlayerStore.getState().source?.ref;
  return key === allowedRefKey || (!!current && itemKey(current) === key);
}

/** Ask the parental gate (`parentalHook`); a pass is remembered for the item. */
async function passGate(item: PlaybackGateItem): Promise<boolean> {
  let allowed: boolean;
  try {
    allowed = await ensurePlaybackAllowed(item);
  } catch {
    // The gate could not decide (its lookup failed): stay closed, like a cancelled prompt.
    allowed = false;
  }
  if (allowed) allowedRefKey = itemKey(item.ref);
  return allowed;
}

// Hide mode refused an item the player held on to: the resume record must not offer it again
// on the next reload (restorePlayback replays its stored URL).
onPlaybackHidden((item) => {
  const kept = readResume()?.source.ref;
  if (kept && itemKey(kept) === itemKey(item.ref)) clearResume();
});

/**
 * Parental controls locked again (`parental.changed` with no unlock running: Lock now, the
 * unlock ran out, a new lock). The last pass no longer counts, so a replay, failover or queue
 * advance of that item asks again. Called by the player's parental guard.
 */
export function forgetGatePass(): void {
  allowedRefKey = null;
}

/** Resolve a catalog item to a PlayerSource by source kind. Exported for tests. */
export async function resolveSource(args: PlayItemArgs): Promise<PlayerSource> {
  const { ref, episodeId } = args;
  let resolved: PlayerSource;
  if (args.sourceKind === 'xtream') {
    resolved = await rpc('xtream.streamUrl', episodeId ? { ref, episodeId } : { ref });
  } else if (args.sourceKind === 'stalker') {
    resolved = await rpc('stalker.streamUrl', episodeId ? { ref, episodeId } : { ref });
  } else {
    const [item, src] = await Promise.all([
      rpc('catalog.item', { ref }),
      rpc('sources.get', { id: ref.sourceId }).catch(() => null),
    ]);
    const url = 'url' in item ? item.url : undefined;
    if (!url) throw new Error('This item has no stream URL');
    resolved = { url, kind: kindFromUrl(url), title: args.title, isLive: args.isLive, isRadio: !!args.isRadio };
    // Per-channel headers (#EXTVLCOPT / url|Header=) override the playlist's, field by field.
    const itemHeaders = 'headers' in item ? item.headers : undefined;
    const headers: NonNullable<PlayerSource['headers']> = {};
    for (const h of [src?.m3u?.headers, itemHeaders]) {
      if (h?.userAgent) headers.userAgent = h.userAgent;
      if (h?.referrer) headers.referrer = h.referrer;
      if (h?.origin) headers.origin = h.origin;
    }
    if (Object.keys(headers).length > 0) resolved.headers = headers;
  }
  sourceKindCache.set(ref.sourceId, args.sourceKind);

  const out: PlayerSource = {
    ...resolved,
    title: args.title || resolved.title,
    ref,
    isLive: args.isLive,
    isRadio: args.isRadio ?? resolved.isRadio ?? false,
  };
  if (episodeId) out.episodeId = episodeId;
  const subtitle = args.subtitle ?? resolved.subtitle;
  if (subtitle) out.subtitle = subtitle;
  else delete out.subtitle;
  const poster = args.posterUrl ?? resolved.posterUrl;
  if (poster) out.posterUrl = poster;
  return out;
}

async function withResume(source: PlayerSource): Promise<PlayerSource> {
  if (source.resumeSeconds !== undefined) {
    const { resumeSeconds: given, ...rest } = source;
    // The core fills it for Xtream from any saved row; a few seconds in is not a resume.
    if (source.isLive || given <= MIN_RESUME_SECONDS) return rest;
    if (!tracksPosition(source)) return source;
    // A finished item is kept as a watched row at its end (C13): replaying it starts over.
    try {
      const saved = await savedPosition(source);
      if (saved && (isFinished(saved) || isPastEnd(given, saved.durationSeconds))) return rest;
    } catch {
      // No saved row to check against: keep the given point.
    }
    return source;
  }
  if (!tracksPosition(source)) return source;
  try {
    return withSavedPosition(source, await savedPosition(source));
  } catch {
    // no saved position
  }
  return source;
}

function savedPosition(source: PlayerSource & { ref: ItemRef }): Promise<PlaybackPosition | null> {
  return rpc('positions.get', source.episodeId ? { ref: source.ref, episodeId: source.episodeId } : { ref: source.ref });
}

/** Share of the duration from which an item counts as finished (the core marks it watched there). */
const FINISHED_RATIO = 0.95;

function isPastEnd(seconds: number, duration: number | undefined): boolean {
  return !!duration && seconds >= duration * FINISHED_RATIO;
}

/** A saved row for an item that was finished or marked watched: not a resume point. */
function isFinished(pos: PlaybackPosition): boolean {
  return pos.watched || isPastEnd(pos.positionSeconds, pos.durationSeconds);
}

/** The one resume rule: more than MIN_RESUME_SECONDS in, and not finished or watched. */
function withSavedPosition(source: PlayerSource, pos: PlaybackPosition | null | undefined): PlayerSource {
  if (pos && pos.positionSeconds > MIN_RESUME_SECONDS && !isFinished(pos)) {
    return { ...source, resumeSeconds: pos.positionSeconds };
  }
  return source;
}

/**
 * A queue entry's resume point was copied when the queue was built, so it can be stale: the
 * episode was finished since (Prev back to it), or watched further in another session. Ask
 * for the saved position now; only when that fails is the copied one used.
 */
async function freshResume(entry: PlayerSource): Promise<PlayerSource> {
  if (!tracksPosition(entry)) return withResume(entry);
  const { resumeSeconds: _copied, ...bare } = entry;
  try {
    return withSavedPosition(bare, await savedPosition(entry));
  } catch {
    return withResume(entry);
  }
}

export async function playItem(args: PlayItemArgs, opts?: { queue?: PlayerSource[] }): Promise<void> {
  await startItem(args, opts);
}

/**
 * How a start request ended. `refused`: the parental gate said no (prompt cancelled, check
 * failed, hidden), and what was playing is untouched. `superseded`: a newer request took over.
 */
export type StartOutcome = 'started' | 'refused' | 'superseded';

/**
 * `playItem` with its outcome. `onAllowed` runs once the gate let the item through and before
 * anything else, so a zap's tuner readout never shows a channel the PIN prompt then refuses.
 */
export async function startItem(
  args: PlayItemArgs,
  opts?: { queue?: PlayerSource[]; onAllowed?: () => void },
): Promise<StartOutcome> {
  const seq = ++requestSeq;
  // The user picked something: a countdown firing during the lookup must not override it.
  cancelUpNext();
  // Parental gate first, so a locked item's title never shows behind the PIN prompt.
  const gate: PlaybackGateItem = args.categoryId ? { ref: args.ref, categoryId: args.categoryId, title: args.title } : { ref: args.ref, title: args.title };
  if (!(await passGate(gate))) return seq === requestSeq ? 'refused' : 'superseded';
  if (seq !== requestSeq) return 'superseded';
  opts?.onAllowed?.();
  const queueOpts = opts?.queue ? { queue: opts.queue } : undefined;
  usePlayerStore.setState({
    status: 'loading',
    error: undefined,
    source: usePlayerStore.getState().source ?? {
      url: '',
      kind: 'direct',
      title: args.title,
      isLive: args.isLive,
      isRadio: !!args.isRadio,
      ref: args.ref,
    },
    dock: stageCount > 0 ? 'stage' : usePlayerStore.getState().dock === 'hidden' ? 'mini' : usePlayerStore.getState().dock,
  });
  let source: PlayerSource;
  try {
    source = await withResume(await resolveSource(args));
  } catch (err) {
    // A newer request won the race: do not clobber it.
    if (seq !== requestSeq) return 'superseded';
    const placeholder: PlayerSource = { url: '', kind: 'direct', title: args.title, isLive: args.isLive, isRadio: !!args.isRadio, ref: args.ref };
    if (args.episodeId) placeholder.episodeId = args.episodeId;
    if (args.subtitle) placeholder.subtitle = args.subtitle;
    if (args.posterUrl) placeholder.posterUrl = args.posterUrl;
    failResolve(err, placeholder, () => playItem(args, queueOpts));
    throw err;
  }
  if (seq !== requestSeq) return 'superseded';
  await usePlayerStore.getState().play(source, queueOpts);
  return 'started';
}

export async function playSource(source: PlayerSource): Promise<void> {
  const seq = ++requestSeq;
  cancelUpNext();
  if (source.ref && !(await passGate({ ref: source.ref, title: source.title }))) return;
  if (seq !== requestSeq) return;
  const withPos = await withResume(source);
  if (seq !== requestSeq) return;
  await usePlayerStore.getState().play(withPos);
}

/** Boot hook: replay `sessionStorage['player.resume']` (SC12). */
export async function restorePlayback(): Promise<boolean> {
  const rec = readResume();
  if (!rec || rec.mode === 'external') return false;
  // A locked item from the last session asks again (its unlock did not survive the restart).
  if (rec.source.ref && !(await passGate({ ref: rec.source.ref, title: rec.source.title }))) return false;
  const source: PlayerSource = { ...rec.source };
  if (!source.isLive && rec.positionSeconds > 0) source.resumeSeconds = rec.positionSeconds;
  else delete source.resumeSeconds;
  await usePlayerStore.getState().play(source, { mode: rec.mode });
  return true;
}

// ---------------------------------------------------------------------------
// Channel zapping
// ---------------------------------------------------------------------------

/** Title of the programme airing now on `ref` (shifted by `epgOffsetMinutes`), if the guide has one. */
export async function nowTitle(ref: ItemRef, offsetMinutes: number | undefined): Promise<string | undefined> {
  try {
    const res = await rpc('epg.nowNext', offsetMinutes ? { refs: [ref], offsetMinutes } : { refs: [ref] });
    return res[itemKey(ref)]?.now?.title || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Zap/remote/fullscreen-panel path. Titles the player, OSD and resume record with the name the
 * live views show (`settings.stripCountryPrefix`) and subtitles it with the airing programme,
 * like the list click path.
 */
export async function playChannel(channel: Channel, sourceKind?: SourceKind): Promise<void> {
  await tuneChannel(channel, sourceKind);
}

/** `playChannel` with its outcome: a zap steps past a channel the parental gate refused. */
async function tuneChannel(channel: Channel, sourceKind?: SourceKind): Promise<StartOutcome> {
  const settings = await getSettings();
  const name = displayChannelName(channel.name, settings?.stripCountryPrefix) || channel.name;
  const [kind, subtitle] = await Promise.all([
    sourceKind ?? sourceKindOf(channel.ref.sourceId),
    nowTitle(channel.ref, settings?.epgOffsetMinutes),
  ]);
  const args: PlayItemArgs = {
    ref: channel.ref,
    title: name,
    isLive: true,
    isRadio: channel.isRadio,
    sourceKind: kind,
  };
  if (channel.categoryId) args.categoryId = channel.categoryId;
  if (channel.logoUrl) args.posterUrl = channel.logoUrl;
  if (subtitle) args.subtitle = subtitle;
  // Tuner readout: number big, name below. Only once the gate let the channel through, so a
  // cancelled PIN prompt leaves no locked channel's name on screen.
  return startItem(args, {
    onAllowed: () => showOsd(channel.number !== undefined ? String(channel.number) : name, channel.number !== undefined ? name : undefined),
  });
}

function currentLiveRef(): ItemRef | undefined {
  const { source } = usePlayerStore.getState();
  if (!source?.ref || !source.isLive) return undefined;
  return source.ref;
}

/** Most neighbours one zap press looks at while stepping past refused or locked channels. */
export const ZAP_SKIP_LIMIT = 50;

/**
 * Move to the neighbor channel in the current list context. Returns the channel played, if any.
 *
 * When the parental gate refuses the neighbour (its PIN prompt was cancelled), the zap goes on
 * in the same direction from it, so a locked channel never walls off the rest of the list. Past
 * that first refusal it steps over locked channels without asking again (one prompt per press),
 * and it stops when it comes round to a channel it already saw or after ZAP_SKIP_LIMIT steps.
 */
export async function zap(direction: 'up' | 'down'): Promise<Channel | undefined> {
  const start = currentLiveRef();
  if (!start) return undefined;
  const ctx = usePlayerStore.getState().zapContext;
  const seen = new Set<string>([itemKey(start)]);
  let from = start;
  let refused = false;
  for (let step = 0; step < ZAP_SKIP_LIMIT; step++) {
    const args: { ref: ItemRef; categoryId?: string } = { ref: from };
    if (ctx?.categoryId && ctx.sourceId === from.sourceId) args.categoryId = ctx.categoryId;
    const seq = requestSeq;
    const res = await rpc('catalog.neighbors', args);
    // Another request (a newer zap, a click) took over meanwhile: this press is done.
    if (seq !== requestSeq) return undefined;
    const target = direction === 'up' ? res.prev : res.next;
    if (!target || seen.has(itemKey(target.ref))) return undefined;
    seen.add(itemKey(target.ref));
    from = target.ref;
    if (refused) {
      const item: PlaybackGateItem = target.categoryId ? { ref: target.ref, categoryId: target.categoryId } : { ref: target.ref };
      const locked = await lockedNow(item);
      if (seq !== requestSeq) return undefined;
      if (locked) continue;
    }
    const outcome = await tuneChannel(target);
    if (outcome === 'started') return target;
    if (outcome === 'superseded') return undefined;
    refused = true;
  }
  return undefined;
}

export async function zapToNumber(n: number): Promise<Channel | undefined> {
  const sourceId = usePlayerStore.getState().zapContext?.sourceId ?? usePlayerStore.getState().source?.ref?.sourceId;
  if (!sourceId || !Number.isFinite(n)) return undefined;
  const ch = await rpc('catalog.channelByNumber', { sourceId, number: n });
  if (ch) await playChannel(ch);
  return ch ?? undefined;
}

/** Testing only: reset module state. */
export function __resetPlayerForTests(): void {
  playToken = 0;
  requestSeq = 0;
  stageCount = 0;
  controller = null;
  settingsCache = null;
  settingsPromise = null;
  lastSavedPosition = -1;
  failedResolve = null;
  allowedRefKey = null;
  sourceKindCache.clear();
  stopSaver();
  if (upNextTimer) clearTimeout(upNextTimer);
  upNextTimer = null;
  upNextArmed = undefined;
  upNextHandledFor = undefined;
  clearStallTimer();
  useMediaStore.setState({ upNext: undefined, errorCode: undefined });
  usePlayerStore.setState({
    source: undefined,
    mode: 'inline',
    status: 'idle',
    error: undefined,
    isFullscreen: false,
    dock: 'hidden',
    volume: 1,
    muted: false,
    positionSeconds: 0,
    durationSeconds: undefined,
    queue: [],
    zapContext: undefined,
  });
}
