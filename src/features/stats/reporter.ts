/**
 * Watch stats reporter (Run 2 contract C7). Mounted once in the shell effects.
 *
 * Reads the player store, never writes it. Wall time counts while the store
 * says `playing`, the source has a catalog ref and the mode is not
 * `external` (an external player's time is unknown). Each accounting step is
 * capped at `MAX_TICK_MS`, so a laptop that sleeps mid-film adds 2 s, not the
 * night. Episodes count under the series ref, which is `PlayerSource.ref` for
 * an episode; local files (no ref) and multi-view tiles (not in the store)
 * are not counted.
 *
 * Time is sent as one `stats.record` per flush: every `FLUSH_MS` while
 * playing, and whenever counting stops (pause, stop, a different item, the
 * page unloading). The unload flush goes out with `keepalive` on
 * `beforeunload`, before the navigation starts (a send made only in
 * `pagehide`, during the navigation, was seen to stall in Chromium until the
 * tab closed), and again on `pagehide` for what is left (browsers that skip
 * `beforeunload`); a reload, a full navigation or a closed tab does not lose
 * it on the web. The day is the local date at flush time. Whole seconds are
 * sent; the remainder carries over to the next periodic flush and is rounded
 * on the last one. A failed flush is dropped rather than retried, so a call
 * that timed out after landing is never counted twice; at most one flush
 * (30 s) is lost.
 *
 * Kept free of React rendering and i18n: it lives in the entry chunk.
 */

import { useEffect } from 'react';

import { rpc, rpcRaw, type RpcArgs } from '@/api/transport';
import { itemKey, type ItemRef } from '@/api/types';
import { usePlayerStore, type PlayerState } from '@/features/player/store';

/** How often the reporter accounts time while something plays. */
export const TICK_MS = 1_000;
/** Longest gap one accounting step may count (sleep and suspend count as this). */
export const MAX_TICK_MS = 2_000;
/** A periodic flush happens this long after the previous one. */
export const FLUSH_MS = 30_000;
/** Most seconds `stats.record` accepts per call (`MAX_RECORD_SECONDS` in the core). */
export const MAX_RECORD_SECONDS = 300;
/** Longest title the core accepts (`MAX_TITLE_CHARS`). */
export const MAX_TITLE_CHARS = 300;

/** Local calendar date of `d` as `YYYY-MM-DD`. */
export function localDay(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface Session {
  ref: ItemRef;
  key: string;
  title: string;
  posterUrl?: string;
}

function cut(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join('').trimEnd();
}

/** What the store is playing, as far as stats go; null when it does not count. */
function sessionOf(s: Pick<PlayerState, 'source' | 'mode'>): Session | null {
  const src = s.source;
  if (!src?.ref || s.mode === 'external') return null;
  const title = cut(src.title.trim(), MAX_TITLE_CHARS) || src.ref.itemId;
  const session: Session = { ref: src.ref, key: itemKey(src.ref), title };
  if (src.posterUrl) session.posterUrl = src.posterUrl;
  return session;
}

/**
 * Starts reporting and returns the stop function (which flushes what is
 * pending). `useWatchStatsReporter` is the React form; tests call this.
 */
export function startWatchStatsReporter(): () => void {
  let session: Session | null = null;
  let pendingMs = 0;
  /** Time of the last accounting step while counting; null while not counting. */
  let lastTick: number | null = null;
  let lastFlush = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;

  const account = () => {
    if (lastTick === null) return;
    const now = Date.now();
    pendingMs += Math.min(Math.max(now - lastTick, 0), MAX_TICK_MS);
    lastTick = now;
  };

  /**
   * Sends the pending whole seconds; `final` rounds the remainder instead of
   * keeping it. `unloading` (beforeunload, pagehide) sends with `keepalive`.
   */
  const flush = (final: boolean, unloading = false) => {
    lastFlush = Date.now();
    const s = session;
    if (!s) {
      pendingMs = 0;
      return;
    }
    let seconds = Math.floor((final ? pendingMs + 500 : pendingMs) / 1000);
    pendingMs = final ? 0 : Math.max(pendingMs - seconds * 1000, 0);
    if (seconds <= 0) return;
    const day = localDay(new Date(lastFlush));
    while (seconds > 0) {
      const chunk = Math.min(seconds, MAX_RECORD_SECONDS);
      seconds -= chunk;
      const args: RpcArgs<'stats.record'> = {
        ref: s.ref,
        title: s.title,
        ...(s.posterUrl ? { posterUrl: s.posterUrl } : {}),
        seconds: chunk,
        day,
      };
      void (unloading ? rpcRaw('stats.record', args, { keepalive: true }) : rpc('stats.record', args)).catch(() => undefined);
    }
  };

  const tick = () => {
    account();
    if (Date.now() - lastFlush >= FLUSH_MS) flush(false);
  };

  const stopTimer = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  const sync = (state: PlayerState) => {
    // Charge the time since the last step to what was counting until now.
    account();
    const next = sessionOf(state);
    const counting = next !== null && state.status === 'playing';
    const changed = !next || !session || next.key !== session.key;
    if (session && (changed || (!counting && lastTick !== null))) flush(true);
    if (changed) {
      pendingMs = 0;
      lastFlush = Date.now();
    }
    session = next;
    if (counting && lastTick === null) {
      lastTick = Date.now();
      lastFlush = Date.now();
      timer ??= setInterval(tick, TICK_MS);
    } else if (!counting && lastTick !== null) {
      lastTick = null;
      stopTimer();
    }
  };

  const onUnload = () => {
    account();
    flush(true, true);
  };

  const unsubscribe = usePlayerStore.subscribe(sync);
  sync(usePlayerStore.getState());
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('pagehide', onUnload);
  }

  return () => {
    unsubscribe();
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('pagehide', onUnload);
    }
    account();
    flush(true);
    lastTick = null;
    session = null;
    stopTimer();
  };
}

/** Mounted once by the shell (effects): reports watch time for the stats page. */
export function useWatchStatsReporter(): void {
  useEffect(() => startWatchStatsReporter(), []);
}
