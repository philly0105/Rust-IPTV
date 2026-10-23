/**
 * When the zap banner shows (C5). On every live channel change it comes up for 5 s; hovering the
 * channel title (or the banner itself) brings it up and keeps it while the pointer stays, with a
 * short grace after it leaves. `settings.zapBanner` off turns both off. What it shows is
 * `components/ZapBanner.tsx`; this module only decides when, so it holds no React.
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand';

import { rpc } from '@/api/transport';
import { itemKey, type Channel, type ItemRef } from '@/api/types';

import { knownChannel, peekSettings, usePlayerStore } from './store';

/** How long the banner stays after a channel change. */
export const ZAP_BANNER_MS = 5000;
/** How long it lingers after the pointer leaves the title or the banner. */
export const ZAP_HOVER_GRACE_MS = 600;
/** The longest a hover holds it after the last pointer enter, so a lost leave cannot pin it. */
export const ZAP_HOLD_MAX_MS = 30_000;

export interface ZapBannerState {
  visible: boolean;
  /** The channel it describes (`itemKey`); a new channel re-keys the banner. */
  channelKey: string | null;
  /** Bumped per showing, so the entrance plays again on the next zap. */
  showing: number;
}

export const useZapBanner: UseBoundStore<StoreApi<ZapBannerState>> = create<ZapBannerState>()(() => ({
  visible: false,
  channelKey: null,
  showing: 0,
}));

let hideTimer: ReturnType<typeof setTimeout> | null = null;
/** Pointers resting on the title or the banner: while any does, the banner stays. */
let holds = 0;
/**
 * Bumped whenever every hold is dropped at once (hidden, or held too long). A hold carries the
 * generation it was taken in; a release from an older one is stale and does nothing.
 */
let holdGen = 0;
let capTimer: ReturnType<typeof setTimeout> | null = null;

function clearHide(): void {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
}

function clearCap(): void {
  if (capTimer) clearTimeout(capTimer);
  capTimer = null;
}

/** Drop every hold: their pending releases become stale, and the next hover holds afresh. */
function releaseHolds(): void {
  clearCap();
  holds = 0;
  holdGen++;
}

/** The generation current holds belong to (see `useZapHover`). */
export function zapHoldGeneration(): number {
  return holdGen;
}

/** The banner applies to what plays now: a live TV channel inside the app, with the setting on. */
export function zapBannerApplies(): boolean {
  if (peekSettings()?.zapBanner === false) return false;
  const s = usePlayerStore.getState();
  return !!s.source?.ref && s.source.isLive && !s.source.isRadio && s.mode !== 'external' && s.mode !== 'radio';
}

function hideAfter(ms: number): void {
  clearHide();
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (holds === 0) useZapBanner.setState({ visible: false });
  }, ms);
}

/** Show it now for `ms` (the hover path passes its grace instead). */
export function showZapBanner(ms = ZAP_BANNER_MS): void {
  if (!zapBannerApplies()) return;
  const ref = usePlayerStore.getState().source?.ref;
  const channelKey = ref ? itemKey(ref) : null;
  const st = useZapBanner.getState();
  useZapBanner.setState({
    visible: true,
    channelKey,
    showing: st.visible && st.channelKey === channelKey ? st.showing : st.showing + 1,
  });
  if (holds === 0) hideAfter(ms);
  else clearHide();
}

export function hideZapBanner(): void {
  clearHide();
  releaseHolds();
  if (useZapBanner.getState().visible) useZapBanner.setState({ visible: false });
}

/**
 * The pointer entered (`true`) or left (`false`) the channel title or the banner. Entering
 * shows it; leaving the last one starts the grace. Every enter needs its leave, passing the
 * generation the enter returned (`useZapHover` also leaves when its element stops being
 * hoverable or unmounts). A leave from an older generation is ignored: hiding the banner, or
 * a hold outliving `ZAP_HOLD_MAX_MS`, drops every hold at once.
 */
export function holdZapBanner(on: boolean, gen: number = holdGen): number {
  if (on) {
    holds++;
    if (!useZapBanner.getState().visible) showZapBanner();
    clearHide();
    clearCap();
    capTimer = setTimeout(() => {
      capTimer = null;
      releaseHolds();
      if (useZapBanner.getState().visible) hideAfter(ZAP_HOVER_GRACE_MS);
    }, ZAP_HOLD_MAX_MS);
    return holdGen;
  }
  if (gen !== holdGen || holds === 0) return holdGen;
  holds--;
  if (holds === 0) {
    clearCap();
    if (useZapBanner.getState().visible) hideAfter(ZAP_HOVER_GRACE_MS);
  }
  return holdGen;
}

// Every live channel change brings it up; leaving live TV (or the player) takes it down.
usePlayerStore.subscribe((s, prev) => {
  // Playback progress keeps the source: no keys to compare (P2-PLAYER-6).
  if (s.source === prev.source && s.mode === prev.mode) return;
  const key = s.source?.ref && s.source.isLive ? itemKey(s.source.ref) : null;
  const before = prev.source?.ref && prev.source.isLive ? itemKey(prev.source.ref) : null;
  if (key === before && s.mode === prev.mode) return;
  if (!key || !zapBannerApplies()) {
    hideZapBanner();
    return;
  }
  if (key !== before) showZapBanner();
});

// ---------------------------------------------------------------------------
// Channel details (number, logo): asked once per channel per session
// ---------------------------------------------------------------------------

export interface ZapChannelInfo {
  number?: number;
  logoUrl?: string;
  name?: string;
}

const infoCache = new Map<string, ZapChannelInfo>();
const infoPending = new Map<string, Promise<ZapChannelInfo>>();

function infoOf(ch: Partial<Channel>): ZapChannelInfo {
  const info: ZapChannelInfo = {};
  if (typeof ch.number === 'number') info.number = ch.number;
  if (ch.logoUrl) info.logoUrl = ch.logoUrl;
  if (ch.name) info.name = ch.name;
  return info;
}

/**
 * The cached details, or the row a zap already holds (its neighbour lookup carries number and
 * logo), so a zap's banner fills in on the press without asking the catalog.
 */
export function peekChannelInfo(ref: ItemRef): ZapChannelInfo | undefined {
  const key = itemKey(ref);
  const hit = infoCache.get(key);
  if (hit) return hit;
  const row = knownChannel(ref);
  if (!row) return undefined;
  const info = infoOf(row);
  infoCache.set(key, info);
  return info;
}

/** A channel edit (rename, new number or logo): its details are asked again next time. */
export function forgetChannelInfo(ref?: ItemRef): void {
  if (!ref) {
    infoCache.clear();
    return;
  }
  infoCache.delete(itemKey(ref));
}

/** The channel's number and logo from the catalog; an empty record when it cannot say. */
export function fetchChannelInfo(ref: ItemRef): Promise<ZapChannelInfo> {
  const key = itemKey(ref);
  const hit = peekChannelInfo(ref);
  if (hit) return Promise.resolve(hit);
  const inflight = infoPending.get(key);
  if (inflight) return inflight;
  const job = rpc('catalog.item', { ref })
    .then((item) => infoOf(item as Partial<Channel>))
    .catch((): ZapChannelInfo => ({}))
    .then((info) => {
      infoCache.set(key, info);
      infoPending.delete(key);
      return info;
    });
  infoPending.set(key, job);
  return job;
}

/** Testing only. */
export function __resetZapBannerForTests(): void {
  clearHide();
  releaseHolds();
  infoCache.clear();
  infoPending.clear();
  useZapBanner.setState({ visible: false, channelKey: null, showing: 0 });
}
