/**
 * App events (SPEC C1). One shared upstream subscription per page:
 * desktop listens to Tauri `app-event`; web opens a WebSocket to `/api/events`
 * and reconnects with jittered exponential backoff while anyone is subscribed.
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { onServerAnswered } from './reachability';
import { isDesktop } from './transport';
import type { AppEvent, AppEventMap, AppEventType } from './types';

type Handler = (payload: unknown) => void;
type AnyHandler = (event: AppEvent) => void;

export type ConnectionState = 'connecting' | 'open' | 'closed';

const handlers = new Map<string, Set<Handler>>();
const anyHandlers = new Set<AnyHandler>();
const stateHandlers = new Set<(s: ConnectionState) => void>();

let connectionState: ConnectionState = 'closed';
let stopUpstream: (() => void) | null = null;

const BACKOFF_MIN_MS = 500;
// Low cap: a restarted server is noticed within about 5 s even without a focus or RPC nudge.
const BACKOFF_MAX_MS = 4_000;
/**
 * While a reconnect is further off than this, `GET /api/health` is asked every this often, and an
 * answer reconnects at once (L3-app-10: a page that errored during an outage kept "Couldn't reach
 * the server" for up to 4 s after the server was back). One small request a second, only while
 * the socket is down.
 */
export const HEALTH_POLL_MS = 1_000;

function setState(s: ConnectionState): void {
  if (s === connectionState) return;
  connectionState = s;
  for (const h of stateHandlers) h(s);
}

function safeCall(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error('[events] handler failed', err);
  }
}

function dispatch(event: AppEvent): void {
  if (!event || typeof event.type !== 'string') return;
  for (const h of anyHandlers) safeCall(() => h(event));
  const set = handlers.get(event.type);
  if (!set) return;
  for (const h of [...set]) safeCall(() => h(event.payload));
}

function subscriberCount(): number {
  let n = anyHandlers.size;
  for (const s of handlers.values()) n += s.size;
  return n;
}

function startDesktop(): () => void {
  let unlisten: UnlistenFn | null = null;
  let stopped = false;
  setState('connecting');
  listen<AppEvent>('app-event', (e) => dispatch(e.payload))
    .then((fn) => {
      if (stopped) {
        fn();
      } else {
        unlisten = fn;
        setState('open');
      }
    })
    .catch((err: unknown) => {
      console.error('[events] listen failed', err);
      setState('closed');
    });
  return () => {
    stopped = true;
    unlisten?.();
    setState('closed');
  };
}

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/events`;
}

function startWeb(): () => void {
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = false;
  // Set once a socket closed or failed to connect: the next open may have missed events.
  let tried = false;
  let healthTimer: ReturnType<typeof setTimeout> | null = null;

  const stopHealth = (): void => {
    if (healthTimer) clearTimeout(healthTimer);
    healthTimer = null;
  };
  const armHealth = (): void => {
    if (!healthTimer && typeof fetch === 'function') healthTimer = setTimeout(probeHealth, HEALTH_POLL_MS);
  };
  function probeHealth(): void {
    healthTimer = null;
    if (stopped || !timer) return;
    fetch('/api/health', { cache: 'no-store' })
      .then((r) => {
        if (r.ok) retryNow();
      })
      .catch(() => undefined)
      .finally(() => {
        // Still waiting out the backoff: ask again in a second.
        if (!stopped && timer) armHealth();
      });
  }

  const schedule = (): void => {
    tried = true;
    setState('closed');
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
    const delay = Math.min(BACKOFF_MAX_MS, base + Math.random() * base * 0.3);
    attempt += 1;
    timer = setTimeout(connect, delay);
    if (delay > HEALTH_POLL_MS) armHealth();
  };

  function connect(): void {
    timer = null;
    stopHealth();
    if (stopped) return;
    setState('connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl());
    } catch {
      schedule();
      return;
    }
    ws = socket;
    socket.onopen = () => {
      attempt = 0;
      setState('open');
      // Events sent while the socket was down are lost, and RPCs made while the server
      // was unreachable failed (a page opened during a restart). Treat any open after a
      // closed or failed socket like a lagged receiver so every cached query is refetched.
      if (tried) dispatch({ type: 'events.lagged', payload: { skipped: 0 } } as AppEvent);
      tried = true;
    };
    socket.onmessage = (msg: MessageEvent) => {
      if (typeof msg.data !== 'string') return;
      let parsed: AppEvent;
      try {
        parsed = JSON.parse(msg.data) as AppEvent;
      } catch {
        return; // malformed frame
      }
      dispatch(parsed);
    };
    socket.onclose = () => {
      ws = null;
      if (!stopped) schedule();
    };
    // onerror is always followed by onclose, which schedules the reconnect.
  }

  /** Skips the backoff wait: the server looks reachable again (focus, online, an RPC answered). */
  const retryNow = (): void => {
    if (stopped || !timer) return;
    clearTimeout(timer);
    attempt = 0;
    connect();
  };
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') retryNow();
  };
  window.addEventListener('online', retryNow);
  window.addEventListener('focus', retryNow);
  document.addEventListener('visibilitychange', onVisible);
  const offAnswered = onServerAnswered(retryNow);

  connect();
  return () => {
    stopped = true;
    window.removeEventListener('online', retryNow);
    window.removeEventListener('focus', retryNow);
    document.removeEventListener('visibilitychange', onVisible);
    offAnswered();
    stopHealth();
    if (timer) clearTimeout(timer);
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
    setState('closed');
  };
}

function ensureUpstream(): void {
  if (stopUpstream || typeof window === 'undefined') return;
  stopUpstream = isDesktop ? startDesktop() : startWeb();
}

function releaseUpstream(): void {
  if (subscriberCount() === 0 && stopUpstream) {
    stopUpstream();
    stopUpstream = null;
  }
}

/** Subscribe to one event type. Returns an unsubscribe function. */
export function onAppEvent<K extends AppEventType>(type: K, handler: (payload: AppEventMap[K]) => void): () => void;
export function onAppEvent<T = unknown>(type: string, handler: (payload: T) => void): () => void;
export function onAppEvent(type: string, handler: Handler): () => void {
  let set = handlers.get(type);
  if (!set) {
    set = new Set();
    handlers.set(type, set);
  }
  set.add(handler);
  ensureUpstream();
  return () => {
    const s = handlers.get(type);
    s?.delete(handler);
    if (s && s.size === 0) handlers.delete(type);
    releaseUpstream();
  };
}

/** Subscribe to every event (query invalidation, debug views). */
export function onAnyAppEvent(handler: AnyHandler): () => void {
  anyHandlers.add(handler);
  ensureUpstream();
  return () => {
    anyHandlers.delete(handler);
    releaseUpstream();
  };
}

/** Observe the event connection. Called immediately with the current state. */
export function onConnectionState(handler: (s: ConnectionState) => void): () => void {
  stateHandlers.add(handler);
  handler(connectionState);
  return () => {
    stateHandlers.delete(handler);
  };
}

export function getConnectionState(): ConnectionState {
  return connectionState;
}
