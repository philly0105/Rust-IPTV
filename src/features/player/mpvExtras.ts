/**
 * Audio/subtitle delay and stream info for embedded mpv. Bound by MpvSurface once `mpv.attach`
 * succeeded (property writes fail before that), and again after a restart.
 */

import { rpc } from '@/api/transport';

import { setStatsProvider } from './streamInfo';
import { useSyncStore } from './sync';

function sendDelay(name: 'audio-delay' | 'sub-delay', ms: number): void {
  // mpv takes seconds.
  void rpc('mpv.setProperty', { name, value: ms / 1000 }).catch(() => undefined);
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
  const unStats = setStatsProvider(async () => ({ ...(await rpc('mpv.stats')), engine: 'mpv' as const }));
  return () => {
    unSync();
    unStats();
  };
}
