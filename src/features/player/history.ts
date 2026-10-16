/**
 * Live channels watched this session, most recent first: the previous-channel key (B) and the
 * channel history popover (Shift+B, the History button). Kept in memory only; a restart starts
 * a new history.
 */

import { create } from 'zustand';

import { itemKey, type ItemKey, type ItemRef, type PlayerSource } from '@/api/types';

import { failoverSwitchKey } from './failover';
import { showOsd } from './media';
import { onPlaybackHidden } from './parentalLocks';
import { isPendingZap, nowTitle, sourceKindOf, startItem, usePlayerStore, type PlayItemArgs } from './store';

export const HISTORY_LIMIT = 10;

export interface HistoryEntry {
  key: ItemKey;
  ref: ItemRef;
  title: string;
  posterUrl?: string;
  isRadio: boolean;
}

interface HistoryState {
  entries: HistoryEntry[];
  /** The history popover of the live controls. */
  open: boolean;
}

export const useHistoryStore = create<HistoryState>()(() => ({ entries: [], open: false }));

export function setHistoryOpen(open: boolean): void {
  if (useHistoryStore.getState().open !== open) useHistoryStore.setState({ open });
}

/**
 * `entries` with `source` moved (or added) to the front, capped at HISTORY_LIMIT. `replaces`:
 * the entry this visit stands in for (another copy of the same channel), dropped. Pure.
 */
export function withVisit(entries: readonly HistoryEntry[], source: PlayerSource, replaces?: ItemKey): HistoryEntry[] {
  if (!source.isLive || !source.ref || !source.url) return [...entries];
  const key = itemKey(source.ref);
  const entry: HistoryEntry = { key, ref: source.ref, title: source.title, isRadio: source.isRadio };
  const old = entries.find((e) => e.key === key);
  const poster = source.posterUrl ?? old?.posterUrl;
  if (poster) entry.posterUrl = poster;
  return [entry, ...entries.filter((e) => e.key !== key && e.key !== replaces)].slice(0, HISTORY_LIMIT);
}

/** The channel B goes back to: the most recent entry that is not `currentKey`. Pure. */
export function previousEntry(entries: readonly HistoryEntry[], currentKey: ItemKey | undefined): HistoryEntry | undefined {
  return entries.find((e) => e.key !== currentKey);
}

/** Key of the live channel playing now, if any. */
export function currentLiveKey(): ItemKey | undefined {
  const s = usePlayerStore.getState().source;
  return s?.isLive && s.ref ? itemKey(s.ref) : undefined;
}

export function recordVisit(source: PlayerSource | undefined, replaces?: ItemKey): void {
  if (!source?.isLive || !source.ref || !source.url) return;
  const { entries } = useHistoryStore.getState();
  const next = withVisit(entries, source, replaces);
  const head = entries[0];
  const same = head && next[0] && head.key === next[0].key && head.title === next[0].title && head.posterUrl === next[0].posterUrl;
  if (!same || next.length !== entries.length) useHistoryStore.setState({ entries: next });
}

/**
 * The entry a source change stands in for: failover moving a channel to another copy (or a pin
 * redirect, or its undo) is still the same channel, so B must not lead back to the copy it left.
 */
function replacedBy(source: PlayerSource | undefined, prev: PlayerSource | undefined): ItemKey | undefined {
  const key = source?.ref ? itemKey(source.ref) : undefined;
  if (!key || key !== failoverSwitchKey() || !prev?.isLive || !prev.ref) return undefined;
  const prevKey = itemKey(prev.ref);
  return prevKey === key ? undefined : prevKey;
}

let lastSource = usePlayerStore.getState().source;
recordVisit(lastSource);
usePlayerStore.subscribe((s) => {
  // A zap's placeholder (channels passed on the way) is not a visit; the channel it tunes is.
  if (s.source === lastSource || isPendingZap(s.source)) return;
  const prev = lastSource;
  lastSource = s.source;
  recordVisit(s.source, replacedBy(s.source, prev));
  // Leaving live TV (or the player, or for radio, which has no popover) closes the popover, so
  // a Shift+B pressed meanwhile cannot pop it up later.
  if (useHistoryStore.getState().open && (!s.source?.isLive || s.mode === 'radio')) setHistoryOpen(false);
});

/** Drops the entries with these keys (channels parental controls hide now). */
export function dropHistoryEntries(keys: ReadonlySet<ItemKey>): void {
  const { entries } = useHistoryStore.getState();
  const next = entries.filter((e) => !keys.has(e.key));
  if (next.length !== entries.length) useHistoryStore.setState({ entries: next });
}

// A channel Hide mode refused to start (B, the history popover) is out of reach: drop it, so
// B goes to the channel before it instead of knocking on the locked one again.
onPlaybackHidden((item) => dropHistoryEntries(new Set([itemKey(item.ref)])));

/** Plays a history entry, titled like a zap: the channel name, subtitled with what airs now. */
export async function playHistoryEntry(entry: HistoryEntry): Promise<void> {
  // The guide is asked alongside the gate and the stream lookup (the player's shared cache).
  const subtitle = nowTitle(entry.ref);
  const sourceKind = await sourceKindOf(entry.ref.sourceId);
  const args: PlayItemArgs = { ref: entry.ref, title: entry.title, isLive: true, isRadio: entry.isRadio, sourceKind };
  if (entry.posterUrl) args.posterUrl = entry.posterUrl;
  // The readout only once the parental gate let it through (no locked name behind a PIN prompt).
  await startItem(args, { onAllowed: () => showOsd(entry.title), subtitle });
}

/** Switches to the previous channel. Returns it, or undefined when there is none yet. */
export function playPreviousChannel(): HistoryEntry | undefined {
  const entry = previousEntry(useHistoryStore.getState().entries, currentLiveKey());
  if (entry) void playHistoryEntry(entry).catch(() => undefined);
  return entry;
}

/** Testing only. */
export function __resetHistoryForTests(): void {
  lastSource = undefined;
  useHistoryStore.setState({ entries: [], open: false });
}
