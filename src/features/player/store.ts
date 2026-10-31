/**
 * Player store (SPEC C8). One playback session per window.
 *
 * The store owns *what* plays and its observable state. Media elements (hls.js,
 * shaka, <video>, embedded mpv) register a `PlaybackController` so store actions
 * (`togglePlay`, `seekTo`, ...) drive whichever surface is active, and report
 * progress back through `reportProgress`/`reportStatus`.
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand';

import { invalidate, queryClient, rpcKey } from '@/api/query';
import type { AccountStatus } from '@/api/rpc';
import { isDesktop, rpc } from '@/api/transport';
import { QUIT_FLUSH_EVENT, type QuitFlushDetail } from '@/api/window';
import type {
  Channel,
  ItemKey,
  ItemRef,
  ItemSnapshot,
  PlaybackPosition,
  PlayerKind,
  PlayerSource,
  Settings,
  SourceKind,
  VideoPlayer,
} from '@/api/types';
import { itemKey, sameRef } from '@/api/types';
import { displayChannelName } from '@/features/live/lib/channelName';
import { finishesTitle, invalidateWatched } from '@/features/vod/lib/watchedQueries';

import { parseClearKey } from './clearKey';
import { clearCatchupResume, syncCatchupResume } from './catchupResume';
import { preloadEngineFor } from './enginePreload';
import { enterVideoFullscreen } from './fullscreen';
import { rpcErrorCode } from './errors';
import { resetMedia, showOsd, UP_NEXT_SECONDS, useMediaStore } from './media';
import { __resetNowNextForTests, fetchNowNext, holdNowNext, passNowNext, peekNowNext } from './nowNext';
import { ensurePlaybackAllowed, type PlaybackGateItem } from './parentalHook';
import { hideModeNow, lockedNow, onPlaybackHidden } from './parentalLocks';
import { reportAnswered } from './playbackReport';
import { traceTimeshift } from './timeshiftDiagnostics';

export type PlayerMode = 'inline' | 'embedded-mpv' | 'external' | 'radio';

export interface ZapContext {
  sourceId: string;
  categoryId?: string;
  /** Set when playback started from a custom list: zapping walks `lists.neighbors` (Run 2 C3). */
  listId?: string;
  /**
   * Set when playback started from favorites: zapping walks the favorites in their order, one
   * source's (`sourceId`, as `/s/:id/favorites` lists them) or every source's (`/favorites`).
   */
  favorites?: { sourceId?: string };
  /**
   * Live's or Radio's Recently watched view was open (`@recent`): the mini player's Expand goes
   * back to it (expandPath). Zapping ignores it and walks the source, since the view's order
   * changes with every play.
   */
  view?: 'recent';
}

export interface PlayerState {
  source?: PlayerSource;
  mode: PlayerMode;
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'error';
  error?: string;
  isFullscreen: boolean;
  /** Player covers the app viewport while the desktop window keeps its normal size. */
  isWindowFilled: boolean;
  dock: 'stage' | 'mini' | 'hidden';
  volume: number;
  muted: boolean;
  positionSeconds: number;
  durationSeconds?: number;
  /**
   * A step seek's target (keys, J/L, the skip buttons) not yet sent to the surface: repeated steps
   * add up here and go out as one seek (`SEEK_SETTLE_MS`). The position shows it meanwhile.
   */
  pendingSeek?: number;
  queue: PlayerSource[];
  zapContext?: ZapContext;
  /**
   * Counts the plays `play` committed. The surfaces load their media again when it changes, even
   * for the same URL (a Start over of the item playing, a recovery that resolved the same link).
   * Updates that only describe the item (a channel's new name) leave it alone, so they never
   * reload the stream.
   */
  playGeneration: number;
}

export interface PlayerActions {
  /**
   * `externalPlayer`: with `mode: 'external'`, the player to open it in (a menu's Play in MPV or
   * VLC) instead of the one in the settings. A later play of the same item in external mode
   * without one (the stage's Reopen) opens it in the same player again.
   *
   * `subtitle`: a live channel's programme title, still on its way (startItem plays without
   * waiting for it). Only the Recently watched entry waits for it.
   */
  play(
    source: PlayerSource,
    opts?: { queue?: PlayerSource[]; mode?: PlayerMode; externalPlayer?: 'mpv' | 'vlc'; subtitle?: Promise<string | undefined> },
  ): Promise<void>;
  stop(): void;
  togglePlay(): void;
  seekBy(seconds: number): void;
  /** `step`: one of a run of steps, coalesced into one seek (`pendingSeek`). */
  seekTo(seconds: number, opts?: { step?: boolean }): void;
  setVolume(v: number): void;
  adjustVolume(delta: number): void;
  toggleMute(): void;
  toggleFullscreen(): void;
  toggleWindowFill(): void;
  setDock(d: PlayerState['dock']): void;
  next(): void;
  prev(): void;
}

/** Implemented by the active media surface (inline element or embedded mpv bridge). */
export interface PlaybackController {
  play(): void;
  pause(): void;
  /** Return the position reached when the engine snaps a seek to a supported boundary. */
  seekTo(seconds: number): number | void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  /** The surface holds the media at `seconds` (shown time): a seek there asks the server for nothing. */
  holds?(seconds: number): boolean;
}

// ---------------------------------------------------------------------------
// Module state (not part of the public store shape)
// ---------------------------------------------------------------------------

const VOLUME_KEY = 'player.volume';
export const RESUME_KEY = 'player.resume';
export const SAVE_INTERVAL_MS = 5000;

let controller: PlaybackController | null = null;
/**
 * Quiet after the last step before a pending step seek goes out. Each seek past what the surface
 * holds costs a request to the provider, and a held arrow key repeats about 30 times a second.
 */
export const SEEK_SETTLE_MS = 250;
let seekTimer: ReturnType<typeof setTimeout> | null = null;
let stageCount = 0;
let saveTimer: ReturnType<typeof setInterval> | null = null;
/** Incremented per play(); play's own async steps check it to drop stale results. */
let playToken = 0;
/** Incremented by every user-level request (playItem, playSource, play, stop); pending resolutions compare it. */
let requestSeq = 0;
/** Preserve selection order when rapid VOD switches close an old mpv file. */
let pendingMpvUnload: Promise<void> = Promise.resolve();
let settingsCache: Settings | null = null;
let settingsPromise: Promise<Settings | null> | null = null;
const sourceKindCache = new Map<string, SourceKind>();
/**
 * The resolution that failed before anything could load (stream URL lookup, a queue entry):
 * Retry runs it again, since there is no media URL for the surface to reload.
 */
let failedResolve: (() => Promise<void>) | null = null;
/** The external player chosen for an item (`play`'s `externalPlayer`), which Reopen keeps using. */
let externalChoice: { source: PlayerSource; player: 'mpv' | 'vlc' } | null = null;
/**
 * The item the parental gate last let through (`itemKey` of its ref). Entry points ask the
 * gate before anything shows; `play` and queue advances only ask again when they switch to a
 * different item, so a replay, a failover to the same item or the next episode of an allowed
 * series never prompts twice.
 */
let allowedRefKey: string | null = null;
/**
 * The item (`playKey`) a Start over began, until this playback saves a position of its own. A
 * Start over leaves the saved row alone, so a recovery that looks the item up again
 * (`replayFromRef`) would otherwise resume from that old row and undo the user's choice.
 */
let startOverKey: string | null = null;
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
    !!source?.url && !!source.ref && !source.isLive && (source.ref.contentType === 'movie' || source.ref.contentType === 'series')
  );
}

/**
 * The queries that hold a movie or series row the core gave a `titleBase`: the detail pages'
 * (`{ item }`, keyed as vod/hooks/queries.ts keys them) and the bare `catalog.item` row, which
 * an m3u detail page shares (it caches the flat row and wraps it with `select`).
 */
const ITEM_ROW_QUERIES = ['xtream.vodDetail', 'xtream.seriesDetail', 'stalker.vodDetail', 'stalker.seriesDetail', 'm3u.seriesDetail', 'catalog.item'] as const;

type TitledRow = { title?: string; titleBase?: string };

/**
 * The title a saved row (Continue watching, Recent) keeps: for a movie or series the core's
 * `titleBase` when this window already has the item (the provider's language tag stripped, as
 * the detail pages show it), else the title the player shows.
 */
function snapshotTitle(source: PlayerSource & { ref: ItemRef }): string {
  const { ref, title } = source;
  if (ref.contentType !== 'movie' && ref.contentType !== 'series') return title;
  const args = { ref: { sourceId: ref.sourceId, contentType: ref.contentType, itemId: ref.itemId } };
  for (const cmd of ITEM_ROW_QUERIES) {
    const data = queryClient.getQueryData<TitledRow & { item?: TitledRow }>([cmd, args]);
    const row = data?.item ?? data;
    if (row?.titleBase && (row.title === title || row.titleBase === title)) return row.titleBase;
  }
  return title;
}

/**
 * The Recently watched entry still waiting for its channel's programme title (F2-4). The next
 * play sends it at once, without the title, so the entries keep the order the items played in.
 */
let heldRecent: (() => void) | null = null;

function addRecent(ref: ItemRef, snapshot: ItemSnapshot, subtitle?: Promise<string | undefined>): void {
  heldRecent?.();
  // No event follows recent.add and C4 caches `recent.` for 30 s: refresh the Recently watched rails.
  const send = (snap: ItemSnapshot): void => void rpc('recent.add', { ref, snapshot: snap }).then(() => invalidate('recent.'), () => undefined);
  if (!subtitle) {
    send(snapshot);
    return;
  }
  let sent = false;
  const finish = (title?: string): void => {
    if (sent) return;
    sent = true;
    if (heldRecent === flush) heldRecent = null;
    send(title ? { ...snapshot, subtitle: title } : snapshot);
  };
  const flush = (): void => finish();
  heldRecent = flush;
  void subtitle.then(finish, flush);
}

export function snapshotOf(source: PlayerSource): ItemSnapshot | undefined {
  if (!source.ref) return undefined;
  const snap: ItemSnapshot = { title: snapshotTitle({ ...source, ref: source.ref }), contentType: source.ref.contentType };
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

/** One item with its episode, as `sameSource` tells items apart. */
function playKey(ref: ItemRef, episodeId: string | undefined): string {
  return `${itemKey(ref)}|${episodeId ?? ''}`;
}

const SETTINGS_KEY = rpcKey('settings.get');

/**
 * Cached settings; refreshed by `settings.changed` (see `setSettingsCache`). Loaded through the
 * query cache, so a `useRpcQuery('settings.get')` already in flight (the shell's first paint)
 * is joined instead of asking the core a second time.
 */
export async function getSettings(): Promise<Settings | null> {
  if (settingsCache) return settingsCache;
  const known = queryClient.getQueryData<Settings>(SETTINGS_KEY);
  if (known) {
    setSettingsCache(known);
    return known;
  }
  settingsPromise ??= queryClient
    .fetchQuery({ queryKey: SETTINGS_KEY, queryFn: () => rpc('settings.get'), retry: false })
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
  // The query cache may already hold them (another reader loaded them first).
  settingsCache ??= queryClient.getQueryData<Settings>(SETTINGS_KEY) ?? null;
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

/**
 * Map `settings.player` to a mode. Radio stays in-app unless an external player is chosen. External
 * players run only in the desktop app, so in the browser a saved mpv or VLC (such as one restored from
 * a desktop backup) plays in the built-in player instead of failing every time. A ClearKey source
 * (`drm`) always plays in the built-in player: neither mpv nor VLC takes the keys.
 */
export function modeForSettings(player: VideoPlayer | undefined, source: Pick<PlayerSource, 'drm' | 'isRadio'>): PlayerMode {
  if ((player === 'mpv' || player === 'vlc') && isDesktop && !source.drm) return 'external';
  if (source.isRadio) return 'radio';
  if (player === 'embedded-mpv' && !source.drm) return 'embedded-mpv';
  return 'inline';
}

/** Catch-up is recorded live TV but uses a separate provider stream and player choice. */
export function playerForSource(
  settings: Pick<Settings, 'player' | 'livePlayer' | 'catchupPlayer' | 'vodPlayer'> | null | undefined,
  source: Pick<PlayerSource, 'catchupProgramStart' | 'isLive' | 'isRadio'>,
): VideoPlayer | undefined {
  if (!settings) return undefined;
  if (source.catchupProgramStart) return settings.catchupPlayer ?? settings.player;
  if (source.isLive || source.isRadio) return settings.livePlayer ?? settings.player;
  return settings.vodPlayer ?? settings.player;
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
  if (!isPendingZap(source)) syncCatchupResume(source, positionSeconds, mode === 'external' || isEndedState(state));
  try {
    // A zap's placeholder names a channel it has not tuned yet: the record keeps what played.
    if (isPendingZap(source)) return;
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
/**
 * The source whose last landed save finished it (Run 2 C4), so the watched queries are refetched
 * once per transition to finished, not on every later save past the end.
 */
let finishedSavedFor: PlayerSource | undefined;

const isPositionsKey = (key: readonly unknown[]) => typeof key[0] === 'string' && key[0].startsWith('positions.');

/** The latest `positions.set` sent (settled once the core has it, or the send failed). */
let lastSave: Promise<void> = Promise.resolve();

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
  return (lastSave = rpc('positions.set', args).then(
    () => {
      // A start over has its own resume point now: a recovery resumes from it.
      if (startOverKey === playKey(source.ref, source.episodeId)) startOverKey = null;
      // C4 caches `positions.` for 15 s and no event follows a save: mark it stale so Continue
      // Watching reads the new position on its next mount. No refetch now: this runs every 5 s.
      void queryClient.invalidateQueries({ predicate: (q) => isPositionsKey(q.queryKey), refetchType: 'none' });
      // The save that finishes a title makes it watched in the core (handleEnded, or a stop
      // past 95 %): refresh grid ticks, Hide watched pages and Continue Watching, which may
      // stay mounted under the mini player.
      if (!finishesTitle(pos, args.durationSeconds)) {
        finishedSavedFor = undefined; // played again from earlier: the next finish is a new transition
      } else if (finishedSavedFor !== source) {
        finishedSavedFor = source;
        void invalidateWatched();
      }
    },
    () => {
      lastSavedPosition = -1; // retry on next tick
    },
  ));
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
  isWindowFilled: false,
  dock: 'hidden',
  volume: initialVolume.volume,
  muted: initialVolume.muted,
  positionSeconds: 0,
  queue: [],
  playGeneration: 0,

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
    // Direct plays (including VOD failover) also need the previous embedded
    // file closed. The catalog/queue paths may already have started this.
    const previousUnloaded = unloadPreviousForVod(source.isLive);
    lastSavedPosition = -1;

    const settings = await getSettings();
    if (token !== playToken) return;
    const selectedPlayer = playerForSource(settings, source);
    let mode = opts?.mode ?? modeForSettings(selectedPlayer, source);
    // Embedded mpv needs the desktop shell; everywhere else the built-in player takes over. It can't
    // do ClearKey either.
    if (mode === 'embedded-mpv' && (!isDesktop || source.drm)) mode = 'inline';
    if (mode === 'embedded-mpv') {
      // So it does when mpv is known not to start this session (not found): no surface mounts to
      // fail again. Loaded here, not imported: mpvExtras reaches back into this module as it loads.
      const { mpvUnavailable } = await import('./mpvExtras');
      if (token !== playToken) return;
      if (mpvUnavailable()) mode = 'inline';
    }
    await previousUnloaded;
    if (token !== playToken) return;
    const queue = opts?.queue ?? (get().queue.some((q) => sameSource(q, source)) ? get().queue : []);

    resetMedia();
    dropPendingSeek();
    set({
      source,
      mode,
      queue,
      status: 'loading',
      error: undefined,
      positionSeconds: source.resumeSeconds ?? 0,
      durationSeconds: source.durationSeconds,
      dock: mode === 'external' ? 'hidden' : stageCount > 0 ? 'stage' : 'mini',
      isWindowFilled: mode === 'external' ? false : get().isWindowFilled,
      playGeneration: get().playGeneration + 1,
    });

    if (source.ref) {
      const snapshot = snapshotOf(source);
      if (snapshot) addRecent(source.ref, snapshot, source.subtitle ? undefined : opts?.subtitle);
    }

    if (mode === 'external') {
      stopSaver();
      clearResume();
      clearCatchupResume();
      const chosen = opts?.externalPlayer ?? (externalChoice && sameSource(externalChoice.source, source) ? externalChoice.player : undefined);
      externalChoice = chosen ? { source, player: chosen } : null;
      const player = chosen ?? (selectedPlayer === 'vlc' ? 'vlc' : 'mpv');
      // downloads: the player connects to the provider itself, so a download holding the
      // connection it needs lets go first.
      const room = reportAnswered(source);
      if (room) {
        await room;
        if (token !== playToken) return;
      }
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
    const stopped = get().source;
    if (stopped) flushProgress();
    // Once the stop's save (or a tick's still under way) has landed, refetch the positions a page
    // still shows, such as a VOD detail page behind the mini player, so it offers the new resume
    // point. The 5 s ticks only mark them stale.
    if (tracksPosition(stopped)) {
      void lastSave.then(() => queryClient.invalidateQueries({ predicate: (q) => isPositionsKey(q.queryKey), refetchType: 'active' }));
    }
    stopSaver();
    clearResume();
    lastSavedPosition = -1;
    dropPendingSeek();
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
      isWindowFilled: false,
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
      noteUserPause(true);
      controller?.pause();
      if (!controller) set({ status: 'paused' });
    } else {
      noteUserPause(false);
      controller?.play();
      if (!controller) set({ status: 'playing' });
    }
  },

  seekBy(seconds) {
    // A pending step is already the position: steps add up from it.
    const { positionSeconds } = get();
    get().seekTo(positionSeconds + seconds, { step: true });
  },

  seekTo(seconds, opts) {
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
    if (opts?.step && controller && !controller.holds?.(target)) {
      set({ positionSeconds: target, pendingSeek: target });
      if (seekTimer) clearTimeout(seekTimer);
      seekTimer = setTimeout(commitPendingSeek, SEEK_SETTLE_MS);
      if (typeof window !== 'undefined') window.addEventListener('keyup', commitPendingSeek, true);
      return;
    }
    dropPendingSeek();
    const landed = controller?.seekTo(target);
    set({ positionSeconds: typeof landed === 'number' ? landed : target });
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
    // iPhone Safari: no element fullscreen, so the video goes to the system player and the flag
    // stays off (PL-IOS-FULLSCREEN). Everywhere else the dock follows the flag (PlayerDock).
    if (!get().isFullscreen && enterVideoFullscreen()) {
      set({ isWindowFilled: false });
      return;
    }
    set({ isFullscreen: !get().isFullscreen, isWindowFilled: false });
  },

  toggleWindowFill() {
    if (!get().source || get().mode === 'external') return;
    set({ isWindowFilled: !get().isWindowFilled, isFullscreen: false });
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

/** Sends the pending step seek (`pendingSeek`) to the surface: the steps stopped, or the key came up. */
export function commitPendingSeek(): void {
  const target = usePlayerStore.getState().pendingSeek;
  dropPendingSeek();
  if (target === undefined) return;
  controller?.seekTo(target);
}

/** Forgets the pending step seek: a seek that goes out now, or a play or stop, replaces it. */
function dropPendingSeek(): void {
  if (seekTimer) clearTimeout(seekTimer);
  seekTimer = null;
  if (typeof window !== 'undefined') window.removeEventListener('keyup', commitPendingSeek, true);
  if (usePlayerStore.getState().pendingSeek !== undefined) usePlayerStore.setState({ pendingSeek: undefined });
}

export function reportProgress(positionSeconds: number, durationSeconds?: number): void {
  // Until a pending step goes out the element has not moved: its time would snap the position
  // back, and the next step would count from there.
  const pending = usePlayerStore.getState().pendingSeek;
  const patch: Partial<PlayerState> = { positionSeconds: pending ?? positionSeconds };
  if (durationSeconds !== undefined && Number.isFinite(durationSeconds) && durationSeconds > 0) {
    patch.durationSeconds = durationSeconds;
  }
  // mpv state events, and the element's `timeupdate` at a pause, repeat the last report: nothing to tell subscribers.
  const s = usePlayerStore.getState();
  if (s.positionSeconds === patch.positionSeconds && (patch.durationSeconds === undefined || patch.durationSeconds === s.durationSeconds)) return;
  usePlayerStore.setState(patch);
}

export function reportStatus(status: PlayerState['status'], error?: string): void {
  const s = usePlayerStore.getState();
  if (!s.source) return;
  // No media yet (a failed lookup): the surface's events are about the media it just dropped,
  // not this item. A zap waiting to tune keeps the last picture up under its banner: that
  // media's events are not about the channel the placeholder names either. Nor are they about a
  // movie or episode shown while the previous file closes and its URL resolves.
  if (isPendingZap(s.source) || s.source === switchPlaceholder) return;
  if (!s.source.url && status !== 'error' && status !== 'loading') return;
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
  // Mark as finished: at >= 95 % the core keeps a movie as a watched row at position = duration
  // (since Run 2; a partial replay of a watched movie keeps the flag too) and an episode as a
  // watched row at its end (C13); `withSavedPosition` never resumes from a finished row. The save's
  // success refreshes the watched queries (see `savePosition`).
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
 * event. Until the item's first frame, a timeout is raised after `LIVE_STARTUP_TIMEOUT_MS` (live)
 * or `STARTUP_TIMEOUT_MS` (VOD), whether the surface says `loading` or `paused` (a stream with
 * nothing to show can report a pause it never had); only a pause the user asked for stops it.
 * Once the item played, a re-buffer in `loading` gets `STARTUP_TIMEOUT_MS`, or the longer catch-up
 * limit for an archive programme. The timeout goes to
 * smart reconnect, which retries or switches before the error overlay shows its Retry. (The 401
 * itself is not visible from here, so this is a timeout, not an auth error; streams whose 401
 * the engine does report still classify as auth.)
 */
export const STARTUP_TIMEOUT_MS = 30_000;
export const LIVE_STARTUP_TIMEOUT_MS = 10_000;
/** Catch-up providers can take much longer to open a timeshift response or return the next chunk. */
export const CATCHUP_STARTUP_TIMEOUT_MS = 150_000;
let stallTimer: ReturnType<typeof setTimeout> | null = null;
let stallFor: string | undefined;
/** The media that showed its first frame (`playing` once), by `watchKey`. */
let startedFor: string | undefined;
/** The media the user paused (togglePlay, setPaused): its wait is not a hang. */
let userPausedFor: string | undefined;

/** The media a source plays (a title or subtitle patch is the same media); none for a zap's placeholder. */
function watchKey(s: PlayerSource | undefined): string | undefined {
  if (isPendingZap(s)) return undefined;
  return s?.url ? `${s.url}|${s.ref ? itemKey(s.ref) : ''}|${s.episodeId ?? ''}` : undefined;
}

function clearStallTimer(): void {
  if (stallTimer) clearTimeout(stallTimer);
  stallTimer = null;
  stallFor = undefined;
}

function noteUserPause(paused: boolean): void {
  userPausedFor = paused ? watchKey(usePlayerStore.getState().source) : undefined;
}

/** Waiting on media that should be coming: loading, or a first frame that never came. */
function waitingOnMedia(s: Pick<PlayerState, 'status' | 'mode'>, key: string): boolean {
  if (s.mode === 'external') return false;
  if (s.status === 'loading') return true;
  return s.status === 'paused' && startedFor !== key && userPausedFor !== key;
}

usePlayerStore.subscribe((s, prev) => {
  // A progress report (several a second) moves the position or the length of the same media in the
  // same status: nothing here changes with it, so its key is not built again (P2-PLAYER-6).
  const progress = s.positionSeconds !== prev.positionSeconds || s.durationSeconds !== prev.durationSeconds;
  if (progress && s.source === prev.source && s.status === prev.status && s.mode === prev.mode) return;
  const key = watchKey(s.source);
  if (s.status === 'playing' && key) startedFor = key;
  if (userPausedFor && userPausedFor !== key) userPausedFor = undefined;
  const watching = !!key && waitingOnMedia(s, key);
  if (watching && stallTimer && stallFor === key) return;
  clearStallTimer();
  if (!watching || !key) return;
  stallFor = key;
  const firstFrame = startedFor !== key;
  const positionAtStart = s.positionSeconds;
  stallTimer = setTimeout(
    () => {
      stallTimer = null;
      stallFor = undefined;
      const now = usePlayerStore.getState();
      if (watchKey(now.source) !== key || !waitingOnMedia(now, key)) return;
      // Some live mpv streams keep reporting pause=true while video and
      // time-pos advance. Progress over the watchdog interval is proof that
      // the first frame arrived, even when the pause flag is stale.
      if (now.mode === 'embedded-mpv' && now.source?.isLive && now.status === 'paused' &&
          now.positionSeconds > positionAtStart + 0.5 && !useMediaStore.getState().waiting) {
        startedFor = key;
        return;
      }
      traceTimeshift(now.source, 'player startup watchdog expired', { status: now.status, position: now.positionSeconds });
      useMediaStore.setState({ errorCode: 'timeout' });
      reportStatus('error', 'Timed out waiting for the stream');
    },
    s.source?.catchupProgramStart ? CATCHUP_STARTUP_TIMEOUT_MS : firstFrame && s.source?.isLive ? LIVE_STARTUP_TIMEOUT_MS : STARTUP_TIMEOUT_MS,
  );
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
  const previousUnloaded = unloadPreviousForVod(entry.isLive);
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
    await previousUnloaded;
    if (seq !== requestSeq) return;
    // The list owner may have rebuilt or refreshed the queue meanwhile: keep its newest copy.
    const latest = usePlayerStore.getState().queue;
    await usePlayerStore.getState().play(resolved, { queue: latest.some((q) => sameSource(q, entry)) ? latest : queue, mode });
  };
  if (!entry.isLive) {
    usePlayerStore.setState({ status: 'loading', error: undefined, source: vodSwitchPlaceholder({ ...entry, url: '' }) });
  } else if (!entry.url) {
    usePlayerStore.setState({ status: 'loading', error: undefined });
  }
  await run();
}

/** The movie or episode shown, without a URL, while the previous file closes and its URL resolves. */
let switchPlaceholder: PlayerSource | null = null;
function vodSwitchPlaceholder(source: PlayerSource): PlayerSource {
  switchPlaceholder = source;
  return source;
}

/** Release an embedded VOD connection while the next item's URL is resolving. */
function unloadPreviousForVod(nextIsLive: boolean): Promise<void> {
  const current = usePlayerStore.getState();
  if (nextIsLive || current.mode !== 'embedded-mpv') return Promise.resolve();
  // A rapid second selection can arrive after the first replaced the URL with
  // a placeholder but before its unload RPC has completed.
  if (!current.source?.url) return pendingMpvUnload;
  // Capture the outgoing position before mpv clears its time-pos property.
  flushProgress();
  // The subsequent mpv.load also waits for idle, so a failed early request
  // cannot cause two VOD connections to overlap.
  pendingMpvUnload = pendingMpvUnload.then(() => rpc('mpv.unload').catch(() => undefined));
  return pendingMpvUnload;
}

/** Release a failed movie/episode even when the error UI keeps its URL for Retry. */
export function releaseFailedEmbeddedVod(): void {
  const current = usePlayerStore.getState();
  const refType = current.source?.ref?.contentType;
  if (current.mode !== 'embedded-mpv' || !current.source?.url ||
      (refType !== 'movie' && refType !== 'series')) return;
  void unloadPreviousForVod(false);
  // A title that never recovered must not auto-open again on the next app launch.
  clearResume();
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
  noteUserPause(paused);
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
  dropPendingSeek();
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
  /**
   * The channel row the caller already holds (a zap's neighbour, a list click): an m3u channel
   * with its URL in the row plays without asking the catalog for the item again.
   */
  channel?: Channel;
  /**
   * Start over: play from 0 whatever was saved. Neither resume source is read (the point the
   * core puts in an Xtream stream URL, the saved position), and the saved row is left alone:
   * the watched mark stays, a failed start keeps the old resume point, and the next save of
   * this playback overwrites the position (VL-start-over-unwatches).
   */
  fromStart?: boolean;
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

/**
 * W3C Media Source Extensions with H.264 and AAC, the check mpegts.js makes before it plays live
 * TS. iPhone Safari has only ManagedMediaSource and plays HLS natively, so it counts as without.
 */
function liveTsPlayable(): boolean {
  return typeof window !== 'undefined' && typeof window.MediaSource === 'function' && window.MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"');
}

/**
 * What an Xtream live channel asks for under `streamFormat: 'auto'`: TS when the built-in player
 * plays it here (mpegts.js starts on the panel's connect burst, where hls.js first waits for the
 * playlist and a whole segment). Undefined, which the core takes as HLS, everywhere else: a
 * browser without MSE, and mpv and VLC, which keep the HLS they always got.
 */
async function autoLiveFormat(args: PlayItemArgs): Promise<'ts' | undefined> {
  if ((args.ref.contentType !== 'live' && args.ref.contentType !== 'radio') || !liveTsPlayable()) return undefined;
  const settings = peekSettings() ?? (await getSettings());
  if (settings?.streamFormat !== 'auto') return undefined;
  const mode = modeForSettings(settings.livePlayer ?? settings.player, { isRadio: !!args.isRadio });
  // play() moves embedded mpv to the built-in player outside the desktop app.
  return mode === 'inline' || mode === 'radio' || (mode === 'embedded-mpv' && !isDesktop) ? 'ts' : undefined;
}

/** Resolve a catalog item to a PlayerSource by source kind. Exported for tests. */
export async function resolveSource(args: PlayItemArgs): Promise<PlayerSource> {
  const { ref, episodeId } = args;
  let resolved: PlayerSource;
  if (args.sourceKind === 'xtream') {
    const autoFormat = await autoLiveFormat(args);
    resolved = await rpc('xtream.streamUrl', { ref, ...(episodeId ? { episodeId } : {}), ...(autoFormat ? { autoFormat } : {}) });
  } else if (args.sourceKind === 'stalker') {
    resolved = await rpc('stalker.streamUrl', episodeId ? { ref, episodeId } : { ref });
  } else if (episodeId) {
    // An m3u episode: its URL is stored in the series row (m3u.md, Series).
    resolved = await rpc('m3u.streamUrl', { ref, episodeId });
  } else {
    const known = args.channel && itemKey(args.channel.ref) === itemKey(ref) && args.channel.url ? args.channel : undefined;
    const [item, src] = await Promise.all([
      known ?? rpc('catalog.item', { ref }),
      // The source's own headers change only with an edit (`sources.changed` invalidates them).
      queryClient
        .fetchQuery({ queryKey: rpcKey('sources.get', { id: ref.sourceId }), queryFn: () => rpc('sources.get', { id: ref.sourceId }), retry: false })
        .catch(() => null),
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
    // ClearKey from the channel's #KODIPROP licence (shaka plays it; clearKey.ts).
    const drm = parseClearKey('clearKey' in item ? item.clearKey : undefined);
    if (drm) resolved.drm = drm;
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

/** `source` without a resume point: a start over plays from 0. */
function fromTheStart(source: PlayerSource): PlayerSource {
  const { resumeSeconds: _drop, ...rest } = source;
  return rest;
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

/** Share of the duration a watched movie's replay must reach before it is a resume point again. */
const REPLAY_RESUME_RATIO = 0.05;

/**
 * A watched movie replayed part-way (Run 2): the core keeps its watched flag on a partial save of
 * an item-level row and stores the replay position. That position is a resume point when the
 * duration is known and it lies between 5 % and 95 % of it; the watched tick stays. Episodes
 * lose the flag on a partial save instead, so a watched episode row is always finished.
 */
export function isWatchedReplay(
  pos: Pick<PlaybackPosition, 'positionSeconds' | 'durationSeconds'> & Partial<Pick<PlaybackPosition, 'watched' | 'episodeId' | 'ref'>>,
): boolean {
  if (pos.watched !== true || pos.episodeId || pos.ref?.contentType === 'series') return false;
  const d = pos.durationSeconds;
  return !!d && d > 0 && pos.positionSeconds >= d * REPLAY_RESUME_RATIO && !isPastEnd(pos.positionSeconds, d);
}

/** A saved row for an item that was finished or marked watched: not a resume point (but see {@link isWatchedReplay}). */
function isFinished(pos: PlaybackPosition): boolean {
  if (isWatchedReplay(pos)) return false;
  return pos.watched || isPastEnd(pos.positionSeconds, pos.durationSeconds);
}

/** The one resume rule: more than MIN_RESUME_SECONDS in, and not finished or watched (a watched movie's replay excepted). */
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
 * A play that does not walk a channel list ends list (or favorites) zapping: the next zap follows
 * the playing channel's own source, since a channel picked elsewhere may not be in the list
 * (lists.neighbors would answer not_found). Playing from a list or from favorites sets that again
 * afterwards (lists/lib/play.ts, library/lib/open.ts).
 */
function leaveListZap(ref: ItemRef): void {
  const ctx = usePlayerStore.getState().zapContext;
  if (ctx?.listId || ctx?.favorites) usePlayerStore.setState({ zapContext: { sourceId: ref.sourceId } });
}

/**
 * `playItem` with its outcome. `onAllowed` runs once the gate let the item through and before
 * anything else, so a zap's tuner readout never shows a channel the PIN prompt then refuses.
 * `keepList`: the play steps through the current channel list (a zap, the channel panel).
 */
export async function startItem(
  args: PlayItemArgs,
  opts?: {
    queue?: PlayerSource[];
    onAllowed?: () => void;
    keepList?: boolean;
    /** The subtitle, still on its way (asked in parallel with the gate and the stream lookup). */
    subtitle?: Promise<string | undefined>;
    /**
     * Told the request numbers this start takes: its own (`onRequest`, first thing), then its
     * play's (`onPlay`, as the play begins). A zap burst follows its own tune with them.
     */
    onRequest?: (seq: number) => void;
    onPlay?: (seq: number) => void;
  },
): Promise<StartOutcome> {
  const seq = ++requestSeq;
  opts?.onRequest?.(seq);
  // The engine downloads while the gate and the stream lookup run.
  preloadEngineFor(args.channel?.url);
  // The row a list click holds answers the zap banner's details (and `catalog.item`) without a
  // second lookup, as a zap's neighbour row does (F2-4).
  if (args.channel && args.isLive) rememberChannel(args.channel);
  // The user picked something: a countdown firing during the lookup must not override it.
  cancelUpNext();
  // Parental gate first, so a locked item's title never shows behind the PIN prompt.
  const gate: PlaybackGateItem = args.categoryId ? { ref: args.ref, categoryId: args.categoryId, title: args.title } : { ref: args.ref, title: args.title };
  if (!(await passGate(gate))) return seq === requestSeq ? 'refused' : 'superseded';
  if (seq !== requestSeq) return 'superseded';
  const previousUnloaded = unloadPreviousForVod(args.isLive);
  // Any other start replaces a start over's intent (a plain play of the same item resumes).
  startOverKey = args.fromStart ? playKey(args.ref, args.episodeId) : null;
  opts?.onAllowed?.();
  if (!opts?.keepList) leaveListZap(args.ref);
  const queueOpts = opts?.queue ? { queue: opts.queue } : undefined;
  const placeholder: PlayerSource = {
    url: '', kind: 'direct', title: args.title, isLive: args.isLive,
    isRadio: !!args.isRadio, ref: args.ref,
  };
  if (args.episodeId) placeholder.episodeId = args.episodeId;
  if (args.subtitle) placeholder.subtitle = args.subtitle;
  if (args.posterUrl) placeholder.posterUrl = args.posterUrl;
  usePlayerStore.setState({
    status: 'loading',
    error: undefined,
    source: args.isLive ? usePlayerStore.getState().source ?? placeholder : placeholder,
    dock: stageCount > 0 ? 'stage' : usePlayerStore.getState().dock === 'hidden' ? 'mini' : usePlayerStore.getState().dock,
  });
  let source: PlayerSource;
  try {
    const resolved = await resolveSource(args);
    source = args.fromStart ? fromTheStart(resolved) : await withResume(resolved);
  } catch (err) {
    // A newer request won the race: do not clobber it.
    if (seq !== requestSeq) return 'superseded';
    failResolve(err, placeholder, () => playItem(args, queueOpts));
    throw err;
  }
  if (seq !== requestSeq) return 'superseded';
  await previousUnloaded;
  if (seq !== requestSeq) return 'superseded';
  // The stream does not wait for the programme title (F2-4). An M3U channel with its row needs no
  // other lookup, so every tune that missed the now/next cache (a zap's own request waits for
  // the gate) waited 3-10 ms for epg.nowNext on desktop, a round trip in server mode, and longer
  // while the read pool was busy. The title lands on the source once it comes.
  const subtitle = opts?.subtitle && !source.subtitle ? opts.subtitle.catch(() => undefined) : undefined;
  const playing = usePlayerStore.getState().play(source, subtitle ? { ...queueOpts, subtitle } : queueOpts);
  // play() took its own request number before its first await.
  const playSeq = requestSeq;
  opts?.onPlay?.(playSeq);
  await playing;
  if (subtitle) await landSubtitle(source, playSeq, subtitle);
  return 'started';
}

/**
 * Puts a programme title that came after the play on the source it was asked for, while that
 * play is still the current one: the same item, no newer request, no reload. The media key does
 * not change, so nothing reloads (players.md "Loads"); a title already there (the live
 * programme follower) stays.
 */
async function landSubtitle(played: PlayerSource, playSeq: number, subtitle: Promise<string | undefined>): Promise<void> {
  const key = played.ref ? itemKey(played.ref) : undefined;
  const at = usePlayerStore.getState();
  if (!key || !at.source?.ref || itemKey(at.source.ref) !== key) return;
  const generation = at.playGeneration;
  const title = await subtitle;
  const cur = usePlayerStore.getState();
  if (!title || playSeq !== requestSeq || cur.playGeneration !== generation || !cur.source?.ref || itemKey(cur.source.ref) !== key || cur.source.subtitle) return;
  usePlayerStore.setState({ source: { ...cur.source, subtitle: title } });
}

export async function playSource(source: PlayerSource): Promise<void> {
  const seq = ++requestSeq;
  preloadEngineFor(source.url);
  cancelUpNext();
  if (source.ref && !(await passGate({ ref: source.ref, title: source.title }))) return;
  if (seq !== requestSeq) return;
  const previousUnloaded = unloadPreviousForVod(source.isLive);
  if (!source.isLive) {
    usePlayerStore.setState({ status: 'loading', error: undefined, source: vodSwitchPlaceholder({ ...source, url: '' }) });
  }
  const withPos = await withResume(source);
  if (seq !== requestSeq) return;
  await previousUnloaded;
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

/**
 * Title of the programme airing now on `ref`, if the guide has one. Shares the player's one
 * now/next cache (`nowNext.ts`) with the zap banner, so a zap asks the guide once.
 */
export async function nowTitle(ref: ItemRef): Promise<string | undefined> {
  return (await fetchNowNext(ref))?.now?.title || undefined;
}

/** The airing title when the now/next cache already has it; `undefined` when it has to ask. */
function peekNowTitle(ref: ItemRef): string | null | undefined {
  const hit = peekNowNext(ref);
  return hit === undefined ? undefined : hit?.now?.title || null;
}

/** The name the live views show for `channel` (`settings.stripCountryPrefix`). */
function channelTitle(channel: Channel, settings: Settings | null): string {
  return displayChannelName(channel.name, settings?.stripCountryPrefix) || channel.name;
}

/**
 * Zap/remote/fullscreen-panel path. Titles the player, OSD and resume record with the name the
 * live views show (`settings.stripCountryPrefix`) and subtitles it with the airing programme,
 * like the list click path.
 */
export async function playChannel(channel: Channel, sourceKind?: SourceKind, opts?: { keepList?: boolean }): Promise<void> {
  await tuneChannel(channel, sourceKind, opts?.keepList ? { keepList: true } : {});
}

/**
 * Channels this session learned from neighbour lookups and zaps, so the zap banner and the
 * stream URL lookup do not ask the catalog for them again. Dropped on a channel edit. Each row
 * also answers `catalog.item` for its channel in the query cache (the live page asks it for the
 * playing channel), unless that holds a row already.
 */
const knownChannels = new Map<string, Channel>();
const KNOWN_CHANNELS_MAX = 256;

function rememberChannel(ch: Channel): void {
  const key = itemKey(ch.ref);
  knownChannels.delete(key);
  knownChannels.set(key, ch);
  const itemQuery = rpcKey('catalog.item', { ref: ch.ref });
  if (queryClient.getQueryData(itemQuery) === undefined) queryClient.setQueryData(itemQuery, ch);
  while (knownChannels.size > KNOWN_CHANNELS_MAX) {
    const oldest = knownChannels.keys().next().value;
    if (oldest === undefined) break;
    knownChannels.delete(oldest);
  }
}

/** A channel row this session already has (number, logo, name), without asking the catalog. */
export function knownChannel(ref: ItemRef): Channel | undefined {
  return knownChannels.get(itemKey(ref));
}

/** A channel edit on `sourceId` (or anywhere): the rows held for it are out of date. */
export function forgetKnownChannels(sourceId?: string): void {
  if (!sourceId) {
    knownChannels.clear();
    return;
  }
  for (const [key, ch] of knownChannels) if (ch.ref.sourceId === sourceId) knownChannels.delete(key);
}

/**
 * A channel edit on `sourceId` (a rename): the playing channel's title follows, so the player's
 * title and the zap banner stop showing the old name.
 */
export async function refreshPlayingChannel(sourceId?: string): Promise<void> {
  const s = usePlayerStore.getState().source;
  const ref = s?.ref;
  if (!s || !ref || !s.isLive || (sourceId && ref.sourceId !== sourceId)) return;
  if (ref.contentType !== 'live' && ref.contentType !== 'radio') return;
  let name: string | undefined;
  try {
    const item = await queryClient.fetchQuery({
      queryKey: rpcKey('catalog.item', { ref }),
      queryFn: () => rpc('catalog.item', { ref }),
      staleTime: 0,
      retry: false,
    });
    name = 'name' in item && typeof item.name === 'string' ? item.name : undefined;
  } catch {
    return;
  }
  const cur = usePlayerStore.getState().source;
  if (!name || !cur?.ref || itemKey(cur.ref) !== itemKey(ref)) return;
  const title = displayChannelName(name, peekSettings()?.stripCountryPrefix) || name;
  if (title !== cur.title) usePlayerStore.setState({ source: { ...cur, title } });
}

/**
 * Starts the playing item again from its ref, asking for its stream anew: what a plain retry
 * cannot do, since that reloads the same URL. For the error screen's actions that change what
 * the lookup answers (a refreshed source, the Xtream stream format switched to HLS). A channel
 * row this session holds may carry the old URL, so it is read again from the catalog. Keeps the
 * queue, and a Start over that has not saved a position of its own starts from 0 again.
 *
 * `from` is where the recovery began (`recoveryPoint`, taken as the user pressed the action):
 * the item it replays, and the request it may replace. A Stop or any newer play since then
 * (taken while the setting or the source refresh was on its way, or while this looks the item
 * up) wins, and the recovery gives up. False then, when there is no ref to look up, or when the
 * lookup fails.
 */
export async function replayFromRef(from: RecoveryPoint | null = recoveryPoint()): Promise<boolean> {
  const src = from?.source;
  const ref = src?.ref;
  if (!from || !src || !ref || !recoveryCurrent(from)) return false;
  try {
    const kind = await sourceKindOf(ref.sourceId);
    if (!recoveryCurrent(from)) return false;
    if (src.isLive && (ref.contentType === 'live' || ref.contentType === 'radio')) {
      knownChannels.delete(itemKey(ref));
      const item = await rpc('catalog.item', { ref });
      if (!('isRadio' in item)) return false;
      const settings = peekSettings() ?? (await getSettings());
      // With the settings and the kind in hand, the tune claims its request at once.
      if (!recoveryCurrent(from)) return false;
      await tuneChannel(item, kind, { keepList: from.listZap, settings });
      return true;
    }
    const args: PlayItemArgs = { ref, title: src.title, isLive: src.isLive, isRadio: src.isRadio, sourceKind: kind };
    if (src.episodeId) args.episodeId = src.episodeId;
    if (src.subtitle) args.subtitle = src.subtitle;
    if (src.posterUrl) args.posterUrl = src.posterUrl;
    if (startOverKey === playKey(ref, src.episodeId)) args.fromStart = true;
    await startItem(args, from.queue.length ? { queue: from.queue } : undefined);
    return true;
  } catch {
    return false;
  }
}

/** Where a recovery action began: the item on screen and the request it may replace. */
export interface RecoveryPoint {
  readonly seq: number;
  readonly source: PlayerSource;
  readonly queue: PlayerSource[];
  /** Zapping walked a channel list: the replayed channel keeps walking it. */
  readonly listZap: boolean;
}

/** The recovery point for what is on screen now (none when nothing is). */
export function recoveryPoint(): RecoveryPoint | null {
  const s = usePlayerStore.getState();
  return s.source ? { seq: requestSeq, source: s.source, queue: s.queue, listZap: !!s.zapContext?.listId } : null;
}

/** No Stop and no newer play since `from` was taken: its recovery may still start the item. */
export function recoveryCurrent(from: RecoveryPoint): boolean {
  return from.seq === requestSeq;
}

interface TuneOptions {
  /** The play steps through the current channel list (a zap, the channel panel). */
  keepList?: boolean;
  /** Show the tuner readout once the gate lets the channel through (asked then); default yes. */
  readout?: boolean | (() => boolean);
  /** Settings already read (a zap reads them before it claims its request). */
  settings?: Settings | null;
  onRequest?: (seq: number) => void;
  onPlay?: (seq: number) => void;
}

/** `playChannel` with its outcome: a zap steps past a channel the parental gate refused. */
async function tuneChannel(channel: Channel, sourceKind?: SourceKind, opts: TuneOptions = {}): Promise<StartOutcome> {
  preloadEngineFor(channel.url);
  rememberChannel(channel);
  const settings = opts.settings !== undefined ? opts.settings : (peekSettings() ?? (await getSettings()));
  const name = channelTitle(channel, settings);
  const kind = sourceKind ?? knownSourceKind(channel.ref.sourceId) ?? (await sourceKindOf(channel.ref.sourceId));
  // The guide is asked alongside the gate and the stream lookup, not before them (a zap's
  // press already asked it, so this is usually a cache hit).
  const cached = peekNowTitle(channel.ref);
  const args: PlayItemArgs = {
    ref: channel.ref,
    title: name,
    isLive: true,
    isRadio: channel.isRadio,
    sourceKind: kind,
    channel,
  };
  if (channel.categoryId) args.categoryId = channel.categoryId;
  if (channel.logoUrl) args.posterUrl = channel.logoUrl;
  if (cached) args.subtitle = cached;
  // Tuner readout: number big, name below. Only once the gate let the channel through, so a
  // cancelled PIN prompt leaves no locked channel's name on screen.
  const { readout = true, keepList = false, onRequest, onPlay } = opts;
  return startItem(args, {
    onAllowed: () => {
      passNowNext(channel.ref);
      if (typeof readout === 'function' ? readout() : readout) showZapReadout(channel, name);
    },
    keepList,
    ...(cached === undefined ? { subtitle: nowTitle(channel.ref) } : {}),
    ...(onRequest ? { onRequest } : {}),
    ...(onPlay ? { onPlay } : {}),
  });
}

/** Tuner readout: number big, name below. `locked`: a locked channel the zap is passing. */
function showZapReadout(channel: Channel, name: string, locked = false): void {
  showOsd(
    channel.number !== undefined ? String(channel.number) : name,
    channel.number !== undefined ? name : undefined,
    locked ? { locked: true } : undefined,
  );
}

/**
 * The channel a zap steps from: live TV, or catch-up of a live channel (a zap there leaves the
 * archive for the neighbour's live stream).
 */
function currentZapRef(): ItemRef | undefined {
  const { source } = usePlayerStore.getState();
  if (!source?.ref) return undefined;
  if (source.isLive || source.ref.contentType === 'live') return source.ref;
  return undefined;
}

/** Channel up/down applies to what plays now (live TV, or catch-up of a channel). */
export function canZap(s: Pick<PlayerState, 'source'>): boolean {
  return !!s.source?.ref && (s.source.isLive || s.source.ref.contentType === 'live');
}

/** Most neighbours one zap press looks at while stepping past refused or locked channels. */
export const ZAP_SKIP_LIMIT = 50;
/**
 * Quiet time that ends a burst of channel up/down presses. A press on its own tunes at once
 * (on a source that allows one connection it too waits for quiet); presses that follow within
 * this time move the banner at once but wait for quiet to tune, so only the channel the burst
 * stops on opens a stream.
 */
export const ZAP_SETTLE_MS = 250;
/** Neighbour answers are reused this long (channel edits and imports invalidate them sooner). */
const NEIGHBOURS_STALE_MS = 30_000;

type Neighbours = { prev?: Channel | null; next?: Channel | null };

function neighboursKey(ref: ItemRef, ctx: ZapContext | undefined): readonly unknown[] {
  if (ctx?.listId) return rpcKey('lists.neighbors', { id: ctx.listId, ref });
  const args: { ref: ItemRef; categoryId?: string } = { ref };
  if (ctx?.categoryId && ctx.sourceId === ref.sourceId) args.categoryId = ctx.categoryId;
  return rpcKey('catalog.neighbors', args);
}

/** A favorite's channel: one this session knows, else `catalog.item`; undefined when the catalog no longer has it. */
async function favoriteChannel(ref: ItemRef): Promise<Channel | undefined> {
  const known = knownChannels.get(itemKey(ref));
  if (known) return known;
  try {
    const item = await queryClient.fetchQuery({
      queryKey: rpcKey('catalog.item', { ref }),
      queryFn: () => rpc('catalog.item', { ref }),
      staleTime: NEIGHBOURS_STALE_MS,
      retry: false,
    });
    return 'isRadio' in item ? item : undefined;
  } catch {
    return undefined;
  }
}

/** A favorite's place in the stored order, as `favorites.list` sorts it. */
type FavoriteSlot = { position: number; addedAt: string };

const favoriteOrder = (a: FavoriteSlot, b: FavoriteSlot): number => a.position - b.position || a.addedAt.localeCompare(b.addedAt);

/**
 * The place of the favorite `favoriteNeighbours` last found in the list. A filter can take the
 * playing favorite out of `favorites.list` afterwards (the Live TV quality filter, a channel
 * edit, parental hide mode); zapping from it then steps from this place.
 */
let favoriteSlot: (FavoriteSlot & { key: ItemKey }) | null = null;

/** Whether `ref` is a favorite, shown or not (`favorites.contains` reads every stored row). */
async function isStoredFavorite(ref: ItemRef): Promise<boolean> {
  const args = { refs: [ref] };
  const present = await queryClient.fetchQuery({
    queryKey: rpcKey('favorites.contains', args),
    queryFn: () => rpc('favorites.contains', args),
    staleTime: NEIGHBOURS_STALE_MS,
    retry: false,
  });
  return present.length > 0;
}

/**
 * The channels either side of `ref` in favorites order (the `favorites.list` the Favorites page
 * shows, so its reorders apply at once), among favorites of the same type (live or radio). It
 * wraps like catalog.neighbors and steps over favorites the catalog no longer has. A favorite
 * the list now leaves out (a filter hides it) is placed where it was last seen, so its
 * neighbours are the nearest favorites shown. Undefined when `ref` is not a favorite, or is
 * hidden and was never seen in the list.
 */
async function favoriteNeighbours(ref: ItemRef, scope: { sourceId?: string }): Promise<Neighbours | undefined> {
  const args = scope.sourceId ? { sourceId: scope.sourceId } : {};
  const entries = await queryClient.fetchQuery({
    queryKey: rpcKey('favorites.list', args),
    queryFn: () => rpc('favorites.list', args),
    staleTime: NEIGHBOURS_STALE_MS,
    retry: false,
  });
  const sorted = entries.filter((e) => e.ref.contentType === ref.contentType).sort(favoriteOrder);
  const refs = sorted.map((e) => e.ref);
  const key = itemKey(ref);
  let at = refs.findIndex((r) => sameRef(r, ref));
  if (at >= 0) {
    const { position, addedAt } = sorted[at]!;
    favoriteSlot = { key, position, addedAt };
  } else {
    const slot = favoriteSlot?.key === key ? favoriteSlot : null;
    if (!slot || !(await isStoredFavorite(ref))) return undefined;
    at = sorted.findIndex((e) => favoriteOrder(e, slot) > 0);
    if (at < 0) at = refs.length;
    refs.splice(at, 0, ref);
  }
  const step = async (dir: 1 | -1): Promise<Channel | undefined> => {
    for (let i = 1; i < refs.length; i++) {
      const ch = await favoriteChannel(refs[(at + dir * i + refs.length) % refs.length]!);
      if (ch) return ch;
    }
    return undefined;
  };
  const [prev, next] = await Promise.all([step(-1), step(1)]);
  return { prev, next };
}

/**
 * The channels either side of `ref` in the zap context: a channel list's order (across
 * sources), the favorites' order, else the source's (or its category's). Answers sit in the
 * query cache, where channel edits, list and favorite writes and imports invalidate them
 * (`catalog.`, `lists.`, `favorites.` prefixes).
 */
async function neighboursOf(ref: ItemRef): Promise<Neighbours> {
  let ctx = usePlayerStore.getState().zapContext;
  const favorites = ctx?.favorites;
  if (favorites) {
    const res = await favoriteNeighbours(ref, favorites);
    if (res) return res;
    // No longer a favorite (removed meanwhile): zap through its source instead.
    ctx = { sourceId: ref.sourceId };
    if (usePlayerStore.getState().zapContext?.favorites === favorites) usePlayerStore.setState({ zapContext: ctx });
  }
  if (ctx?.listId) {
    const listId = ctx.listId;
    try {
      return await queryClient.fetchQuery({
        queryKey: neighboursKey(ref, ctx),
        queryFn: () => rpc('lists.neighbors', { id: listId, ref }),
        staleTime: NEIGHBOURS_STALE_MS,
        retry: false,
      });
    } catch (err) {
      if (rpcErrorCode(err) !== 'not_found') throw err;
      // The list was deleted, or no longer holds this channel: zap through its source instead.
      ctx = { sourceId: ref.sourceId };
      if (usePlayerStore.getState().zapContext?.listId === listId) usePlayerStore.setState({ zapContext: ctx });
    }
  }
  const key = neighboursKey(ref, ctx);
  const args = key[1] as { ref: ItemRef; categoryId?: string };
  return queryClient.fetchQuery({
    queryKey: key,
    queryFn: () => rpc('catalog.neighbors', args),
    staleTime: NEIGHBOURS_STALE_MS,
    retry: false,
  });
}

/** After a tune: the next press either way finds its neighbour without a round trip. */
function prefetchNeighbours(ref: ItemRef): void {
  void neighboursOf(ref)
    .then((res) => {
      for (const ch of [res?.prev, res?.next]) if (ch) rememberChannel(ch);
    })
    .catch(() => undefined);
}

/**
 * After any live tune (a click on a row, a zap, the history, a remote), the channels either side
 * are asked for as soon as the tune is done (and the page set its zap context), so the first
 * channel up/down after it comes from the cache.
 */
let prefetchTimer: ReturnType<typeof setTimeout> | null = null;

function prefetchAfterTune(): void {
  prefetchTimer = null;
  const s = usePlayerStore.getState();
  const src = s.source;
  if (!src?.ref || !src.url || isPendingZap(src) || s.status === 'error' || !canZap(s)) return;
  prefetchNeighbours(src.ref);
  void prefetchConnectionLimit(src.ref.sourceId);
}

/** How long a known account status counts for the zap (the multi-view banner keeps it as long). */
const ACCOUNT_STALE_MS = 60_000;

/** `account.status` for a source: the multi-view's connection banner reads the same entry. */
function accountKey(sourceId: string): readonly unknown[] {
  return rpcKey('account.status', { sourceId });
}

/** How soon an empty or failed answer is asked again (the core is asking the panel meanwhile). */
const ACCOUNT_RETRY_MS = 2_000;

/**
 * A zap on this source opens only the channel a burst stops on: it allows one connection at a
 * time (an Xtream panel's `user_info.max_connections` of 1, the account status the core keeps),
 * or it is an Xtream source whose status is not known yet. Other kinds report no limit.
 */
function holdsZapTune(sourceId: string): boolean {
  const status = queryClient.getQueryData<AccountStatus | null>(accountKey(sourceId));
  if (status) return status.maxConnections === 1;
  return knownSourceKind(sourceId) === 'xtream';
}

/**
 * Asks for an Xtream source's account status ahead of the next zap, so its presses know the
 * connection limit. The core answers from its cache; it has none before its first check (which
 * it starts then), so an empty answer is asked again on a tune or press ACCOUNT_RETRY_MS later.
 * Resolves when the answer is in (joining the request under way, if any); undefined when none
 * is asked.
 */
function prefetchConnectionLimit(sourceId: string): Promise<unknown> | undefined {
  if (knownSourceKind(sourceId) !== 'xtream') return undefined;
  const state = queryClient.getQueryState<AccountStatus | null>(accountKey(sourceId));
  if (state && state.fetchStatus !== 'fetching') {
    const now = Date.now();
    if (state.data && now - state.dataUpdatedAt < ACCOUNT_STALE_MS) return undefined;
    if (!state.data && now - Math.max(state.dataUpdatedAt, state.errorUpdatedAt) < ACCOUNT_RETRY_MS) return undefined;
  }
  return queryClient
    .fetchQuery({ queryKey: accountKey(sourceId), queryFn: () => rpc('account.status', { sourceId }), staleTime: 0, retry: false })
    .catch(() => undefined);
}

usePlayerStore.subscribe((s, prev) => {
  if ((s.source === prev.source && s.zapContext === prev.zapContext) || prefetchTimer) return;
  prefetchTimer = setTimeout(prefetchAfterTune, 0);
});

/** A run of channel up/down presses, up to the tune it settles on. */
interface ZapBurst {
  /** Where the burst started (the channel playing before the first press). */
  origin: ItemRef;
  direction: 'up' | 'down';
  /** The channel the presses so far land on. */
  target: Channel;
  /** Presses so far: a placeholder or a tune belongs to the press it was made for. */
  press: number;
  /** The latest target put on screen (never a locked one): the fallback when the tune is refused. */
  shown?: Channel;
  /**
   * `requestSeq` the burst holds: its latest press's, then its own tune's (a tune takes request
   * numbers too). Any other request since (a click, Stop) ends the burst.
   */
  seq: number;
  /** ZAP_SETTLE_MS passed without a press: the next press starts a new burst. */
  quiet: boolean;
  /** The press whose tune is under way. */
  tuning: number | null;
  /** The press whose tune began to play (or kept the picture that was up). */
  tunedPress: number | null;
  /** Where the latest finished tune landed, and for which press. */
  landed?: { press: number; channel: Channel | undefined };
  timer: ReturnType<typeof setTimeout> | null;
  done: Promise<Channel | undefined>;
  finish(ch: Channel | undefined): void;
}

let burst: ZapBurst | null = null;
/** Presses step one after another, each from the channel the one before landed on. */
let zapQueue: Promise<unknown> = Promise.resolve();
/** Presses waiting in `zapQueue`: a press with more behind it does not tune on its own. */
let queuedPresses = 0;
/** Placeholders a zap shows while it waits to tune (not a visit or a play of their channel). */
const pendingSources = new WeakSet<PlayerSource>();
/** Placeholders that name a locked channel the zap is passing (parental Ask mode). */
const lockedSources = new WeakSet<PlayerSource>();

/** The item a placeholder took the place of (whose picture it keeps up, if it had one), as it was. */
interface HeldItem {
  source: PlayerSource;
  status: PlayerState['status'];
  error?: string;
}
const heldItems = new WeakMap<PlayerSource, HeldItem>();

/** True for the placeholder a channel zap shows while its burst waits to tune. */
export function isPendingZap(source: PlayerSource | undefined): boolean {
  return !!source && pendingSources.has(source);
}

/**
 * True for a zap placeholder that names a locked channel (parental Ask mode): its number and
 * name show with a lock, without its logo or guide, until the PIN prompt lets it through.
 */
export function isLockedZap(source: PlayerSource | undefined): boolean {
  return !!source && lockedSources.has(source);
}

function owns(b: ZapBurst): boolean {
  return b.seq === requestSeq;
}

/** Press `press` is still the burst's latest, and nothing else took over. */
function current(b: ZapBurst, press: number): boolean {
  return burst === b && b.press === press && owns(b);
}

function newBurst(origin: ItemRef, direction: 'up' | 'down', target: Channel): ZapBurst {
  let finish: (ch: Channel | undefined) => void = () => undefined;
  const done = new Promise<Channel | undefined>((resolve) => {
    finish = resolve;
  });
  return { origin, direction, target, press: 0, seq: 0, quiet: false, tuning: null, tunedPress: null, timer: null, done, finish };
}

function endBurst(b: ZapBurst, ch: Channel | undefined): void {
  if (b.timer) clearTimeout(b.timer);
  b.timer = null;
  if (burst === b) burst = null;
  b.finish(ch);
}

function gateItemOf(ch: Channel): PlaybackGateItem {
  return ch.categoryId ? { ref: ch.ref, categoryId: ch.categoryId } : { ref: ch.ref };
}

/** The item on screen before the zap's placeholders: the current one, or the one they replaced. */
function itemOnScreen(): HeldItem | undefined {
  const { source, status, error } = usePlayerStore.getState();
  if (!source) return undefined;
  if (pendingSources.has(source)) return heldItems.get(source);
  return error === undefined ? { source, status } : { source, status, error };
}

/** Put back the item the placeholder on screen took the place of. */
function putBackHeld(): boolean {
  const cur = usePlayerStore.getState().source;
  const held = cur && pendingSources.has(cur) ? heldItems.get(cur) : undefined;
  if (!held) return false;
  usePlayerStore.setState({ source: held.source, status: held.status, error: held.error });
  return true;
}

/**
 * Put a burst's target on screen at once: the player's title, the zap banner and the tuner
 * readout move to it, over the picture that was up. That picture plays on until the new
 * channel is tuned, so there is no black gap, and zapping straight back keeps it. A locked
 * channel (Ask mode) shows its number and name with a lock, without logo or guide; Hide mode
 * never names it.
 */
async function showZapTarget(b: ZapBurst, target: Channel, press: number): Promise<void> {
  const locked = await lockedNow(gateItemOf(target));
  if (locked && (await hideModeNow())) return;
  // A later press, another request, or this press's own tune got there first.
  if (!current(b, press) || b.tunedPress === press) return;
  if (!locked) b.shown = target;
  const name = channelTitle(target, peekSettings());
  const held = itemOnScreen();
  // The picture to keep up: the item's stream, unless it failed (its error goes with it).
  const media = held?.source.url && held.status !== 'error' ? held.source : undefined;
  const placeholder: PlayerSource = {
    url: media?.url ?? '',
    kind: media?.kind ?? 'direct',
    title: name,
    isLive: true,
    isRadio: !!target.isRadio,
    ref: target.ref,
  };
  // The surfaces key their media on these: the same values keep the picture.
  if (media?.headers) placeholder.headers = media.headers;
  if (media?.episodeId) placeholder.episodeId = media.episodeId;
  if (held) heldItems.set(placeholder, held);
  if (locked) {
    lockedSources.add(placeholder);
  } else {
    if (target.logoUrl) placeholder.posterUrl = target.logoUrl;
    const subtitle = peekNowTitle(target.ref);
    if (subtitle) placeholder.subtitle = subtitle;
  }
  pendingSources.add(placeholder);
  failedResolve = null;
  usePlayerStore.setState({
    source: placeholder,
    status: 'loading',
    error: undefined,
    positionSeconds: 0,
    durationSeconds: undefined,
    dock: stageCount > 0 ? 'stage' : usePlayerStore.getState().dock === 'hidden' ? 'mini' : usePlayerStore.getState().dock,
  });
  showZapReadout(target, name, locked);
}

/** One press: step from where the burst stands, show the new target, and tune or wait for quiet. */
async function stepZap(direction: 'up' | 'down'): Promise<ZapBurst | undefined> {
  queuedPresses = Math.max(0, queuedPresses - 1);
  // A burst that went quiet may still be tuning; it ends itself when this press takes over.
  const prior = burst && owns(burst) ? burst : null;
  if (burst && !prior) endBurst(burst, undefined); // another request took over while it waited
  let live = prior && !prior.quiet ? prior : null;
  const from = live?.target.ref ?? currentZapRef();
  if (!from) return undefined;
  const seq = requestSeq;
  const res = await neighboursOf(from);
  // Only the burst's own tune may have moved requestSeq on meanwhile.
  if (prior ? !owns(prior) : seq !== requestSeq) {
    if (live) endBurst(live, undefined);
    return undefined;
  }
  // It went quiet while the lookup ran (and tuned): this press starts a new burst from there.
  if (live && (live.quiet || burst !== live)) live = null;
  const target = direction === 'up' ? res.prev : res.next;
  // The end of the list: earlier presses still land where they were.
  if (!target) return live ?? undefined;
  for (const ch of [res.prev, res.next]) if (ch) rememberChannel(ch);
  const fresh = !live;
  const b = live ?? newBurst(from, direction, target);
  b.direction = direction;
  b.target = target;
  b.press++;
  b.quiet = false;
  // Supersedes the burst's own tune for an earlier press while that has not started playing.
  b.seq = ++requestSeq;
  burst = b;
  cancelUpNext();
  if (b.timer) clearTimeout(b.timer);
  b.timer = setTimeout(() => onQuiet(b), ZAP_SETTLE_MS);
  // A press on its own tunes at once, unless the source allows one connection: a press that
  // follows within ZAP_SETTLE_MS would open a second stream while the provider still counts the
  // first (panels keep a closed one counted for a while), so there the burst opens only the
  // channel it stops on, after the quiet. An Xtream source whose limit is not known yet waits the
  // same way while its status is asked; a press on its own tunes once the answer allows more than
  // one (before the quiet, if no press came meanwhile). The guide answer the banner and the tune
  // both use: one a view already holds, else asked now for a press that tunes at once, and for
  // the others once the burst stops on them (not for each channel it passes).
  const sourceId = target.ref.sourceId;
  const alone = fresh && queuedPresses === 0;
  const tunesNow = alone && !holdsZapTune(sourceId);
  const limit = prefetchConnectionLimit(sourceId);
  // Its guide is asked now too, as for a press that tunes at once.
  const awaitsLimit = alone && !tunesNow && !!limit;
  if (awaitsLimit) {
    const press = b.press;
    void limit.then(() => {
      if (current(b, press) && !b.quiet && b.tuning === null && b.tunedPress === null && queuedPresses === 0 && !holdsZapTune(sourceId)) void runTune(b, press);
    });
  }
  if (!tunesNow && !awaitsLimit && peekNowNext(target.ref) === undefined) holdNowNext(target.ref, ZAP_SETTLE_MS);
  void fetchNowNext(target.ref);
  // Nothing on screen moves when the parental lookup fails: the tune asks the gate itself.
  void showZapTarget(b, target, b.press).catch(() => undefined);
  preloadEngineFor(target.url);
  // The next press in this burst steps from the target without a round trip.
  prefetchNeighbours(target.ref);
  // One with more presses queued behind it, and presses that follow it within ZAP_SETTLE_MS, wait
  // for quiet: the channels passed never open a stream.
  if (tunesNow) void runTune(b, b.press);
  return b;
}

/** ZAP_SETTLE_MS without a press: tune where the burst stopped, unless its tune covers that already. */
function onQuiet(b: ZapBurst): void {
  b.timer = null;
  b.quiet = true;
  if (burst !== b || !owns(b)) return endBurst(b, undefined);
  // That tune ends the burst when it is done.
  if (b.tuning === b.press) return;
  if (b.landed?.press === b.press) return endBurst(b, b.landed.channel);
  void runTune(b, b.press);
}

/** A tune for press `press` is done (`channel`: where it started playing, if anywhere). */
function landed(b: ZapBurst, press: number, channel: Channel | undefined): void {
  b.landed = { press, channel };
  if (b.quiet && b.press === press) endBurst(b, channel);
}

/** A tune gave way: to a later press of its burst (which carries on), or to another request. */
function gaveWay(b: ZapBurst): void {
  if (burst !== b || !owns(b)) endBurst(b, undefined);
}

/**
 * Back on the channel whose picture the placeholder still shows (zapped away and straight
 * back): that item comes back as it was, without a new stream or a Recent row.
 */
function keepHeld(b: ZapBurst, press: number, target: Channel): boolean {
  const cur = usePlayerStore.getState().source;
  const held = cur && pendingSources.has(cur) ? heldItems.get(cur) : undefined;
  // Only while its picture is still up (a failed item's was dropped: that one tunes again).
  if (!held?.source.ref || !cur?.url || itemKey(held.source.ref) !== itemKey(target.ref) || !current(b, press)) return false;
  b.tunedPress = press;
  return putBackHeld();
}

/**
 * `tuneChannel` for a burst's press. The burst follows the tune's own request numbers, so it
 * stays the burst (later presses still wait for quiet). Null: a later press or another request
 * came first.
 */
async function tuneZapTarget(b: ZapBurst, press: number, target: Channel, readout: TuneOptions['readout']): Promise<StartOutcome | null> {
  // Read first, so nothing runs between the check below and the tune's request.
  const settings = peekSettings() ?? (await getSettings());
  const kind = knownSourceKind(target.ref.sourceId) ?? (await sourceKindOf(target.ref.sourceId));
  if (!current(b, press)) return null;
  return tuneChannel(target, kind, {
    // A zap walks the list it is in, so it keeps the list.
    keepList: true,
    readout,
    settings,
    onRequest: (seq) => {
      if (b.seq === seq - 1) b.seq = seq;
    },
    onPlay: (seq) => {
      if (b.seq !== seq - 1) return;
      b.seq = seq;
      b.tunedPress = press;
    },
  });
}

/**
 * Tune the channel press `press` landed on. Back on the channel whose picture is still up, that
 * picture stays. When the parental gate refuses the channel (its PIN prompt was cancelled), the
 * zap goes on in the same direction, so a locked channel never walls off the rest of the list.
 * Past that first refusal it steps over locked channels without asking again (one prompt per
 * burst), and it stops when it comes round to a channel it already saw or after ZAP_SKIP_LIMIT
 * steps.
 */
async function runTune(b: ZapBurst, press: number): Promise<void> {
  b.tuning = press;
  try {
    let target = b.target;
    if (keepHeld(b, press, target)) return landed(b, press, target);
    const seen = new Set<string>([itemKey(b.origin), itemKey(target.ref)]);
    for (let step = 0; step < ZAP_SKIP_LIMIT; step++) {
      if (step > 0) {
        const res = await neighboursOf(target.ref);
        if (!current(b, press)) return gaveWay(b);
        const next = b.direction === 'up' ? res.prev : res.next;
        if (!next || seen.has(itemKey(next.ref))) break;
        seen.add(itemKey(next.ref));
        target = next;
        const locked = await lockedNow(gateItemOf(target));
        if (!current(b, press)) return gaveWay(b);
        if (locked) continue;
      }
      // The burst already put this channel's readout up (and the banner took its place).
      const tuned = target;
      const outcome = await tuneZapTarget(b, press, tuned, () => !b.shown || itemKey(b.shown.ref) !== itemKey(tuned.ref));
      if (outcome === 'started') return landed(b, press, tuned);
      if (outcome !== 'refused') return gaveWay(b);
    }
    // Nothing started. The placeholder on screen is not tuned: tune the last channel shown (never
    // a locked one), else put back what played, rather than leave the player waiting on nothing.
    const shown = b.shown;
    if (isPendingZap(usePlayerStore.getState().source) && current(b, press)) {
      if (shown && keepHeld(b, press, shown)) return landed(b, press, shown);
      const outcome = shown ? await tuneZapTarget(b, press, shown, false) : 'refused';
      if (outcome === 'started' && shown) return landed(b, press, shown);
      if (outcome !== 'refused') return gaveWay(b);
      if (current(b, press)) putBackHeld();
    }
    landed(b, press, undefined);
  } catch (err) {
    if (!current(b, press)) return gaveWay(b);
    landed(b, press, undefined);
    // A lookup failed with the placeholder still up: show the error on it (without the picture it
    // kept), and let Retry tune the channel it names. A failed stream lookup did this in startItem.
    const s = usePlayerStore.getState().source;
    const named = b.shown ?? b.target;
    if (s && isPendingZap(s)) {
      const { headers: _headers, episodeId: _episode, ...rest } = s;
      failResolve(err, { ...rest, url: '', kind: 'direct' }, async () => {
        await tuneChannel(named, undefined, { keepList: true });
      });
    }
  } finally {
    if (b.tuning === press) b.tuning = null;
  }
}

/**
 * Move to the neighbour channel in the current list context. Resolves with the channel the
 * burst this press belongs to tuned, if any.
 *
 * Presses step at once, one after another (N presses land N channels away), and each one
 * moves the title, banner and readout to its target over the picture still playing. A press on
 * its own tunes at once (except on a one-connection source, or an Xtream one whose limit is not
 * known yet: that one tunes once the answer allows more, or after the quiet); the presses that
 * follow it within ZAP_SETTLE_MS tune only once they go quiet, so the channels passed on the way
 * never open a stream or a Recent row.
 */
export function zap(direction: 'up' | 'down'): Promise<Channel | undefined> {
  preloadEngineFor(usePlayerStore.getState().source?.url);
  queuedPresses++;
  const step = zapQueue.then(() => stepZap(direction));
  zapQueue = step.catch(() => undefined);
  return step.then((b) => (b ? b.done : undefined));
}

export async function zapToNumber(n: number): Promise<Channel | undefined> {
  const { zapContext, source } = usePlayerStore.getState();
  // A list spans sources: digits follow the playing channel's own source, not the list's first.
  const sourceId = zapContext?.listId
    ? (source?.ref?.sourceId ?? zapContext.sourceId)
    : (zapContext?.sourceId ?? source?.ref?.sourceId);
  if (!sourceId || !Number.isFinite(n)) return undefined;
  const ch = await rpc('catalog.channelByNumber', { sourceId, number: n });
  if (ch) await playChannel(ch);
  return ch ?? undefined;
}

/** Testing only: reset module state. */
export function __resetPlayerForTests(): void {
  playToken = 0;
  requestSeq = 0;
  pendingMpvUnload = Promise.resolve();
  switchPlaceholder = null;
  externalChoice = null;
  stageCount = 0;
  controller = null;
  settingsCache = null;
  settingsPromise = null;
  lastSavedPosition = -1;
  lastSave = Promise.resolve();
  finishedSavedFor = undefined;
  failedResolve = null;
  allowedRefKey = null;
  startOverKey = null;
  sourceKindCache.clear();
  stopSaver();
  dropPendingSeek();
  if (upNextTimer) clearTimeout(upNextTimer);
  upNextTimer = null;
  upNextArmed = undefined;
  upNextHandledFor = undefined;
  clearStallTimer();
  startedFor = undefined;
  userPausedFor = undefined;
  if (burst) endBurst(burst, undefined);
  zapQueue = Promise.resolve();
  queuedPresses = 0;
  if (prefetchTimer) clearTimeout(prefetchTimer);
  prefetchTimer = null;
  heldRecent = null;
  knownChannels.clear();
  favoriteSlot = null;
  queryClient.removeQueries({ queryKey: ['settings.get'] });
  queryClient.removeQueries({ queryKey: ['catalog.neighbors'] });
  queryClient.removeQueries({ queryKey: ['lists.neighbors'] });
  queryClient.removeQueries({ queryKey: ['sources.get'] });
  __resetNowNextForTests();
  useMediaStore.setState({ upNext: undefined, errorCode: undefined });
  usePlayerStore.setState({
    source: undefined,
    mode: 'inline',
    status: 'idle',
    error: undefined,
    isFullscreen: false,
    isWindowFilled: false,
    dock: 'hidden',
    volume: 1,
    muted: false,
    positionSeconds: 0,
    durationSeconds: undefined,
    queue: [],
    zapContext: undefined,
  });
}
