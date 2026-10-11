/**
 * Import progress (SPEC C6). One shared subscription to `import.progress`
 * keeps the latest event per source while any component listens.
 */

import { useEffect } from 'react';
import { create } from 'zustand';

import { onAppEvent } from '@/api/events';
import { invalidate } from '@/api/query';
import type { ImportProgressEvent } from '@/api/types';

export interface ProgressEntry extends ImportProgressEvent {
  /** ms timestamp of the last event for this source. */
  at: number;
}

interface ProgressStore {
  bySource: Record<string, ProgressEntry>;
  apply(e: ImportProgressEvent): void;
  clear(sourceId: string): void;
}

export const useImportProgressStore = create<ProgressStore>((set) => ({
  bySource: {},
  apply: (e) => set((s) => ({ bySource: { ...s.bySource, [e.sourceId]: { ...e, at: Date.now() } } })),
  clear: (id) =>
    set((s) => {
      if (!(id in s.bySource)) return s;
      const next = { ...s.bySource };
      delete next[id];
      return { bySource: next };
    }),
}));

/** Finished entries are dropped this long after the final event. */
const LINGER_MS = 4000;

let listeners = 0;
let unsubscribe: (() => void) | null = null;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function handleImportEvent(e: ImportProgressEvent): void {
  if (!e || typeof e.sourceId !== 'string') return;
  useImportProgressStore.getState().apply(e);
  const pending = timers.get(e.sourceId);
  if (pending) clearTimeout(pending);
  timers.delete(e.sourceId);
  if (e.phase === 'done' || e.phase === 'error') {
    void invalidate('sources.');
    timers.set(
      e.sourceId,
      setTimeout(() => {
        timers.delete(e.sourceId);
        useImportProgressStore.getState().clear(e.sourceId);
      }, LINGER_MS),
    );
  }
}

/** Mount in any component that shows import progress. */
export function useImportProgressFeed(): void {
  useEffect(() => {
    listeners += 1;
    if (!unsubscribe) unsubscribe = onAppEvent('import.progress', handleImportEvent);
    return () => {
      listeners -= 1;
      if (listeners === 0 && unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    };
  }, []);
}

export function useSourceProgress(sourceId: string | undefined): ProgressEntry | undefined {
  return useImportProgressStore((s) => (sourceId ? s.bySource[sourceId] : undefined));
}

/**
 * Progress for a source being added: its id is unknown until `sources.add`
 * returns, so take the newest event for an id not in `knownIds` that arrived
 * after `since`.
 */
export function useNewSourceProgress(knownIds: readonly string[], since: number | null): ProgressEntry | undefined {
  return useImportProgressStore((s) => {
    if (since === null) return undefined;
    let best: ProgressEntry | undefined;
    for (const [id, entry] of Object.entries(s.bySource)) {
      if (knownIds.includes(id) || entry.at < since) continue;
      if (!best || entry.at > best.at) best = entry;
    }
    return best;
  });
}

/** 0..1 when the total is known, otherwise undefined (indeterminate). */
export function progressFraction(e: Pick<ImportProgressEvent, 'done' | 'total' | 'phase'>): number | undefined {
  if (e.phase === 'done') return 1;
  if (!e.total || e.total <= 0) return undefined;
  return Math.max(0, Math.min(1, e.done / e.total));
}
