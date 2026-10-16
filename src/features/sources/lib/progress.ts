/**
 * Import progress (SPEC C6). One shared subscription to `import.progress`
 * keeps the latest event per source while any component listens.
 *
 * Cancelling (C8): `cancelImport` asks the core to stop a running import or
 * refresh. The run then ends with `phase: 'cancelled'` and the source keeps
 * its previous catalog. While the request is out, `cancelling[id]` is set so
 * the progress view can show "Cancelling..."; `wasCancelled` tells the caller
 * whose `sources.refresh` / `sources.add` just rejected that the rejection is
 * the cancel, not a failure worth an error toast.
 */

import { useEffect } from 'react';
import { create } from 'zustand';

import { onAppEvent } from '@/api/events';
import { invalidate } from '@/api/query';
import { RpcError, rpc } from '@/api/transport';
import type { ImportPhase, ImportProgressEvent } from '@/api/types';

import { isCancelledImportError } from './errors';

export interface ProgressEntry extends ImportProgressEvent {
  /** ms timestamp of the last event for this source. */
  at: number;
  /**
   * Download retry (B8): the 1-based try under way and the tries allowed. Sent on the 'fetching'
   * event that starts a retry and kept for the rest of that phase, so the byte counts that follow
   * still say which try they belong to.
   */
  attempt?: number;
  attempts?: number;
}

/** A positive whole number from an event field the frozen RPC type does not declare. */
function count(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

/** The entry for a new event: its retry fields read defensively, carried over within 'fetching'. */
function toEntry(e: ImportProgressEvent, prev: ProgressEntry | undefined): ProgressEntry {
  const raw: Record<string, unknown> = { ...e };
  let attempt = count(raw['attempt']);
  let attempts = count(raw['attempts']);
  if (attempt === undefined && e.phase === 'fetching' && prev?.phase === 'fetching') {
    attempt = prev.attempt;
    attempts = prev.attempts;
  }
  const entry: ProgressEntry = { ...e, at: Date.now() };
  delete entry.attempt;
  delete entry.attempts;
  if (e.phase === 'fetching' && attempt !== undefined && attempts !== undefined && attempt <= attempts) {
    entry.attempt = attempt;
    entry.attempts = attempts;
  }
  return entry;
}

interface ProgressStore {
  bySource: Record<string, ProgressEntry>;
  /** Sources with a cancel request in flight or acknowledged, until the run ends. */
  cancelling: Record<string, true>;
  apply(e: ImportProgressEvent): void;
  clear(sourceId: string): void;
  setCancelling(sourceId: string, on: boolean): void;
}

/** Phases after which the run is over. */
export const FINAL_PHASES: ReadonlySet<ImportPhase> = new Set<ImportPhase>(['done', 'error', 'cancelled']);

/** True while an import with this phase is still working. */
export function isRunningPhase(phase: ImportPhase | undefined): boolean {
  return phase !== undefined && !FINAL_PHASES.has(phase);
}

function without<T>(record: Record<string, T>, id: string): Record<string, T> {
  const next = { ...record };
  delete next[id];
  return next;
}

export const useImportProgressStore = create<ProgressStore>((set) => ({
  bySource: {},
  cancelling: {},
  apply: (e) =>
    set((s) => ({
      bySource: { ...s.bySource, [e.sourceId]: toEntry(e, s.bySource[e.sourceId]) },
      cancelling: FINAL_PHASES.has(e.phase) && e.sourceId in s.cancelling ? without(s.cancelling, e.sourceId) : s.cancelling,
    })),
  clear: (id) =>
    set((s) => {
      if (!(id in s.bySource) && !(id in s.cancelling)) return s;
      return { bySource: without(s.bySource, id), cancelling: without(s.cancelling, id) };
    }),
  setCancelling: (id, on) =>
    set((s) => {
      if (on === id in s.cancelling) return s;
      return { cancelling: on ? { ...s.cancelling, [id]: true } : without(s.cancelling, id) };
    }),
}));

/** Finished entries are dropped this long after the final event. */
export const LINGER_MS = 4000;

let listeners = 0;
let unsubscribe: (() => void) | null = null;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Sources whose current run the user asked to cancel; cleared when the next run starts. */
const cancelRequested = new Set<string>();

export function handleImportEvent(e: ImportProgressEvent): void {
  if (!e || typeof e.sourceId !== 'string' || typeof e.phase !== 'string') return;
  useImportProgressStore.getState().apply(e);
  const pending = timers.get(e.sourceId);
  if (pending) clearTimeout(pending);
  timers.delete(e.sourceId);
  if (FINAL_PHASES.has(e.phase)) {
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
export function progressFraction(e: Pick<ImportProgressEvent, 'done' | 'total' | 'phase' | 'step'>): number | undefined {
  if (e.phase === 'done') return 1;
  // Replacing the old catalog or rebuilding the indexes: a wait with no meaningful count (L3-import-ui-3).
  if (e.phase === 'saving' && e.step) return undefined;
  if (!e.total || e.total <= 0 || !Number.isFinite(e.done)) return undefined;
  return Math.max(0, Math.min(1, e.done / e.total));
}

/**
 * Call before starting an import or refresh: forgets an earlier cancel request
 * and the previous run's final entry, so the new run starts clean.
 */
export function beginImport(sourceId: string): void {
  cancelRequested.delete(sourceId);
  const pending = timers.get(sourceId);
  if (pending) clearTimeout(pending);
  timers.delete(sourceId);
  useImportProgressStore.getState().clear(sourceId);
}

/**
 * Asks the core to stop the running import or refresh of `sourceId` (C8).
 * Resolves true when one was running and is now stopping, false when nothing
 * was running (it finished first). Rejects with an RpcError when the request failed.
 */
export async function cancelImport(sourceId: string): Promise<boolean> {
  const store = useImportProgressStore.getState();
  cancelRequested.add(sourceId);
  store.setCancelling(sourceId, true);
  try {
    const running = await rpc('sources.cancelImport', { id: sourceId });
    if (!running) {
      cancelRequested.delete(sourceId);
      useImportProgressStore.getState().setCancelling(sourceId, false);
    }
    return running;
  } catch (e) {
    cancelRequested.delete(sourceId);
    useImportProgressStore.getState().setCancelling(sourceId, false);
    throw RpcError.from(e);
  }
}

/**
 * True when the run of `sourceId` that just rejected with `err` ended because
 * it was cancelled: the user asked for it, the core reported `cancelled`, or
 * the error itself says so (the source was removed or edited mid-import).
 */
export function wasCancelled(sourceId: string | null | undefined, err: Pick<RpcError, 'code' | 'message'>): boolean {
  if (sourceId && (cancelRequested.has(sourceId) || useImportProgressStore.getState().bySource[sourceId]?.phase === 'cancelled')) return true;
  return isCancelledImportError(err);
}

/** Test hook: forget every timer and cancel request. */
export function resetProgressForTests(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  cancelRequested.clear();
  useImportProgressStore.setState({ bySource: {}, cancelling: {} });
}
