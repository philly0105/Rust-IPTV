/**
 * Every read the Sports page sends to the core: the groups list, the group pages, the network searches, the
 * guide chunks and the fallback searches. At most {@link PAGE_READS} are in flight at once and the rest wait
 * their turn in the order they were asked. The core has 8 database connections that every page reads
 * through, and on desktop a sent call cannot be cancelled, so on a big account (dozens of group pages, about
 * 60 network searches, a guide chunk per 500 channels) the page would otherwise take every connection, and
 * leave its calls running after the user moved on. A read whose signal aborts while it waits is never sent.
 */

import { rpcRaw } from '@/api/transport';

/** Sports reads in flight at once: leaves at least 3 of the core's 8 connections to the other pages. */
export const PAGE_READS = 5;

let running = 0;
const waiting: (() => void)[] = [];

/** Takes a slot, waiting in line when all are taken; rejects with the signal's reason when it aborts first. */
function acquire(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (running < PAGE_READS) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const start = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => {
      waiting.splice(waiting.indexOf(start), 1);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    waiting.push(start);
  });
}

/** A finished read hands its slot to the next in line. */
function release(): void {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

/** `rpcRaw` behind the page-wide limit. */
export async function sportsRead(cmd: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
  await acquire(signal);
  try {
    return await rpcRaw(cmd, args, { signal });
  } finally {
    release();
  }
}
