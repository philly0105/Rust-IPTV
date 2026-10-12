import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

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
  const cls = classifyStreamError({ message, kind, code, online });
  const keys = errorCopyKeys(cls);
  return { cls, title: t(keys.title), hint: t(keys.hint) };
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
