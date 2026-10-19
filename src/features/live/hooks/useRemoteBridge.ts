import { useEffect, useRef } from 'react';

import { onAppEvent } from '@/api/events';
import { rpc } from '@/api/transport';
import type { Channel, EpgNowNext, ItemRef, RemoteCommandEvent } from '@/api/types';

import { claimRemoteChannelCommands } from '@/features/player/remote';
import { usePlayerStore } from '@/features/player';
import { peekSettings } from '@/features/player/store';

/** When to look for a freshly started remote server after a settings change. */
export const REPUBLISH_DELAYS_MS = [0, 1_000, 3_000];

interface Args {
  sourceId: string;
  sourceName?: string;
  up(): void;
  down(): void;
  selectNumber(n: number): void;
  selectRef(ref: ItemRef): void;
  /** The channel playing in this view, if any. */
  current?: Channel;
  /** `current`'s name as the app shows it (country prefix stripped when the setting is on). */
  currentName?: string;
  currentNowNext?: EpgNowNext;
}

/**
 * Remote control (C4 remote.*): tells the core which source this view shows while the loopback
 * server runs (the core fills the phone's channel list from its catalog), applies channel
 * commands, and reports status on channel changes.
 */
export function useRemoteBridge(args: Args): void {
  const live = useRef(args);
  live.current = args;
  const running = useRef(false);

  // Publish this source when the remote server is running: on mount, and again when remote
  // control may have just started (settings change, first remote command). The core reads the
  // channels itself and refills the list when the catalog, channel edits or parental controls
  // change, so nothing here fetches the catalog.
  const published = useRef(false);
  const kick = useRef<() => void>(() => undefined);
  useEffect(() => {
    let cancelled = false;
    const sourceId = args.sourceId;
    const timers: ReturnType<typeof setTimeout>[] = [];
    published.current = false;
    const attempt = async () => {
      const stale = () => cancelled || published.current;
      try {
        const status = await rpc('remote.status');
        running.current = status.running;
        if (!status.running || stale()) return;
        await rpc('remote.publishSource', { sourceId });
        published.current = true;
      } catch {
        // Remote control is optional; the live view works without it.
      }
    };
    // The server comes up a moment after the setting flips (`remote.start`, or the core's
    // settings watcher), so check now and shortly after.
    const retry = () => {
      published.current = false;
      for (const delay of REPUBLISH_DELAYS_MS) timers.push(setTimeout(() => void attempt(), delay));
    };
    kick.current = () => {
      if (!published.current) void attempt();
    };
    void attempt();
    const off = onAppEvent('settings.changed', (s) => {
      if (s.remoteControl?.enabled) retry();
      else running.current = false;
    });
    return () => {
      cancelled = true;
      off();
      for (const t of timers) clearTimeout(t);
      kick.current = () => undefined;
    };
  }, [args.sourceId]);

  // Apply channel commands coming from the remote UI. While this view is mounted it is the only
  // handler of channel commands (the player's `bindRemote` stands down), so a press plays once.
  useEffect(() => {
    const release = claimRemoteChannelCommands();
    const off = onAppEvent('remote.command', (cmd: RemoteCommandEvent) => {
      const a = live.current;
      kick.current();
      switch (cmd.command) {
        case 'channelUp':
          a.up();
          break;
        case 'channelDown':
          a.down();
          break;
        case 'selectNumber':
          if (typeof cmd.number === 'number') a.selectNumber(cmd.number);
          break;
        case 'selectId': {
          const [sourceId, ...rest] = (cmd.id ?? '').split('|');
          const itemId = rest.join('|');
          if (sourceId === a.sourceId && itemId) a.selectRef({ sourceId, contentType: 'live', itemId });
          break;
        }
        default:
          break; // volume commands belong to the player
      }
    });
    return () => {
      off();
      release();
    };
  }, []);

  // Report status whenever the playing channel changes.
  const currentKey = args.current ? `${args.current.ref.itemId}|${args.currentNowNext?.now?.title ?? ''}` : '';
  useEffect(() => {
    const a = live.current;
    if (!a.current) return;
    // Nobody listens while remote control is off (unknown settings count as on): no remote.status
    // round trip per zap. The setting is read at each change, so turning it on later reports again.
    if (peekSettings()?.remoteControl?.enabled === false) return;
    let cancelled = false;
    (async () => {
      try {
        if (!running.current) running.current = (await rpc('remote.status')).running;
        if (!running.current || cancelled) return;
        const { volume, muted } = usePlayerStore.getState();
        await rpc('remote.reportStatus', {
          status: {
            sourceName: a.sourceName,
            isLive: true,
            channelName: a.currentName ?? a.current?.name,
            channelNumber: a.current?.number,
            epgNow: a.currentNowNext?.now?.title,
            volume: Math.round(volume <= 1 ? volume * 100 : volume),
            muted,
            canVolume: true,
          },
        });
      } catch {
        // ignore; remote status is best effort
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentKey]);
}
