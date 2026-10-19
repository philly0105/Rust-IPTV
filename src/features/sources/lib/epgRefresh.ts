/**
 * Loads a source's guide without a manual step. `sources.add` and
 * `sources.refresh` import channels only; the core fills
 * `source.epg.detectedUrls` (playlist `url-tvg`, Xtream `xmltv.php`) but does
 * not fetch them. The UI then calls `epg.refresh { url }` (SPEC C4) for each
 * enabled URL that is new, and follows `epg.progress` per URL.
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { onAppEvent } from '@/api/events';
import { invalidate } from '@/api/query';
import { RpcError, rpc } from '@/api/transport';
import type { EpgLinks, EpgProgressEvent } from '@/api/types';

/** URLs the core will fetch for this source: detected + manual, minus disabled, de-duplicated. */
export function enabledEpgUrls(links: EpgLinks | undefined): string[] {
  if (!links) return [];
  const disabled = new Set(links.disabledUrls);
  const out: string[] = [];
  for (const u of [...links.detectedUrls, ...links.manualUrls]) {
    if (!disabled.has(u) && !out.includes(u)) out.push(u);
  }
  return out;
}

/** Enabled URLs in `after` that were not enabled in `before` (new, re-enabled, or a changed detected link). */
export function newlyEnabledEpgUrls(before: EpgLinks | undefined, after: EpgLinks | undefined): string[] {
  const had = new Set(enabledEpgUrls(before));
  return enabledEpgUrls(after).filter((u) => !had.has(u));
}

export type GuidePhase = 'queued' | 'fetching' | 'parsing' | 'saving' | 'done' | 'error';

export interface GuideEntry {
  phase: GuidePhase;
  programs: number;
  message?: string;
  at: number;
}

const ACTIVE: ReadonlySet<GuidePhase> = new Set(['queued', 'fetching', 'parsing', 'saving']);
export const isGuideActive = (e: GuideEntry | undefined): boolean => e !== undefined && ACTIVE.has(e.phase);

function toPhase(raw: string): GuidePhase {
  return raw === 'fetching' || raw === 'parsing' || raw === 'saving' || raw === 'done' || raw === 'error' ? raw : 'parsing';
}

interface GuideStore {
  byUrl: Record<string, GuideEntry>;
  set(url: string, entry: Omit<GuideEntry, 'at'>): void;
  clear(url: string): void;
}

export const useGuideProgressStore = create<GuideStore>((set) => ({
  byUrl: {},
  set: (url, entry) => set((s) => ({ byUrl: { ...s.byUrl, [url]: { ...entry, at: Date.now() } } })),
  clear: (url) =>
    set((s) => {
      if (!(url in s.byUrl)) return s;
      const next = { ...s.byUrl };
      delete next[url];
      return { byUrl: next };
    }),
}));

/** Finished entries linger this long so the card can say "Guide loaded". */
const LINGER_MS = 4000;
/** A queued URL with no event after this long is dropped (the core may have skipped it). */
const QUEUED_TIMEOUT_MS = 60_000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function schedule(url: string, ms: number, onlyIf?: (e: GuideEntry | undefined) => boolean) {
  const prev = timers.get(url);
  if (prev) clearTimeout(prev);
  timers.set(
    url,
    setTimeout(() => {
      timers.delete(url);
      const e = useGuideProgressStore.getState().byUrl[url];
      if (!onlyIf || onlyIf(e)) useGuideProgressStore.getState().clear(url);
    }, ms),
  );
}

export function handleGuideEvent(e: EpgProgressEvent): void {
  if (!e || typeof e.url !== 'string') return;
  const phase = toPhase(e.phase);
  useGuideProgressStore.getState().set(e.url, { phase, programs: e.programs ?? 0, message: e.message });
  if (phase === 'done' || phase === 'error') {
    void invalidate('epg.');
    schedule(e.url, LINGER_MS);
  } else {
    const prev = timers.get(e.url);
    if (prev) clearTimeout(prev);
    timers.delete(e.url);
  }
}

let listeners = 0;
let unsubscribe: (() => void) | null = null;

/** Mount in any component that shows guide progress. */
export function useGuideProgressFeed(): void {
  useEffect(() => {
    listeners += 1;
    if (!unsubscribe) unsubscribe = onAppEvent('epg.progress', handleGuideEvent);
    return () => {
      listeners -= 1;
      if (listeners === 0 && unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    };
  }, []);
}

export interface GuideRefreshResult {
  started: string[];
  failed: { url: string; error: RpcError }[];
}

/**
 * Starts a background `epg.refresh` for each URL (the RPC returns at once; the
 * work runs in the core). Never throws: per-URL failures are returned.
 */
export async function refreshGuides(urls: readonly string[]): Promise<GuideRefreshResult> {
  const result: GuideRefreshResult = { started: [], failed: [] };
  const store = useGuideProgressStore.getState();
  for (const url of urls) {
    if (!isGuideActive(store.byUrl[url])) {
      store.set(url, { phase: 'queued', programs: 0 });
      schedule(url, QUEUED_TIMEOUT_MS, (e) => e?.phase === 'queued');
    }
    try {
      await rpc('epg.refresh', { url });
      result.started.push(url);
    } catch (e) {
      const err = RpcError.from(e);
      // `conflict` = already refreshing: the running job covers it.
      if (err.code === 'conflict') {
        result.started.push(url);
        continue;
      }
      store.set(url, { phase: 'error', programs: 0, message: err.message });
      schedule(url, LINGER_MS);
      result.failed.push({ url, error: err });
    }
  }
  if (urls.length > 0) void invalidate('epg.sources');
  return result;
}

export interface SourceGuideSummary {
  /** Some URL of the source is queued or loading. */
  active: boolean;
  /** Programmes read so far across the source's loading URLs. */
  programs: number;
  /** Every tracked URL finished; at least one is done. */
  done: boolean;
  /** Message of the first failed URL, if any finished with an error. */
  error?: string;
  phase?: GuidePhase;
}

export function summarizeGuide(byUrl: Record<string, GuideEntry>, urls: readonly string[]): SourceGuideSummary | undefined {
  const entries = urls.map((u) => byUrl[u]).filter((e): e is GuideEntry => e !== undefined);
  if (entries.length === 0) return undefined;
  const active = entries.filter(isGuideActive);
  const failed = entries.find((e) => e.phase === 'error');
  const order: GuidePhase[] = ['queued', 'fetching', 'parsing', 'saving'];
  const phase = active.length > 0 ? order.find((p) => active.some((e) => e.phase === p)) : failed ? 'error' : 'done';
  return {
    active: active.length > 0,
    programs: entries.reduce((n, e) => n + (e.programs || 0), 0),
    done: active.length === 0 && entries.some((e) => e.phase === 'done'),
    error: failed?.message,
    phase,
  };
}

/**
 * Guide progress for one source's enabled URLs. Selects only those URLs' entries, so an event for
 * another source's guide does not re-render this source's card (VD-5).
 */
export function useSourceGuide(links: EpgLinks | undefined): SourceGuideSummary | undefined {
  const urls = enabledEpgUrls(links);
  const entries = useGuideProgressStore(useShallow((s) => urls.map((u) => s.byUrl[u])));
  const own: Record<string, GuideEntry> = {};
  urls.forEach((u, i) => {
    const e = entries[i];
    if (e) own[u] = e;
  });
  return summarizeGuide(own, urls);
}
