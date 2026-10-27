/**
 * Failover: switching a failed stream to the same title elsewhere.
 *
 * VOD (`settings.vodAutoFailover`): when a movie fails fatally, look for the same title on
 * another source (`catalog.sameTitle`) and switch once. An undo toast replays the original.
 *
 * Live (`settings.liveFailover`): when a channel fails for good (smart reconnect gave up, or the
 * error cannot fix itself), switch to the best copy from `live.alternates`, trying the next one
 * when a copy fails before it ever played. Every switch of one failure chain is remembered, so
 * it never returns to a copy it already tried; the chain ends when the user plays something
 * else. Undo goes back to the original and stops automatic switching for it until then.
 */

import i18next from 'i18next';
import { create } from 'zustand';

import { rpc } from '@/api/transport';
import { itemKey, type ItemKey, type ItemRef, type LiveAlternate, type LiveAlternates, type PlayerSource } from '@/api/types';
import { displayChannelName } from '@/features/live/lib/channelName';
import { liveQualityKey } from '@/lib/liveQuality';
import { dismissToast, toast } from '@/ui';

import type { StreamErrorClass } from './errors';
import { getLivePin } from './livePins';
import {
  getSettings,
  isPendingZap,
  knownSourceKind,
  MIN_RESUME_SECONDS,
  peekSettings,
  playItem,
  resolveSource,
  sameSource,
  sourceKindOf,
  subscribeSettings,
  usePlayerStore,
  type PlayItemArgs,
} from './store';

const attempted = new Set<string>();

export interface FailoverResult {
  sourceName: string;
  to: PlayerSource;
  undo(): void;
}

export async function tryFailover(failed: PlayerSource): Promise<FailoverResult | null> {
  const ref = failed.ref;
  if (!ref || failed.isLive || ref.contentType !== 'movie') return null;
  const settings = await getSettings();
  if (!settings?.vodAutoFailover) return null;
  const key = itemKey(ref);
  if (attempted.has(key)) return null;
  attempted.add(key);

  let candidates;
  try {
    // Stalker VOD is paged live from the portal, not stored in the local catalog, so the core's
    // same-title lookup answers not_found (a console resource error in the browser). Only a
    // known source that is not Stalker is asked, as on the movie page.
    if ((await sourceKindOf(ref.sourceId)) === 'stalker') return null;
    candidates = await rpc('catalog.sameTitle', { ref });
  } catch {
    return null;
  }
  const alt =
    candidates.find((c) => c.ref.sourceId !== ref.sourceId && !attempted.has(itemKey(c.ref))) ??
    candidates.find((c) => c.ref.itemId !== ref.itemId && !attempted.has(itemKey(c.ref)));
  if (!alt) return null;

  // The user may have moved on while we looked.
  if (!sameSource(usePlayerStore.getState().source, failed)) return null;

  try {
    const info = await rpc('sources.get', { id: alt.ref.sourceId });
    const position = usePlayerStore.getState().positionSeconds;
    const args: Parameters<typeof resolveSource>[0] = {
      ref: alt.ref,
      title: alt.title,
      isLive: false,
      sourceKind: info.kind,
    };
    const poster = alt.posterUrl ?? failed.posterUrl;
    if (poster) args.posterUrl = poster;
    const resolved = await resolveSource(args);
    if (!sameSource(usePlayerStore.getState().source, failed)) return null;
    attempted.add(itemKey(alt.ref));
    const to: PlayerSource = position > MIN_RESUME_SECONDS ? { ...resolved, resumeSeconds: position } : resolved;
    await usePlayerStore.getState().play(to);
    return {
      sourceName: info.name,
      to,
      undo: () => {
        const back: PlayerSource = { ...failed };
        const pos = usePlayerStore.getState().positionSeconds;
        if (pos > MIN_RESUME_SECONDS) back.resumeSeconds = pos;
        void usePlayerStore.getState().play(back);
      },
    };
  } catch {
    return null;
  }
}

/** VOD failover with its undo toast (the player shows the error meanwhile). */
export function failoverVod(failed: PlayerSource): void {
  void tryFailover(failed).then((res) => {
    if (!res) return;
    toast({
      title: i18next.t('player:failoverSwitched'),
      description: i18next.t('player:failoverSwitchedDetail', { title: failed.title, source: res.sourceName }),
      variant: 'info',
      action: { label: i18next.t('player:undo'), onClick: res.undo },
    });
  });
}

// ---------------------------------------------------------------------------
// Live alternates: lookup cache and the current channel's list for the menu
// ---------------------------------------------------------------------------

/** Lookups are cheap but channels are zapped often; a short-lived cache keeps zaps instant. */
const ALTERNATES_TTL_MS = 5 * 60_000;
const ALTERNATES_CACHE_MAX = 64;
const alternatesCache = new Map<ItemKey, { at: number; value: Promise<LiveAlternates> }>();
/** Bumped when the Live TV quality filter changes: a lookup made before then answers for the old filter. */
let alternatesGen = 0;

/** Live and radio refs only: anything else is not a channel and the core would refuse it. */
export function isChannelRef(ref: ItemRef | undefined): ref is ItemRef {
  return !!ref && (ref.contentType === 'live' || ref.contentType === 'radio');
}

export function loadAlternates(ref: ItemRef): Promise<LiveAlternates> {
  const key = itemKey(ref);
  const hit = alternatesCache.get(key);
  if (hit && Date.now() - hit.at < ALTERNATES_TTL_MS) return hit.value;
  const value = rpc('live.alternates', { ref });
  alternatesCache.delete(key);
  alternatesCache.set(key, { at: Date.now(), value });
  // A failed lookup is not cached.
  value.catch(() => {
    if (alternatesCache.get(key)?.value === value) alternatesCache.delete(key);
  });
  while (alternatesCache.size > ALTERNATES_CACHE_MAX) {
    const oldest = alternatesCache.keys().next().value;
    if (oldest === undefined) break;
    alternatesCache.delete(oldest);
  }
  return value;
}

export interface AlternatesState {
  /** `itemKey` of the channel the list is for. */
  forKey?: ItemKey;
  status: 'idle' | 'loading' | 'ready' | 'error';
  data?: LiveAlternates;
}

/** The playing channel's alternates (the player's "Alternate sources" menu reads this). */
export const useAlternatesStore = create<AlternatesState>()(() => ({ status: 'idle' }));

/** Fills `useAlternatesStore` for `ref` (or clears it). */
export function trackAlternates(ref: ItemRef | undefined): void {
  if (!isChannelRef(ref)) {
    if (useAlternatesStore.getState().status !== 'idle') useAlternatesStore.setState({ forKey: undefined, status: 'idle', data: undefined });
    return;
  }
  const key = itemKey(ref);
  const cur = useAlternatesStore.getState();
  if (cur.forKey === key && cur.status !== 'error') return;
  useAlternatesStore.setState({ forKey: key, status: 'loading', data: undefined });
  const gen = alternatesGen;
  loadAlternates(ref).then(
    (data) => {
      if (gen !== alternatesGen) return;
      if (useAlternatesStore.getState().forKey === key) useAlternatesStore.setState({ status: 'ready', data });
      void maybeRedirectToPin(ref, data);
    },
    () => {
      if (gen === alternatesGen && useAlternatesStore.getState().forKey === key) useAlternatesStore.setState({ status: 'error' });
    },
  );
}

/** Pinned source first; otherwise the core's order (same quality tier, then source order). */
export function rankAlternates(data: LiveAlternates): LiveAlternate[] {
  const pin = getLivePin(data.key);
  if (!pin) return data.alternates;
  const exact = (a: LiveAlternate): boolean => a.channel.ref.sourceId === pin.sourceId && a.channel.ref.itemId === pin.itemId;
  const onSource = (a: LiveAlternate): boolean => a.channel.ref.sourceId === pin.sourceId;
  const score = (a: LiveAlternate): number => (exact(a) ? 0 : onSource(a) ? 1 : 2);
  return [...data.alternates].sort((a, b) => score(a) - score(b));
}

// ---------------------------------------------------------------------------
// Live failover
// ---------------------------------------------------------------------------

interface Chain {
  origin: PlayerSource & { ref: ItemRef };
  /** Every copy this chain played or tried, the original included. */
  tried: Set<ItemKey>;
  /** The copy now playing. */
  current: ItemKey;
  /** The current copy reached playback (a copy that fails before that is skipped at once). */
  played: boolean;
  /** Sources whose account was found full: their copies are skipped. */
  fullSources: Set<string>;
}

let chain: Chain | null = null;
/** The one toast a switch shows ("Switched to …", "Moved to your pinned source"), updated in place. */
const LIVE_FAILOVER_TOAST = 'live-failover';
/** Channels whose automatic switch the user undid: no more switching until another channel plays. */
const undone = new Set<ItemKey>();
/** Channels whose pin redirect the user undid. */
const pinUndone = new Set<ItemKey>();
/** The switch this module is making; its source change does not end the chain. */
let switching: ItemKey | null = null;

export interface LiveFailoverResult {
  alternate: LiveAlternate;
  to: PlayerSource;
  undo(): void;
}

function channelTitle(name: string): string {
  return displayChannelName(name, peekSettings()?.stripCountryPrefix) || name;
}

function argsForAlternate(alt: LiveAlternate, like: PlayerSource): PlayItemArgs {
  const args: PlayItemArgs = {
    ref: alt.channel.ref,
    title: channelTitle(alt.channel.name),
    isLive: true,
    isRadio: alt.channel.isRadio,
    sourceKind: alt.sourceKind,
  };
  const poster = alt.channel.logoUrl ?? like.posterUrl;
  if (poster) args.posterUrl = poster;
  if (like.subtitle) args.subtitle = like.subtitle;
  return args;
}

async function argsForSource(src: PlayerSource & { ref: ItemRef }): Promise<PlayItemArgs> {
  const args: PlayItemArgs = {
    ref: src.ref,
    title: src.title,
    isLive: src.isLive,
    isRadio: src.isRadio,
    sourceKind: knownSourceKind(src.ref.sourceId) ?? (await sourceKindOf(src.ref.sourceId)),
  };
  if (src.episodeId) args.episodeId = src.episodeId;
  if (src.subtitle) args.subtitle = src.subtitle;
  if (src.posterUrl) args.posterUrl = src.posterUrl;
  return args;
}

/**
 * The copy this module is switching playback to right now (a failover hop, a pin redirect, an
 * undo), or null. Channel history replaces the channel's entry for it instead of adding a visit.
 */
export function failoverSwitchKey(): ItemKey | null {
  return switching;
}

/** Back to `origin` (resolved again: Stalker links expire). */
function playOrigin(origin: PlayerSource & { ref: ItemRef }): void {
  const key = itemKey(origin.ref);
  switching = key;
  void argsForSource(origin)
    .then(
      (args) => playItem(args),
      () => usePlayerStore.getState().play(origin),
    )
    .catch(() => undefined)
    .finally(() => {
      if (switching === key) switching = null;
    });
}

/** True while `src` is a copy this chain just switched to and that has not played yet. */
export function isUntriedSwitch(src: PlayerSource | undefined): boolean {
  return !!chain && !!src?.ref && itemKey(src.ref) === chain.current && !chain.played;
}

/**
 * `ranked` without copies on accounts found full (`connectionLimit`: they would be refused the
 * same way). After a refusal (`auth`) on `sourceId`, that source's copies go last: the refusal
 * may concern the whole account, or just the one channel.
 */
export function forAccountFailure(
  ranked: LiveAlternate[],
  fullSources: ReadonlySet<string>,
  sourceId: string,
  cls: StreamErrorClass | undefined,
): LiveAlternate[] {
  const usable = ranked.filter((a) => !fullSources.has(a.channel.ref.sourceId));
  if (cls !== 'auth') return usable;
  const same = (a: LiveAlternate): boolean => a.channel.ref.sourceId === sourceId;
  return [...usable.filter((a) => !same(a)), ...usable.filter(same)];
}

/**
 * Switch the failed live channel to its next untried copy. Resolves to null when live
 * failover is off, the channel has no usable copy left, or the user moved on meanwhile.
 * `cls`: the failure's class, when known (see `forAccountFailure`).
 */
export async function tryLiveFailover(failed: PlayerSource, cls?: StreamErrorClass): Promise<LiveFailoverResult | null> {
  const ref = failed.ref;
  if (!failed.isLive || !isChannelRef(ref)) return null;
  const settings = await getSettings();
  if (settings && !settings.liveFailover) return null;
  const failedKey = itemKey(ref);
  if (undone.has(failedKey)) return null;
  if (!chain || chain.current !== failedKey) {
    chain = { origin: { ...failed, ref }, tried: new Set([failedKey]), current: failedKey, played: false, fullSources: new Set() };
  }
  const run = chain;

  let data: LiveAlternates;
  try {
    data = await loadAlternates(run.origin.ref);
  } catch {
    return null;
  }
  if (cls === 'connectionLimit') run.fullSources.add(ref.sourceId);
  for (const alt of forAccountFailure(rankAlternates(data), run.fullSources, ref.sourceId, cls)) {
    const key = itemKey(alt.channel.ref);
    if (run.tried.has(key)) continue;
    run.tried.add(key);
    if (chain !== run || !sameSource(usePlayerStore.getState().source, failed)) return null;
    let to: PlayerSource;
    try {
      to = await resolveSource(argsForAlternate(alt, failed));
    } catch {
      continue; // This copy cannot even be resolved: the next one.
    }
    if (chain !== run || !sameSource(usePlayerStore.getState().source, failed)) return null;
    run.current = key;
    run.played = false;
    switching = key;
    try {
      await usePlayerStore.getState().play(to);
    } finally {
      switching = null;
    }
    const origin = run.origin;
    return {
      alternate: alt,
      to,
      undo: () => {
        // The chain ends when the user tunes something else: an Undo still on screen then would
        // pull them back to the channel that failed.
        if (chain !== run) return;
        undone.add(itemKey(origin.ref));
        chain = null;
        playOrigin(origin);
      },
    };
  }
  return null;
}

/** Live failover with its "Switched to" toast; resolves to whether it switched. */
export async function failoverLive(failed: PlayerSource, cls?: StreamErrorClass): Promise<boolean> {
  const res = await tryLiveFailover(failed, cls);
  if (!res) return false;
  toast({
    id: LIVE_FAILOVER_TOAST,
    title: i18next.t('player:liveFailoverSwitched', { channel: res.to.title, source: res.alternate.sourceName }),
    description: i18next.t('player:liveFailoverSwitchedDetail', { channel: chain?.origin.title ?? failed.title }),
    variant: 'info',
    action: { label: i18next.t('player:undo'), onClick: res.undo },
  });
  return true;
}

/** The user picked a copy from the "Alternate sources" menu: play it, ending any chain. */
export function playAlternate(alt: LiveAlternate): void {
  const cur = usePlayerStore.getState().source;
  chain = null;
  // A copy the user picked is no longer the switch the toast offers to undo.
  dismissToast(LIVE_FAILOVER_TOAST);
  void playItem(argsForAlternate(alt, cur ?? { url: '', kind: 'direct', title: alt.channel.name, isLive: true, isRadio: false }));
}

/** A pinned source exists for this channel and another copy started: move to the pinned one. */
async function maybeRedirectToPin(ref: ItemRef, data: LiveAlternates): Promise<void> {
  const pin = getLivePin(data.key);
  const key = itemKey(ref);
  if (!pin || pin.sourceId === ref.sourceId || pinUndone.has(key) || chain) return;
  const target = rankAlternates(data)[0];
  if (!target || target.channel.ref.sourceId !== pin.sourceId) return;
  const from = usePlayerStore.getState().source;
  if (!from?.ref || itemKey(from.ref) !== key || !from.isLive) return;
  const origin = { ...from, ref: from.ref };
  let to: PlayerSource;
  try {
    to = await resolveSource(argsForAlternate(target, from));
  } catch {
    return; // The pinned copy cannot be resolved: stay where we are.
  }
  if (!sameSource(usePlayerStore.getState().source, from)) return;
  switching = itemKey(target.channel.ref);
  try {
    await usePlayerStore.getState().play(to);
  } finally {
    switching = null;
  }
  const pinnedKey = itemKey(target.channel.ref);
  toast({
    id: LIVE_FAILOVER_TOAST,
    title: i18next.t('player:livePinnedSwitched', { channel: to.title, source: target.sourceName }),
    variant: 'info',
    action: {
      label: i18next.t('player:undo'),
      onClick: () => {
        const now = usePlayerStore.getState().source?.ref;
        if (!now || itemKey(now) !== pinnedKey) return;
        pinUndone.add(key);
        playOrigin(origin);
      },
    },
  });
}

/**
 * Follow the player: keep the alternates list on the playing channel, mark a switched-to copy
 * as played, and end the chain (and any undo suppression) when the user plays something else.
 * The core leaves out copies the Live TV quality filter hides, so a change of the filter drops
 * every lookup made under the old one and asks for the playing channel's copies again.
 */
export function bindLiveFailover(): () => void {
  const onChange = (s: ReturnType<typeof usePlayerStore.getState>, prev: ReturnType<typeof usePlayerStore.getState>): void => {
    if (s.status === 'playing' && chain && s.source?.ref && itemKey(s.source.ref) === chain.current) chain.played = true;
    if (s.source === prev.source) return;
    const ref = s.source?.ref;
    const key = ref ? itemKey(ref) : undefined;
    // Placeholders while a channel resolves carry the ref already; empty sources (stop) end everything.
    if (key !== (prev.source?.ref ? itemKey(prev.source.ref) : undefined) && key !== switching) {
      const ours = chain && key !== undefined && (chain.tried.has(key) || itemKey(chain.origin.ref) === key);
      if (!ours) {
        // Another channel: the "Switched to" toast and its Undo are about the one left behind.
        dismissToast(LIVE_FAILOVER_TOAST);
        chain = null;
        if (key === undefined || !undone.has(key)) undone.clear();
        if (key === undefined || !pinUndone.has(key)) pinUndone.clear();
      }
    }
    // A zap's placeholder (a channel passed on the way) asks for no copies; the one it tunes does.
    trackAlternates(s.source?.isLive && !isPendingZap(s.source) ? ref : undefined);
  };
  const unsub = usePlayerStore.subscribe(onChange);
  // Unknown until settings first load: their arrival is the baseline, not a change.
  const qualityNow = (): string | undefined => {
    const settings = peekSettings();
    return settings ? liveQualityKey(settings) : undefined;
  };
  let quality = qualityNow();
  const unSettings = subscribeSettings(() => {
    const next = qualityNow();
    if (next === undefined || next === quality) return;
    const known = quality !== undefined;
    quality = next;
    if (!known) return;
    alternatesCache.clear();
    alternatesGen++;
    useAlternatesStore.setState({ forKey: undefined, status: 'idle', data: undefined });
    const cur = usePlayerStore.getState().source;
    trackAlternates(cur?.isLive && !isPendingZap(cur) ? cur.ref : undefined);
  });
  const s = usePlayerStore.getState();
  trackAlternates(s.source?.isLive ? s.source.ref : undefined);
  return () => {
    unsub();
    unSettings();
  };
}

/** Testing only. */
export function __resetFailover(): void {
  attempted.clear();
  alternatesCache.clear();
  chain = null;
  undone.clear();
  pinUndone.clear();
  switching = null;
  useAlternatesStore.setState({ forKey: undefined, status: 'idle', data: undefined });
}
