import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isDesktop } from '@/api/transport';
import type { PlayerSource } from '@/api/types';

// account:
import { useConnectionCounts } from './connectionLimit';
import type { EngineError } from './engines';
import { browserOnline, classifyStreamError, errorCopyKeys, type ExternalRoute, type StreamErrorClass } from './errors';
import { useMediaStore } from './media';
import { canShareSource } from './shareable';
import { usePlayerStore } from './store';

export interface StreamErrorView {
  cls: StreamErrorClass;
  title: string;
  hint: string;
  /** Where the stream can go instead (`ExternalRoute`): the overlay offers that, and the hint names it. */
  external: ExternalRoute;
}

/** Tracks `navigator.onLine` through the window's online/offline events. */
export function useOnline(): boolean | undefined {
  const [online, setOnline] = useState(browserOnline);
  useEffect(() => {
    const on = (): void => setOnline(browserOnline());
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
    };
  }, []);
  return online;
}

/**
 * Where a stream this player cannot show can go: the desktop app launches MPV or VLC; a browser
 * copies a link that carries no login; otherwise nowhere (Xtream and Stalker links are logins).
 */
export function externalRouteFor(source: PlayerSource | undefined): ExternalRoute {
  if (isDesktop) return 'app';
  return source?.url && canShareSource(source) ? 'link' : 'none';
}

/** The current playback error, classified, with its headline and next step. */
export function useStreamError(kind?: EngineError['kind'] | null): StreamErrorView {
  const { t } = useTranslation('player');
  const message = usePlayerStore((s) => s.error);
  const code = useMediaStore((s) => s.errorCode);
  const online = useOnline();
  // account: a full account turns a bare 403/5xx into "Connection limit reached (2 of 2 in use)".
  const sourceId = usePlayerStore((s) => s.source?.ref?.sourceId);
  const connections = useConnectionCounts({ message, kind, code, online }, sourceId);
  const live = usePlayerStore((s) => !!s.source?.isLive);
  const external = usePlayerStore((s) => externalRouteFor(s.source));
  const cls = classifyStreamError({ message, kind, code, online, connections });
  const keys = errorCopyKeys(cls, { connections, message, live, external });
  return { cls, title: t(keys.title, keys.params), hint: t(keys.hint, keys.params), external };
}

/**
 * While the error is "offline", retry by itself as soon as the connection is back.
 * One retry per reconnect; a failure after that shows its own class.
 */
export function useRetryWhenOnline(cls: StreamErrorClass, retry: () => void): void {
  useEffect(() => {
    if (cls !== 'offline') return;
    const on = (): void => {
      if (browserOnline() !== false) retry();
    };
    window.addEventListener('online', on);
    return () => window.removeEventListener('online', on);
  }, [cls, retry]);
}
