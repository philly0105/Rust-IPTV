/**
 * Sleep timer (C5). Stops playback after a chosen time, at the end of the airing programme
 * (live) or at the end of the episode or movie (VOD).
 *
 * The last 30 s fade the volume out linearly through the player store's public `setVolume`, so
 * the inline engines and embedded mpv fade alike. The fade is audio and runs under reduced
 * motion too (only the chip's visual countdown honours it). At zero, live playback stops and
 * VOD pauses (a pending Up next is cancelled), the volume goes back to its level before the
 * fade, and a toast says what happened. One minute before, the timer raises `warning`; the
 * player shows it as a toast (and inside fullscreen or picture-in-picture, where toasts cannot
 * be seen) with "Keep watching" (+15 min) and Cancel.
 *
 * A person changing the volume or mute during the fade takes the volume over: the ramp stops
 * there and nothing is restored afterwards. If the app closes mid-fade, the level before the
 * fade is put back on the next start.
 */

import i18next from 'i18next';
import { create, type StoreApi, type UseBoundStore } from 'zustand';

import { itemKey } from '@/api/types';
import { formatClock, ms } from '@/features/live/lib/epgTime';
import { toast } from '@/ui/Toast';

import { showOsd, useMediaStore } from './media';
import { fetchNowNext, peekNowNext } from './nowNext';
import { cancelUpNext, isEndedState, setPaused, subscribeVolumeIntent, usePlayerStore } from './store';

export type SleepTarget = { kind: 'minutes'; minutes: 15 | 30 | 45 | 60 | 90 | number } | { kind: 'programmeEnd' } | { kind: 'episodeEnd' };

export interface SleepTimerState {
  /** When playback stops (ms since epoch); null while off, or while "programme end" is still being looked up. */
  endsAt: number | null;
  target: SleepTarget | null;
  /** True during the last 30 s, while the volume ramps down. */
  fading: boolean;
  start(t: SleepTarget): void;
  extend(minutes: number): void;
  cancel(): void;
}

/** The durations the menu offers and `Z` cycles through. */
export const SLEEP_PRESETS = [15, 30, 45, 60, 90] as const;
/** The fade-out at the end. */
export const SLEEP_FADE_MS = 30_000;
/** When the "about to stop" warning comes up. */
export const SLEEP_WARNING_MS = 60_000;
/** What "Keep watching" adds. */
export const SLEEP_EXTEND_MINUTES = 15;
/** Longest timer accepted (a day). */
export const SLEEP_MAX_MINUTES = 24 * 60;
/** Ticks: once a second, four times a second while fading (smooth enough for a 1 % volume step). */
const TICK_MS = 1000;
const FADE_TICK_MS = 250;
/** The level before an interrupted fade, put back on the next start. */
export const SLEEP_FADE_KEY = 'player.sleepFade';
/** Toast ids: the warning is updated in place and dismissed by id. */
export const SLEEP_WARNING_TOAST = 'player-sleep-warning';
export const SLEEP_DONE_TOAST = 'player-sleep-done';
const MINUTE = 60_000;

/** UI-only state beside the C5 store: the one-minute warning and the "programme end" lookup. */
export interface SleepTimerExtras {
  /** The warning is up (inside the last minute, not dismissed by Keep watching or Cancel). */
  warning: boolean;
  /** "Until the programme ends" is waiting for the guide. */
  resolving: boolean;
}

export const useSleepTimerExtras: UseBoundStore<StoreApi<SleepTimerExtras>> = create<SleepTimerExtras>()(() => ({
  warning: false,
  resolving: false,
}));

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | null = null;
/** Bumped by every start, extend, cancel and expiry: a late guide answer for an older timer is dropped. */
let generation = 0;
/** The volume before the fade, while the ramp owns the volume; null when not ramping. */
let fadeBase: number | null = null;
/** Length of the current ramp: 30 s, or less when the timer was set closer to its end than that. */
let fadeSpan = SLEEP_FADE_MS;
/** Set while the fade itself calls `setVolume`, so its own changes are not taken for a person's. */
let applying = false;

const t = (key: string, opts?: Record<string, unknown>): string => i18next.t(`player:${key}`, opts);

function clearTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

function readMarker(): number | null {
  try {
    const raw = localStorage.getItem(SLEEP_FADE_KEY);
    if (!raw) return null;
    const v = (JSON.parse(raw) as { volume?: unknown }).volume;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1 ? v : null;
  } catch {
    return null;
  }
}

function writeMarker(volume: number): void {
  try {
    localStorage.setItem(SLEEP_FADE_KEY, JSON.stringify({ volume }));
  } catch {
    // Storage unavailable: only an interrupted fade loses its restore.
  }
}

function clearMarker(): void {
  try {
    localStorage.removeItem(SLEEP_FADE_KEY);
  } catch {
    // ignore
  }
}

/** Sets the volume through the store's public API, marked as the fade's own change. */
function applyVolume(v: number): void {
  applying = true;
  try {
    usePlayerStore.getState().setVolume(Math.round(v * 1000) / 1000);
  } finally {
    applying = false;
  }
}

/** Positive, finite, at most a day; anything else is not a duration. */
function validMinutes(minutes: number): number | null {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.min(SLEEP_MAX_MINUTES, minutes);
}

function playingInApp(): boolean {
  const s = usePlayerStore.getState();
  return !!s.source && s.mode !== 'external';
}

function isVod(): boolean {
  const src = usePlayerStore.getState().source;
  return !!src && !src.isLive && !src.isRadio;
}

/**
 * Wall-clock end of the episode or movie playing now: what is left of it at the current speed.
 * `now` once it ended (or its Up next is up); null while the length is not known yet.
 */
export function episodeEndsAt(now = Date.now()): number | null {
  const s = usePlayerStore.getState();
  if (!s.source || s.source.isLive || s.source.isRadio) return null;
  if (isEndedState(s) || useMediaStore.getState().upNext) return now;
  const duration = s.durationSeconds;
  if (!duration || !Number.isFinite(duration)) return null;
  const rate = useMediaStore.getState().rate || 1;
  return now + (Math.max(0, duration - s.positionSeconds) / rate) * 1000;
}

/** Wall-clock end of the programme airing on the channel playing now, from the cache when current. */
function cachedProgrammeEnd(now: number): number | null | undefined {
  const ref = usePlayerStore.getState().source?.ref;
  if (!ref) return null;
  const nn = peekNowNext(ref, now);
  if (nn === undefined) return undefined;
  const end = nn?.now ? ms(nn.now.end) : 0;
  return end > now ? end : null;
}

// ---------------------------------------------------------------------------
// The fade
// ---------------------------------------------------------------------------

function beginFade(remaining: number): void {
  const { volume, muted } = usePlayerStore.getState();
  fadeSpan = Math.max(1, Math.min(SLEEP_FADE_MS, remaining));
  if (muted || volume <= 0) {
    // Nothing to fade: stay silent and restore nothing.
    fadeBase = null;
  } else {
    fadeBase = volume;
    writeMarker(volume);
  }
  useSleepTimer.setState({ fading: true });
}

/** Ends the fade; puts the earlier level back when the ramp still owned the volume and `restore`. */
function endFade(restore: boolean): void {
  const base = fadeBase;
  fadeBase = null;
  clearMarker();
  if (restore && base !== null) applyVolume(base);
  if (useSleepTimer.getState().fading) useSleepTimer.setState({ fading: false });
}

// A person's volume or mute change during the fade: they have the volume now.
subscribeVolumeIntent(() => {
  if (applying || fadeBase === null) return;
  fadeBase = null;
  clearMarker();
});

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

function schedule(delay: number): void {
  clearTimer();
  timer = setTimeout(tick, Math.max(0, delay));
}

function tick(): void {
  // Also called directly (start, an episode reaching its end): one clock at a time.
  clearTimer();
  const st = useSleepTimer.getState();
  if (!st.target) return;
  const now = Date.now();
  let endsAt = st.endsAt;

  if (st.target.kind === 'episodeEnd') {
    const end = episodeEndsAt(now);
    if (end !== null && (endsAt === null || Math.abs(end - endsAt) >= 1000 || end <= now)) {
      endsAt = end;
      useSleepTimer.setState({ endsAt });
    }
  }
  if (endsAt === null) {
    // Waiting on the guide or on the item's length.
    schedule(TICK_MS);
    return;
  }

  const remaining = endsAt - now;
  if (remaining <= 0) {
    expire();
    return;
  }
  if (remaining <= SLEEP_WARNING_MS && !useSleepTimerExtras.getState().warning) {
    useSleepTimerExtras.setState({ warning: true });
  } else if (remaining > SLEEP_WARNING_MS && useSleepTimerExtras.getState().warning) {
    // The end moved away (an episode seeked back): the warning no longer applies.
    useSleepTimerExtras.setState({ warning: false });
  }

  if (remaining <= SLEEP_FADE_MS) {
    if (!useSleepTimer.getState().fading) beginFade(remaining);
    if (fadeBase !== null) applyVolume(fadeBase * Math.min(1, remaining / fadeSpan));
    schedule(Math.min(FADE_TICK_MS, remaining));
    return;
  }
  if (useSleepTimer.getState().fading) endFade(true);
  // Wake on time for the warning and for the start of the fade.
  const untilWarning = remaining - SLEEP_WARNING_MS;
  const untilFade = remaining - SLEEP_FADE_MS;
  schedule(Math.min(TICK_MS, untilWarning > 0 ? untilWarning : TICK_MS, untilFade));
}

function reset(): void {
  generation++;
  clearTimer();
  useSleepTimerExtras.setState({ warning: false, resolving: false });
}

function expire(): void {
  const base = fadeBase;
  fadeBase = null;
  reset();
  clearMarker();
  // Off first, so the stop below reads as the timer's own and not as "playback went away".
  useSleepTimer.setState({ endsAt: null, target: null, fading: false });
  const s = usePlayerStore.getState();
  const acted = playingInApp();
  // The ramp ends at silence before the stop, so nothing plays a step louder on the way out.
  if (base !== null) applyVolume(0);
  if (acted && s.source) {
    if (s.source.isLive) s.stop();
    else {
      cancelUpNext();
      setPaused(true);
    }
  }
  if (base !== null) applyVolume(base);
  if (!acted) return;
  const at = formatClock(Date.now(), i18next.language);
  toast({ id: SLEEP_DONE_TOAST, title: t('sleepStopped'), description: t('sleepStoppedAt', { time: at }), variant: 'info', duration: 0 });
  // Paused VOD stays on screen (maybe fullscreen, where toasts are hidden): say it there too.
  if (usePlayerStore.getState().source) showOsd(t('sleepTimer'), t('sleepStopped'));
}

/** Programme end could not be found: turn off and say why. */
function noGuide(): void {
  cancelTimer();
  toast({ title: t('sleepNoGuide'), description: t('sleepNoGuideDetail'), variant: 'info' });
}

function cancelTimer(): void {
  reset();
  endFade(true);
  if (useSleepTimer.getState().target) useSleepTimer.setState({ endsAt: null, target: null, fading: false });
}

// ---------------------------------------------------------------------------
// The store (C5)
// ---------------------------------------------------------------------------

export const useSleepTimer: UseBoundStore<StoreApi<SleepTimerState>> = create<SleepTimerState>()(() => ({
  endsAt: null,
  target: null,
  fading: false,

  start(target) {
    if (!playingInApp()) return;
    const now = Date.now();
    if (target.kind === 'minutes') {
      const minutes = validMinutes(target.minutes);
      if (minutes === null) return;
      cancelTimer();
      useSleepTimer.setState({ target: { kind: 'minutes', minutes }, endsAt: now + minutes * MINUTE, fading: false });
      tick();
      return;
    }
    if (target.kind === 'episodeEnd') {
      if (!isVod()) return;
      cancelTimer();
      useSleepTimer.setState({ target: { kind: 'episodeEnd' }, endsAt: episodeEndsAt(now), fading: false });
      tick();
      return;
    }
    // programmeEnd: live channels with a guide only.
    const ref = usePlayerStore.getState().source?.ref;
    if (!usePlayerStore.getState().source?.isLive || !ref) return;
    cancelTimer();
    const cached = cachedProgrammeEnd(now);
    if (cached === null) {
      noGuide();
      return;
    }
    useSleepTimer.setState({ target: { kind: 'programmeEnd' }, endsAt: cached ?? null, fading: false });
    if (cached !== undefined) {
      tick();
      return;
    }
    const gen = generation;
    useSleepTimerExtras.setState({ resolving: true });
    void fetchNowNext(ref).then((nn) => {
      if (gen !== generation) return;
      useSleepTimerExtras.setState({ resolving: false });
      const end = nn?.now ? ms(nn.now.end) : 0;
      if (end <= Date.now()) {
        noGuide();
        return;
      }
      useSleepTimer.setState({ endsAt: end });
      tick();
    });
  },

  extend(minutes) {
    const add = validMinutes(minutes);
    if (add === null) return;
    const st = useSleepTimer.getState();
    if (!st.target) {
      st.start({ kind: 'minutes', minutes: add });
      return;
    }
    const now = Date.now();
    const endsAt = Math.min(Math.max(st.endsAt ?? now, now) + add * MINUTE, now + SLEEP_MAX_MINUTES * MINUTE);
    reset();
    endFade(true);
    // From here it is a plain countdown: the programme or episode no longer decides the end.
    useSleepTimer.setState({ target: { kind: 'minutes', minutes: Math.max(1, Math.round((endsAt - now) / MINUTE)) }, endsAt, fading: false });
    tick();
  },

  cancel() {
    cancelTimer();
  },
}));

// Playback ended by other means (stop, an external player): the timer goes with it. An
// episode-end timer follows the item, and turns off when what plays has no end (live).
usePlayerStore.subscribe((s, prev) => {
  const target = useSleepTimer.getState().target;
  if (!target) return;
  if (!s.source || s.mode === 'external') {
    cancelTimer();
    return;
  }
  if (target.kind === 'episodeEnd' && s.source !== prev.source && (s.source.isLive || s.source.isRadio)) {
    cancelTimer();
    toast({ title: t('sleepOff'), description: t('sleepEpisodeGone'), variant: 'info' });
    return;
  }
  // "Until the programme ends" belonged to the channel left behind: keep its end time as a
  // plain countdown, so the label does not claim the new channel's programme.
  const ref = s.source.ref;
  const before = prev.source?.ref;
  const { endsAt } = useSleepTimer.getState();
  if (target.kind === 'programmeEnd' && endsAt !== null && (!ref || !before || itemKey(ref) !== itemKey(before))) {
    useSleepTimer.setState({ target: { kind: 'minutes', minutes: Math.max(1, Math.round((endsAt - Date.now()) / MINUTE)) } });
  }
});

// An episode-end timer stops when the item ends, before its Up next countdown advances.
useMediaStore.subscribe((s, prev) => {
  if (s.upNext && !prev.upNext && useSleepTimer.getState().target?.kind === 'episodeEnd') tick();
});

/**
 * `Z`: off, 15, 30, 45, 60, 90, off. From a programme or episode end (or a time Keep watching
 * made), the next press turns the timer off. Returns the new target.
 */
export function cycleSleepTimer(): SleepTarget | null {
  const st = useSleepTimer.getState();
  const target = st.target;
  let next: number | null;
  if (!target) next = SLEEP_PRESETS[0];
  else if (target.kind !== 'minutes') next = null;
  else next = SLEEP_PRESETS.find((m) => m > target.minutes) ?? null;
  if (next === null) {
    st.cancel();
    return null;
  }
  st.start({ kind: 'minutes', minutes: next });
  return useSleepTimer.getState().target;
}

/** Milliseconds left, or null when off or still waiting for its end. */
export function sleepRemaining(now = Date.now()): number | null {
  const { endsAt } = useSleepTimer.getState();
  return endsAt === null ? null : Math.max(0, endsAt - now);
}

/** A fade cut short by closing the app left the volume low: put the earlier level back. */
function restoreInterruptedFade(): void {
  const base = readMarker();
  if (base === null) return;
  clearMarker();
  applyVolume(base);
}
restoreInterruptedFade();

/** Testing only: turn off without side effects and forget module state. */
export function __resetSleepTimerForTests(): void {
  generation++;
  clearTimer();
  fadeBase = null;
  fadeSpan = SLEEP_FADE_MS;
  applying = false;
  clearMarker();
  useSleepTimer.setState({ endsAt: null, target: null, fading: false });
  useSleepTimerExtras.setState({ warning: false, resolving: false });
}
