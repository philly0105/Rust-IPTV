import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

// account:
import { useConnectionCounts } from './connectionLimit';
import type { EngineError } from './engines';
import { browserOnline, classifyStreamError, errorCopyKeys, type StreamErrorClass } from './errors';
import { useMediaStore } from './media';
import { usePlayerStore } from './store';

export interface StreamErrorView {
  cls: StreamErrorClass;
  title: string;
  hint: string;
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
  const cls = classifyStreamError({ message, kind, code, online, connections });
  const keys = errorCopyKeys(cls, { connections, message, live });
  return { cls, title: t(keys.title, keys.params), hint: t(keys.hint, keys.params) };
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
