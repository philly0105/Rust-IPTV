/**
 * App events (SPEC C1). One shared upstream subscription per page:
 * desktop listens to Tauri `app-event`; web opens a WebSocket to `/api/events`
 * and reconnects with jittered exponential backoff while anyone is subscribed.
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';

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
const BACKOFF_MAX_MS = 15_000;

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

  const schedule = (): void => {
    setState('closed');
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
    const delay = Math.min(BACKOFF_MAX_MS, base + Math.random() * base * 0.3);
    attempt += 1;
    timer = setTimeout(connect, delay);
  };

  function connect(): void {
    timer = null;
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

  connect();
  return () => {
    stopped = true;
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
