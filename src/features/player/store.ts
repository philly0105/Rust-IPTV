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
import type {
  Channel,
  ItemRef,
  ItemSnapshot,
  PlayerKind,
  PlayerSource,
  Settings,
  SourceKind,
  VideoPlayer,
} from '@/api/types';

import { resetMedia, showOsd, UP_NEXT_SECONDS, useMediaStore } from './media';

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

async function sourceKindOf(sourceId: string): Promise<SourceKind> {
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

function errorMessage(err: unknown): string {
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
    if (!source || mode === 'external' || isEndedState(state)) {
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

function savePosition(): void {
  const { source, positionSeconds, durationSeconds } = usePlayerStore.getState();
  if (!tracksPosition(source)) return;
  const pos = Math.floor(positionSeconds);
  if (pos <= 0 || pos === lastSavedPosition) return;
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
  rpc('positions.set', args).catch(() => {
    lastSavedPosition = -1; // retry on next tick
  });
}

/** Persist now: resume record and VOD position. Called every 5 s, on stop, and on page hide. */
export function flushProgress(): void {
  writeResume();
  savePosition();
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
    if (durationSeconds && Number.isFinite(durationSeconds)) target = Math.min(target, durationSeconds);
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
  },

  adjustVolume(delta) {
    get().setVolume(Math.round((get().volume + delta) * 100) / 100);
  },

  toggleMute() {
    const muted = !get().muted;
    controller?.setMuted(muted);
    set({ muted });
    storeVolume(get().volume, muted);
  },

  toggleFullscreen() {
    if (!get().source) return;
    set({ isFullscreen: !get().isFullscreen });
  },

  setDock(d) {
    set({ dock: d });
  },

  next() {
    const { queue, source } = get();
    const idx = queue.findIndex((q) => sameSource(q, source));
    const nextSource = idx >= 0 ? queue[idx + 1] : undefined;
    if (nextSource) void get().play(nextSource, { queue, mode: get().mode });
  },

  prev() {
    const { queue, source } = get();
    const idx = queue.findIndex((q) => sameSource(q, source));
    const prevSource = idx > 0 ? queue[idx - 1] : undefined;
    if (prevSource) void get().play(prevSource, { queue, mode: get().mode });
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
  // Mark as finished: positions.set deletes rows at >= 95 %.
  if (tracksPosition(s.source) && s.durationSeconds) savePosition();
  clearResume();
  const next = nextInQueue();
  if (next && (peekSettings()?.playerAutoplayNextEpisode ?? true)) {
    // The dock shows a 10 s "Next episode" card; it calls next() at zero or on "Play now".
    useMediaStore.setState({ upNext: { source: next, deadline: Date.now() + UP_NEXT_SECONDS * 1000 } });
  }
}

/** Start the current item again from the beginning (the dock's replay affordance). */
export function replay(): void {
  const s = usePlayerStore.getState();
  if (!s.source || s.mode === 'external') return;
  useMediaStore.setState({ upNext: undefined });
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
    const headers = src?.m3u?.headers;
    if (headers && Object.values(headers).some(Boolean)) resolved.headers = headers;
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
  if (source.resumeSeconds !== undefined || !tracksPosition(source)) return source;
  try {
    const pos = await rpc(
      'positions.get',
      source.episodeId ? { ref: source.ref, episodeId: source.episodeId } : { ref: source.ref },
    );
    if (pos && pos.positionSeconds > 5) {
      const dur = pos.durationSeconds;
      if (!dur || pos.positionSeconds < dur * 0.95) return { ...source, resumeSeconds: pos.positionSeconds };
    }
  } catch {
    // no saved position
  }
  return source;
}

export async function playItem(args: PlayItemArgs, opts?: { queue?: PlayerSource[] }): Promise<void> {
  const seq = ++requestSeq;
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
    if (seq !== requestSeq) return;
    usePlayerStore.setState({ status: 'error', error: errorMessage(err) });
    throw err;
  }
  if (seq !== requestSeq) return;
  await usePlayerStore.getState().play(source, opts);
}

export async function playSource(source: PlayerSource): Promise<void> {
  const seq = ++requestSeq;
  const withPos = await withResume(source);
  if (seq !== requestSeq) return;
  await usePlayerStore.getState().play(withPos);
}

/** Boot hook: replay `sessionStorage['player.resume']` (SC12). */
export async function restorePlayback(): Promise<boolean> {
  const rec = readResume();
  if (!rec || rec.mode === 'external') return false;
  const source: PlayerSource = { ...rec.source };
  if (!source.isLive && rec.positionSeconds > 0) source.resumeSeconds = rec.positionSeconds;
  else delete source.resumeSeconds;
  await usePlayerStore.getState().play(source, { mode: rec.mode });
  return true;
}

// ---------------------------------------------------------------------------
// Channel zapping
// ---------------------------------------------------------------------------

export async function playChannel(channel: Channel, sourceKind?: SourceKind): Promise<void> {
  const kind = sourceKind ?? (await sourceKindOf(channel.ref.sourceId));
  const args: PlayItemArgs = {
    ref: channel.ref,
    title: channel.name,
    isLive: true,
    isRadio: channel.isRadio,
    sourceKind: kind,
  };
  if (channel.logoUrl) args.posterUrl = channel.logoUrl;
  if (channel.categoryName) args.subtitle = channel.categoryName;
  // Tuner readout: number big, name below.
  showOsd(channel.number !== undefined ? String(channel.number) : channel.name, channel.number !== undefined ? channel.name : undefined);
  await playItem(args);
}

function currentLiveRef(): ItemRef | undefined {
  const { source } = usePlayerStore.getState();
  if (!source?.ref || !source.isLive) return undefined;
  return source.ref;
}

/** Move to the neighbor channel in the current list context. Returns the channel played, if any. */
export async function zap(direction: 'up' | 'down'): Promise<Channel | undefined> {
  const ref = currentLiveRef();
  if (!ref) return undefined;
  const ctx = usePlayerStore.getState().zapContext;
  const args: { ref: ItemRef; categoryId?: string } = { ref };
  if (ctx?.categoryId && ctx.sourceId === ref.sourceId) args.categoryId = ctx.categoryId;
  const res = await rpc('catalog.neighbors', args);
  const target = direction === 'up' ? res.prev : res.next;
  if (target) await playChannel(target);
  return target;
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
  sourceKindCache.clear();
  stopSaver();
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
