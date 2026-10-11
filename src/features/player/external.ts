/** Tracks external player processes from `player.external` events (desktop). */

import { onAppEvent } from '@/api/events';

import { useMediaStore } from './media';
import { usePlayerStore } from './store';

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
    // The store's external session ends with the last process.
    const s = usePlayerStore.getState();
    if (s.mode === 'external' && s.source && next.length === 0) s.stop();
  });
}
