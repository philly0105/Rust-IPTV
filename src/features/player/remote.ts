/**
 * Remote control bridge: `remote.command` events drive the player, and the player
 * reports its status (`remote.reportStatus`) at most once a second while it changes.
 */

import { onAppEvent } from '@/api/events';
import { rpc } from '@/api/transport';
import type { RemoteStatus } from '@/api/types';

import { stopExternalPlayback } from './external';
import { peekSettings, playChannel, subscribeSettings, usePlayerStore, zap, zapToNumber } from './store';

/** The remote server is on (unknown settings count as on, so nothing is lost before they load). */
function remoteOn(): boolean {
  return peekSettings()?.remoteControl?.enabled !== false;
}

export function remoteStatusOf(s: ReturnType<typeof usePlayerStore.getState>): RemoteStatus {
  const status: RemoteStatus = {
    isLive: !!s.source?.isLive,
    canVolume: !!s.source && s.mode !== 'external',
    volume: Math.round(s.volume * 100),
    muted: s.muted,
  };
  if (s.source?.isLive) status.channelName = s.source.title;
  return status;
}

/**
 * Number of mounted views (the live page's remote bridge) that apply channel commands
 * themselves. While one is mounted, `bindRemote` leaves channel commands to it so a remote
 * press plays the channel once.
 */
let channelCommandClaims = 0;

/** Claims `channelUp` / `channelDown` / `selectNumber` / `selectId`; returns the release function. */
export function claimRemoteChannelCommands(): () => void {
  channelCommandClaims++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    channelCommandClaims--;
  };
}

const CHANNEL_COMMANDS = new Set(['channelUp', 'channelDown', 'selectNumber', 'selectId']);

export function bindRemote(): () => void {
  const unCmd = onAppEvent('remote.command', (ev) => {
    if (channelCommandClaims > 0 && CHANNEL_COMMANDS.has(ev.command)) return;
    const s = usePlayerStore.getState();
    switch (ev.command) {
      case 'channelUp':
        void zap('up').catch(() => undefined);
        break;
      case 'channelDown':
        void zap('down').catch(() => undefined);
        break;
      case 'selectNumber':
        if (ev.number !== undefined) void zapToNumber(ev.number).catch(() => undefined);
        break;
      case 'selectId': {
        const [sourceId, ...rest] = (ev.id ?? '').split('|');
        const itemId = rest.join('|');
        if (!sourceId || !itemId) break;
        void rpc('catalog.item', { ref: { sourceId, contentType: 'live', itemId } })
          .then((item) => ('name' in item ? playChannel(item) : undefined))
          .catch(() => undefined);
        break;
      }
      case 'volumeUp':
        s.adjustVolume(0.05);
        break;
      case 'volumeDown':
        s.adjustVolume(-0.05);
        break;
      case 'mute':
        s.toggleMute();
        break;
      case 'setVolume':
        if (ev.level !== undefined) s.setVolume(ev.level > 1 ? ev.level / 100 : ev.level);
        break;
      case 'togglePlay':
        s.togglePlay();
        break;
      case 'stop':
        // An external player is closed the way its stage's Stop does it.
        if (s.mode === 'external') void stopExternalPlayback();
        else s.stop();
        break;
    }
  });

  let last = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const push = (): void => {
    timer = null;
    // Nobody listens while the remote server is off: no round trip per channel change.
    if (!remoteOn()) return;
    const status = remoteStatusOf(usePlayerStore.getState());
    const json = JSON.stringify(status);
    if (json === last) return;
    last = json;
    rpc('remote.reportStatus', { status }).catch(() => {
      last = ''; // remote server off or failed: try again on the next change
    });
  };
  const unStore = usePlayerStore.subscribe((s, prev) => {
    if (s.source === prev.source && s.volume === prev.volume && s.muted === prev.muted && s.mode === prev.mode) return;
    if (!timer && remoteOn()) timer = setTimeout(push, 1000);
  });
  // Turned on: it gets the current status without waiting for the next change.
  let wasOn = remoteOn();
  const unSettings = subscribeSettings(() => {
    const on = remoteOn();
    if (on && !wasOn) {
      last = '';
      if (!timer) timer = setTimeout(push, 0);
    }
    wasOn = on;
  });

  return () => {
    unCmd();
    unStore();
    unSettings();
    if (timer) clearTimeout(timer);
  };
}
