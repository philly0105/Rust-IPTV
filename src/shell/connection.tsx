/**
 * Web mode: one surface for "the server is gone" (SH-offline-stack). Before, an outage at launch
 * showed three separate errors for one cause: Home's full-page error, the rail's red "Sources
 * didn't load" and a sticky toast. Now a strip under the header says the app is reconnecting
 * (with a way to try at once), the rail and Home wait quietly behind it, and once the event
 * socket reopens the strip says so for a moment and goes. The socket's reopen already refetches
 * every query (events.ts treats it like a lagged receiver).
 *
 * The desktop app talks to its core in-process and never loses it, so none of this runs there.
 */

import { CircleCheck, CloudOff, RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';

import { onConnectionState } from '@/api/events';
import { notifyServerAnswered } from '@/api/reachability';
import { isDesktop } from '@/api/transport';
import { Button, cn } from '@/ui';

/** How long the socket may be down before the strip shows: a quick reconnect stays silent. */
export const OFFLINE_GRACE_MS = 3000;
/** How long "Back online" stays up once the socket reopened. */
export const BACK_ONLINE_MS = 2500;

interface ConnectionStore {
  /** The strip shows: the event socket has been down for OFFLINE_GRACE_MS. */
  offline: boolean;
  /** The socket came back after the strip showed; "Back online" is up. */
  backOnline: boolean;
}

export const useConnectionStore = create<ConnectionStore>(() => ({ offline: false, backOnline: false }));

/** True while the shell's offline strip is up: the rail and Home then wait quietly instead of showing errors. */
export function useOffline(): boolean {
  return useConnectionStore((s) => s.offline);
}

/** Follows the event socket and drives the strip. Mount once (the shell does). Renders nothing. */
export function ConnectionWatcher() {
  useEffect(() => {
    if (isDesktop) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let backTimer: ReturnType<typeof setTimeout> | null = null;
    const off = onConnectionState((s) => {
      if (s === 'open') {
        if (timer) clearTimeout(timer);
        timer = null;
        if (!useConnectionStore.getState().offline) return;
        useConnectionStore.setState({ offline: false, backOnline: true });
        if (backTimer) clearTimeout(backTimer);
        backTimer = setTimeout(() => useConnectionStore.setState({ backOnline: false }), BACK_ONLINE_MS);
        return;
      }
      // 'closed' after a drop, and also a page that never connected (server down at load).
      if (s === 'closed' && !timer && !useConnectionStore.getState().offline) {
        timer = setTimeout(() => {
          timer = null;
          if (backTimer) clearTimeout(backTimer);
          useConnectionStore.setState({ offline: true, backOnline: false });
        }, OFFLINE_GRACE_MS);
      }
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
      if (backTimer) clearTimeout(backTimer);
      useConnectionStore.setState({ offline: false, backOnline: false });
    };
  }, []);
  return null;
}

/**
 * Asks the server's health endpoint once. An answer tells the event socket to reconnect now
 * instead of waiting out its backoff (the same nudge an answered RPC gives).
 */
async function probeServer(): Promise<boolean> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) return false;
    notifyServerAnswered();
    return true;
  } catch {
    return false;
  }
}

/** The strip under the header. A status region: it is announced once, politely, as it appears. */
export function ConnectionBanner() {
  const { t } = useTranslation('shell');
  const offline = useConnectionStore((s) => s.offline);
  const backOnline = useConnectionStore((s) => s.backOnline);
  const [probing, setProbing] = useState(false);
  if (!offline && !backOnline) return null;
  const retry = () => {
    setProbing(true);
    void probeServer().finally(() => setProbing(false));
  };
  return (
    <div
      role="status"
      data-testid="connection-banner"
      data-state={offline ? 'offline' : 'online'}
      className={cn(
        'flex min-h-9 shrink-0 items-center gap-3 border-b px-(--page-gutter) py-1 text-body-sm motion-safe:animate-fade-in',
        offline ? 'border-warning/40 bg-warning/10 text-fg' : 'border-success/40 bg-success/10 text-fg',
      )}
    >
      {offline ? (
        <>
          <CloudOff aria-hidden size={16} className="shrink-0 text-warning" />
          <p className="min-w-0 flex-1">
            <span className="font-medium">{t('connectionLost')}</span> <span className="text-fg-muted">{t('connectionLostHint')}</span>
          </p>
          <Button size="sm" variant="ghost" loading={probing} icon={<RotateCw aria-hidden size={14} />} onClick={retry} className="-me-2">
            {t('retry', { ns: 'common' })}
          </Button>
        </>
      ) : (
        <>
          <CircleCheck aria-hidden size={16} className="shrink-0 text-success" />
          <p className="min-w-0 flex-1 font-medium">{t('connectionBack')}</p>
        </>
      )}
    </div>
  );
}
