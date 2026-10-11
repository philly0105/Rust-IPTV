import { useEffect, useRef } from 'react';

import { onAppEvent } from '@/api/events';
import { rpc } from '@/api/transport';
import type { Channel, EpgNowNext, ItemRef, RemoteCommandEvent } from '@/api/types';

import { usePlayerStore } from '../_shim';

interface Args {
  sourceId: string;
  sourceName?: string;
  up(): void;
  down(): void;
  selectNumber(n: number): void;
  selectRef(ref: ItemRef): void;
  /** The channel playing in this view, if any. */
  current?: Channel;
  currentNowNext?: EpgNowNext;
}

/**
 * Remote control (C4 remote.*): publishes this source's live catalog while the loopback
 * server runs, applies channel commands, and reports status on channel changes.
 */
export function useRemoteBridge(args: Args): void {
  const live = useRef(args);
  live.current = args;
  const running = useRef(false);

  // Publish the channel catalog for this source when the remote server is running.
  useEffect(() => {
    let cancelled = false;
    const sourceId = args.sourceId;
    (async () => {
      try {
        const status = await rpc('remote.status');
        running.current = status.running;
        if (!status.running || cancelled) return;
        const channels = await rpc('catalog.allLiveChannels', { sourceId });
        if (cancelled) return;
        await rpc('remote.publishChannels', {
          channels: channels.map((c) => ({
            id: `${c.ref.sourceId}|${c.ref.itemId}`,
            name: c.name,
            number: c.number,
            logoUrl: c.logoUrl,
          })),
        });
      } catch {
        // Remote control is optional; the live view works without it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [args.sourceId]);

  // Apply channel commands coming from the remote UI.
  useEffect(
    () =>
      onAppEvent('remote.command', (cmd: RemoteCommandEvent) => {
        const a = live.current;
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
      }),
    [],
  );

  // Report status whenever the playing channel changes.
  const currentKey = args.current ? `${args.current.ref.itemId}|${args.currentNowNext?.now?.title ?? ''}` : '';
  useEffect(() => {
    const a = live.current;
    if (!a.current) return;
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
            channelName: a.current?.name,
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
