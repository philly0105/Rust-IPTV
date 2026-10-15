/**
 * Web mode: "the server just answered an RPC". The transport reports it and
 * the event socket listens, so a socket waiting out its reconnect backoff
 * reconnects at once when the server is evidently back. A module of its own
 * so neither side imports the other (tests mock each one separately).
 */

const listeners = new Set<() => void>();

/** Called by the transport after the server answered an RPC. */
export function notifyServerAnswered(): void {
  for (const fn of listeners) fn();
}

/** Subscribe to {@link notifyServerAnswered}. Returns an unsubscribe function. */
export function onServerAnswered(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
