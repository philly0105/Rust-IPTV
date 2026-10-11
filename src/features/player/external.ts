/** Tracks external player processes from `player.external` events (desktop) and stops them. */

import i18next from 'i18next';

import { onAppEvent } from '@/api/events';
import { isDesktop, rpc } from '@/api/transport';

import { toast } from '@/ui/Toast';
import { useMediaStore } from './media';
import { errorMessage, usePlayerStore } from './store';

const PLAYER_NAMES = { mpv: 'MPV', vlc: 'VLC' } as const;

let bound = false;

export function bindExternalEvents(): void {
  if (bound) return;
  bound = true;
  onAppEvent('player.external', (ev) => {
    const runs = useMediaStore.getState().externalRuns;
    if (ev.state === 'started') {
      const rest = runs.filter((r) => !(ev.pid !== undefined && r.pid === ev.pid));
      const run = { player: ev.player, title: ev.title, startedAt: Date.now(), ...(ev.pid !== undefined ? { pid: ev.pid } : {}) };
      useMediaStore.setState({ externalRuns: [...rest, run] });
      return;
    }
    const idx = ev.pid !== undefined ? runs.findIndex((r) => r.pid === ev.pid) : runs.findIndex((r) => r.title === ev.title);
    const next = idx >= 0 ? runs.filter((_, i) => i !== idx) : runs;
    useMediaStore.setState({ externalRuns: next });
    // The store's external session ends with the last process. A launch still in flight is
    // exempt: with `playerReuseInstance` the previous player exits just before the next starts.
    const s = usePlayerStore.getState();
    if (s.mode === 'external' && s.source && s.status !== 'loading' && next.length === 0) s.stop();
  });
}

let stopping: Promise<void> | null = null;

/**
 * The external Stop action: closes the MPV/VLC process this app launched (`player.stopExternal`),
 * then ends the in-app session. A failed close is reported in a toast; the session ends anyway.
 * Concurrent calls share one request.
 */
export function stopExternalPlayback(): Promise<void> {
  stopping ??= run().finally(() => {
    stopping = null;
  });
  return stopping;
}

async function run(): Promise<void> {
  const before = usePlayerStore.getState();
  const runs = useMediaStore.getState().externalRuns;
  const external = before.mode === 'external' || runs.length > 0;
  if (isDesktop && external) {
    try {
      await rpc('player.stopExternal');
    } catch (err) {
      const latest = runs[runs.length - 1];
      const player = PLAYER_NAMES[latest?.player ?? 'mpv'];
      toast({
        title: i18next.t('player:externalStopFailed', { player }),
        description: `${i18next.t('player:externalStopFailedHint', { player })} ${errorMessage(err)}`,
        variant: 'error',
      });
    }
  }
  // Clear the session unless something else already replaced it (an exit event, or a new play).
  const s = usePlayerStore.getState();
  if (s.source === before.source && (s.source || s.mode === 'external')) s.stop();
}
