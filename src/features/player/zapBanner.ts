/**
 * When the zap banner shows (C5). On every live channel change it comes up for 5 s; hovering the
 * channel title (or the banner itself) brings it up and keeps it while the pointer stays, with a
 * short grace after it leaves. `settings.zapBanner` off turns both off. What it shows is
 * `components/ZapBanner.tsx`; this module only decides when, so it holds no React.
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand';

import { rpc } from '@/api/transport';
import { itemKey, type Channel, type ItemRef } from '@/api/types';

import { peekSettings, usePlayerStore } from './store';

/** How long the banner stays after a channel change. */
export const ZAP_BANNER_MS = 5000;
/** How long it lingers after the pointer leaves the title or the banner. */
export const ZAP_HOVER_GRACE_MS = 600;

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

function clearHide(): void {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
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
  holds = 0;
  if (useZapBanner.getState().visible) useZapBanner.setState({ visible: false });
}

/**
 * The pointer entered (`true`) or left (`false`) the channel title or the banner. Entering
 * shows it; leaving the last one starts the grace. Every enter needs its leave (an unmount
 * while hovered calls it too, see `useZapHover`).
 */
export function holdZapBanner(on: boolean): void {
  if (on) {
    holds++;
    if (!useZapBanner.getState().visible) showZapBanner();
    clearHide();
    return;
  }
  holds = Math.max(0, holds - 1);
  if (holds === 0 && useZapBanner.getState().visible) hideAfter(ZAP_HOVER_GRACE_MS);
}

// Every live channel change brings it up; leaving live TV (or the player) takes it down.
usePlayerStore.subscribe((s, prev) => {
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

export function peekChannelInfo(ref: ItemRef): ZapChannelInfo | undefined {
  return infoCache.get(itemKey(ref));
}

/** The channel's number and logo from the catalog; an empty record when it cannot say. */
export function fetchChannelInfo(ref: ItemRef): Promise<ZapChannelInfo> {
  const key = itemKey(ref);
  const hit = infoCache.get(key);
  if (hit) return Promise.resolve(hit);
  const inflight = infoPending.get(key);
  if (inflight) return inflight;
  const job = rpc('catalog.item', { ref })
    .then((item) => {
      const ch = item as Partial<Channel>;
      const info: ZapChannelInfo = {};
      if (typeof ch.number === 'number') info.number = ch.number;
      if (ch.logoUrl) info.logoUrl = ch.logoUrl;
      if (ch.name) info.name = ch.name;
      return info;
    })
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
  holds = 0;
  infoCache.clear();
  infoPending.clear();
  useZapBanner.setState({ visible: false, channelKey: null, showing: 0 });
}
