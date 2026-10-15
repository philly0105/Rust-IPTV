/**
 * Parental status in the query cache (contract C2).
 *
 * `parental.status` lives under the usual `[cmd, null]` key. The
 * `parental.changed` event and every command that answers with a status write
 * it through {@link applyStatus}, which also refreshes whatever the change
 * can affect: the lock list always, and the catalog and user-state lists when
 * what Hide mode filters out may have changed.
 */

import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { onAppEvent } from '@/api/events';
import { invalidate, queryClient, rpcKey, useRpcQuery } from '@/api/query';
import { rpc, RpcError } from '@/api/transport';
import type { ParentalStatus } from '@/api/types';
import { useShortcut } from '@/shell/shortcuts';
import { toast } from '@/ui';

/** Query key of `parental.status`. */
export const STATUS_KEY = rpcKey('parental.status');

/** How long a cached status is trusted without an event (events keep it current). */
export const STATUS_STALE_MS = 30_000;

/**
 * Reads the core filters in Hide mode (C2), refreshed when that filter
 * changes: the catalog and user state (My List follows them), custom lists
 * (`lists.list` counts, `lists.items`), guide search and watch stats.
 * `epg.search` is exact so the other `epg.` queries are left alone.
 * Portal reads too: Stalker VOD pages and search are not in SQLite, so the
 * core drops hidden titles from them itself, and the Xtream and Stalker
 * detail commands refuse a hidden title. Their stream and catch-up URLs are
 * never cached.
 */
export const FILTERED_PREFIXES = [
  'catalog.',
  'favorites.',
  'recent.',
  'positions.',
  'watchlist.',
  'lists.',
  'epg.search',
  'stats.',
  'stalker.movies',
  'stalker.series',
  'stalker.search',
  'stalker.vodDetail',
  'stalker.seriesDetail',
  'xtream.vodDetail',
  'xtream.seriesDetail',
] as const;

/** Parental queries that follow every change (the lock list and lock checks). */
const PARENTAL_PREFIXES = ['parental.locks', 'parental.check'] as const;

/**
 * Parental queries a source import or removal can change: adult categories
 * follow category names, and lock checks look up an item's category.
 */
const SOURCE_PREFIXES = ['parental.adultCategories', ...PARENTAL_PREFIXES] as const;

function isFiltered(key: readonly unknown[]): boolean {
  const head = key[0];
  return typeof head === 'string' && FILTERED_PREFIXES.some((p) => head.startsWith(p));
}

/**
 * Refreshes every {@link FILTERED_PREFIXES} query. When Hide mode filters
 * after the change (a lock, an unlock running out, a lock added), data cached
 * before it may hold what is now hidden, and a later visit would draw it from
 * the cache before refetching. So the queries nothing shows right now are
 * dropped; the ones on screen refetch in place, and a detail the core now
 * refuses turns into its error state.
 */
function refreshFiltered(hiding: boolean): void {
  if (hiding) queryClient.removeQueries({ predicate: (q) => q.getObserversCount() === 0 && isFiltered(q.queryKey) });
  for (const p of FILTERED_PREFIXES) void invalidate(p);
}

/** `parental.status`, kept current by {@link useParentalEvents}. */
export function useParentalStatus(): UseQueryResult<ParentalStatus, RpcError> {
  return useRpcQuery('parental.status', undefined, { staleTime: STATUS_STALE_MS });
}

/** True while the core drops locked content from every list (C2 Hide mode). */
export function hidesContent(s: ParentalStatus): boolean {
  return s.enabled && s.mode === 'hide' && !s.unlocked;
}

/**
 * Whether going from `prev` to `next` can change what the catalog lists show.
 *
 * Only Hide mode filters in the core, so nothing changes unless it was or is
 * filtering. While it keeps filtering, a wrong PIN only moves the attempt
 * counter; an otherwise identical status is a lock added or removed.
 */
export function catalogAffected(prev: ParentalStatus | undefined, next: ParentalStatus): boolean {
  if (!prev) return true;
  const was = hidesContent(prev);
  const now = hidesContent(next);
  if (was !== now) return true;
  if (!now) return false;
  if (prev.autoAdult !== next.autoAdult) return true;
  return prev.failedAttempts === next.failedAttempts && prev.retryAfterSeconds === next.retryAfterSeconds;
}

/**
 * Writes a status the core sent (event or command result) into the cache and
 * refreshes what depends on it.
 */
export function applyStatus(next: ParentalStatus): void {
  const prev = queryClient.getQueryData<ParentalStatus>(STATUS_KEY);
  queryClient.setQueryData(STATUS_KEY, next);
  for (const p of PARENTAL_PREFIXES) void invalidate(p);
  if (catalogAffected(prev, next)) refreshFiltered(hidesContent(next));
}

/**
 * Refreshes what a lock added or removed can change, without waiting for the
 * `parental.changed` event: the lock list and checks, and the catalog while
 * Hide mode filters it.
 */
export function afterLockChange(): void {
  for (const p of PARENTAL_PREFIXES) void invalidate(p);
  const s = queryClient.getQueryData<ParentalStatus>(STATUS_KEY);
  if (s && hidesContent(s)) refreshFiltered(true);
}

/** Fetches the status from the core and applies it. */
export async function refreshStatus(): Promise<ParentalStatus> {
  const next = await rpc('parental.status');
  applyStatus(next);
  return next;
}

/**
 * Ends the session unlock at once (`parental.lockNow`) and applies the new
 * status. For the settings button and a "lock now" shortcut or palette entry.
 */
export async function lockNow(): Promise<ParentalStatus> {
  const next = await rpc('parental.lockNow');
  applyStatus(next);
  return next;
}

/**
 * Mod+Alt+L locks at once, bound only while a session unlock is active.
 * Not while typing: on Windows Ctrl+Alt is AltGr, and AltGr+L types a letter
 * on some layouts (Polish "ł").
 */
function useLockNowShortcut(s: ParentalStatus | undefined): void {
  const { t } = useTranslation('parental');
  useShortcut(
    'mod+alt+l',
    () =>
      void lockNow().then(
        () => toast({ variant: 'success', title: t('lockedNowToast') }),
        (err: unknown) => toast({ variant: 'error', title: t('saveFailed'), description: RpcError.from(err).message }),
      ),
    { description: t('shortcutLockNow'), area: t('shell:settingsParental'), enabled: !!s?.enabled && s.unlocked },
  );
}

/**
 * True when the core reported, at or after `since` (a `Date.now()` value),
 * that locked content may open: controls off or a session unlock active.
 * Lets a PIN request that raced an unlock (another dialog, another window)
 * through without asking again. Older cached data never counts.
 */
export function allowedSince(since: number): boolean {
  const state = queryClient.getQueryState<ParentalStatus>(STATUS_KEY);
  const s = state?.data;
  return !!s && state.dataUpdatedAt >= since && (!s.enabled || s.unlocked);
}

/** The cached status when fresh, else the core's answer. */
export function currentStatus(): Promise<ParentalStatus> {
  return queryClient.fetchQuery({
    queryKey: STATUS_KEY,
    queryFn: () => rpc('parental.status'),
    staleTime: STATUS_STALE_MS,
  });
}

/** Milliseconds until a timed unlock runs out, or null when none is running. */
export function unlockRemainingMs(s: ParentalStatus | undefined, now = Date.now()): number | null {
  if (!s?.unlocked || !s.unlockedUntil) return null;
  const until = Date.parse(s.unlockedUntil);
  return Number.isFinite(until) ? Math.max(0, until - now) : null;
}

/** Small grace after the deadline, so the core has expired the unlock when we ask. */
const EXPIRY_GRACE_MS = 750;

/**
 * Subscribes to `parental.changed` (C2/C7): the payload becomes the cached
 * status, and the lock list, lock checks, and (when Hide mode's filter
 * changed) every query in {@link FILTERED_PREFIXES} refetch. A finished
 * import or a source change refreshes the adult categories and lock checks.
 * Also asks the core again when a timed unlock runs out, in case the event
 * stream is down at that moment, and binds the lock-now shortcut. Mount once,
 * in the shell's effects.
 */
export function useParentalEvents(): void {
  useEffect(() => onAppEvent('parental.changed', (status) => applyStatus(status)), []);
  useEffect(() => {
    const refresh = () => {
      for (const p of SOURCE_PREFIXES) void invalidate(p);
    };
    const offs = [
      onAppEvent('sources.changed', refresh),
      onAppEvent('import.progress', (p) => {
        if (p.phase === 'done') refresh();
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  const { data } = useParentalStatus();
  useLockNowShortcut(data);
  const remaining = unlockRemainingMs(data);
  useEffect(() => {
    if (remaining === null) return;
    const id = setTimeout(() => void refreshStatus().catch(() => undefined), remaining + EXPIRY_GRACE_MS);
    return () => clearTimeout(id);
    // The deadline, not the ms count (which changes every render), decides the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.unlocked, data?.unlockedUntil]);
}
