/**
 * "Prefer this source" pins for live channels, the live counterpart of the VOD pins
 * (`features/vod/lib/pins.ts`). Kept in localStorage, keyed by the channel's match key from
 * `live.alternates` ("sky sports 1"), so one pin covers every copy of the channel.
 */

import { useCallback, useSyncExternalStore } from 'react';

import type { ItemRef } from '@/api/types';

const STORAGE_KEY = 'live.sourcePins.v1';

export interface LivePin {
  sourceId: string;
  itemId: string;
  updatedAt: string;
}

const listeners = new Set<() => void>();
let snapshot: Record<string, LivePin> | null = null;

function readAll(): Record<string, LivePin> {
  if (snapshot) return snapshot;
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    snapshot = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, LivePin>) : {};
  } catch {
    snapshot = {};
  }
  return snapshot;
}

function writeAll(pins: Record<string, LivePin>): void {
  snapshot = pins;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(pins));
  } catch {
    // Storage full or unavailable: the pin still holds for this session.
  }
  for (const l of listeners) l();
}

export function getLivePin(key: string): LivePin | undefined {
  return key ? readAll()[key] : undefined;
}

export function setLivePin(key: string, ref: ItemRef): void {
  if (!key) return;
  writeAll({ ...readAll(), [key]: { sourceId: ref.sourceId, itemId: ref.itemId, updatedAt: new Date().toISOString() } });
}

export function clearLivePin(key: string): void {
  if (!key || !readAll()[key]) return;
  const { [key]: _gone, ...rest } = readAll();
  writeAll(rest);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The pin for `key` (re-renders when any pin changes), plus a setter (`null` clears). */
export function useLivePin(key: string | undefined): [LivePin | undefined, (ref: ItemRef | null) => void] {
  const pin = useSyncExternalStore(subscribe, () => (key ? readAll()[key] : undefined));
  const update = useCallback(
    (ref: ItemRef | null) => {
      if (!key) return;
      if (ref) setLivePin(key, ref);
      else clearLivePin(key);
    },
    [key],
  );
  return [pin, update];
}

/** Testing only. */
export function __resetLivePins(): void {
  snapshot = null;
}
