/**
 * Audio/subtitle delay, the subtitle look, the picture controls and stream info for embedded mpv. Bound by MpvSurface
 * once `mpv.attach` succeeded (property writes fail before that), and again after a restart.
 */

import { rpc } from '@/api/transport';

import { mpvPictureProperties, usePictureStore, type PictureState } from './picture';
import { peekSettings, subscribeSettings } from './store';
import { setStatsProvider } from './streamInfo';
import { useSyncStore } from './sync';

/**
 * Embedded mpv could not start in this session (not found, or it failed to start): later plays
 * hand over to the built-in player at once instead of trying it again and posting another
 * notice per zap. The verdict ends when the player choice or the mpv path in Settings changes,
 * or with Try MPV again (`clearMpvUnavailable`).
 */
let unavailable: { players: string; mpvPath: string | undefined } | null = null;

/** Every player choice in Settings (the default and the per-content ones) as one comparable value. */
function playerChoices(s: ReturnType<typeof peekSettings>): string {
  return JSON.stringify([s?.player, s?.livePlayer, s?.catchupPlayer, s?.vodPlayer]);
}

export function markMpvUnavailable(): void {
  const s = peekSettings();
  unavailable = { players: playerChoices(s), mpvPath: s?.mpvPath };
}

export function clearMpvUnavailable(): void {
  unavailable = null;
}

/** True while embedded mpv is known not to start (see `markMpvUnavailable`). */
export function mpvUnavailable(): boolean {
  const s = peekSettings();
  if (unavailable && (playerChoices(s) !== unavailable.players || s?.mpvPath !== unavailable.mpvPath)) unavailable = null;
  return unavailable !== null;
}

function sendDelay(name: 'audio-delay' | 'sub-delay', ms: number): void {
  // mpv takes seconds.
  void rpc('mpv.setProperty', { name, value: ms / 1000 }).catch(() => undefined);
}

/** The settings' subtitle look as one comparable value (null before settings load). */
function subtitleStyleKey(): string | null {
  const s = peekSettings();
  return s ? JSON.stringify([s.subtitleSize, s.subtitleColor, s.subtitleBackground, s.subtitlePosition]) : null;
}

/**
 * Sends the user's subtitle look to mpv (C6). Each property goes on its own, so an older mpv
 * that lacks one (`sub-border-style`) still takes the rest. MpvSurface calls it after each load.
 * The mapping loads on its own, outside the entry chunk.
 */
export function sendSubtitleStyle(): Promise<void> {
  return import('./subtitles/style').then(({ mpvSubtitleProperties, styleFromSettings }) => {
    const s = peekSettings();
    if (!s) return;
    for (const p of mpvSubtitleProperties(styleFromSettings(s))) void rpc('mpv.setProperty', p).catch(() => undefined);
  });
}

/** Aspect, zoom, crop and deinterlace (picture.ts); one property at a time, like the subtitle look. */
function sendPicture(p: PictureState): void {
  for (const prop of mpvPictureProperties(p)) void rpc('mpv.setProperty', prop).catch(() => undefined);
}

export function bindMpvExtras(): () => void {
  // A fresh session starts at mpv's zero; a restarted one gets the current values back.
  const now = useSyncStore.getState();
  if (now.audioMs !== 0) sendDelay('audio-delay', now.audioMs);
  if (now.subMs !== 0) sendDelay('sub-delay', now.subMs);
  const unSync = useSyncStore.subscribe((s, prev) => {
    if (s.audioMs !== prev.audioMs) sendDelay('audio-delay', s.audioMs);
    if (s.subMs !== prev.subMs) sendDelay('sub-delay', s.subMs);
  });
  void sendSubtitleStyle();
  // mpv keeps these across files; a fresh or restarted session gets the current choice.
  sendPicture(usePictureStore.getState());
  const unPicture = usePictureStore.subscribe((p) => sendPicture(p));
  let styleKey = subtitleStyleKey();
  const unStyle = subscribeSettings(() => {
    const next = subtitleStyleKey();
    if (next === styleKey) return;
    styleKey = next;
    void sendSubtitleStyle();
  });
  const unStats = setStatsProvider(async () => ({ ...(await rpc('mpv.stats')), engine: 'mpv' as const }));
  return () => {
    unSync();
    unStyle();
    unPicture();
    unStats();
  };
}
