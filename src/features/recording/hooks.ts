/**
 * Queries and actions shared by the guide, the Scheduled page and My Videos.
 * Every action reports through a toast; callers only decide where to show it.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';

import { invalidate, rpcKey, useRpcQuery } from '@/api/query';
import { RpcError, rpc, rpcRaw } from '@/api/transport';
import type { EpgProgram, ItemRef, Recording, RecordingProgressEvent, RecordingRule, Reminder } from '@/api/types';
import { useToast } from '@/ui';

import { buildRuleIndex, type RuleKey } from './lib/rules';
import { buildScheduleIndex, type ScheduleIndex } from './lib/schedule';

const STALE = 30_000;

export function useReminders() {
  return useRpcQuery('reminders.list', undefined, { staleTime: STALE });
}

export function useRecordings() {
  return useRpcQuery('recordings.list', undefined, { staleTime: STALE });
}

const CAPS_STALE = 5 * 60_000;

export function useRecordingCapabilities() {
  return useRpcQuery('recordings.capabilities', undefined, { staleTime: CAPS_STALE });
}

/**
 * Starts the schedule queries a guide page needs when the page mounts, alongside its grid, not
 * when the first cell or programme dialog asks (L2-guide-library-15, L2-perf-ui-6).
 */
export function usePrefetchSchedule(): void {
  const client = useQueryClient();
  useEffect(() => {
    for (const [cmd, staleTime] of [
      ['reminders.list', STALE],
      ['recordings.list', STALE],
      ['recordings.rules', STALE],
      ['recordings.capabilities', CAPS_STALE],
    ] as const) {
      void client.prefetchQuery({ queryKey: rpcKey(cmd, undefined), queryFn: () => rpcRaw(cmd, undefined), staleTime });
    }
  }, [client]);
}

/** Recording settings the guide needs (reminders on or off). */
export function useRemindersEnabled(): boolean {
  const settings = useRpcQuery('settings.get', undefined, { staleTime: 60_000 });
  return settings.data?.remindersEnabled ?? true;
}

// One index for every grid cell: rebuilt only when either list changes.
let lastInput: [readonly Reminder[] | undefined, readonly Recording[] | undefined] | undefined;
let lastIndex: ScheduleIndex | undefined;

function cachedIndex(reminders: readonly Reminder[] | undefined, recordings: readonly Recording[] | undefined): ScheduleIndex {
  if (lastIndex && lastInput && lastInput[0] === reminders && lastInput[1] === recordings) return lastIndex;
  lastInput = [reminders, recordings];
  lastIndex = buildScheduleIndex(reminders, recordings);
  return lastIndex;
}

export function useScheduleIndex(): ScheduleIndex {
  const reminders = useReminders().data;
  const recordings = useRecordings().data;
  return cachedIndex(reminders, recordings);
}

/** Live byte counts from `recordings.progress`, by recording id. */
export const useRecordingProgress = create<{ byId: Readonly<Record<string, RecordingProgressEvent>> }>(() => ({ byId: {} }));

export function setRecordingProgress(e: RecordingProgressEvent): void {
  useRecordingProgress.setState((s) => ({ byId: { ...s.byId, [e.id]: e } }));
}

export interface ProgrammeTarget {
  ref: ItemRef;
  /** The name the guide shows. */
  channelName: string;
  /** Display-time programme (EPG offset applied). */
  program: Pick<EpgProgram, 'title' | 'start' | 'end'>;
}

function message(e: unknown): string {
  return RpcError.from(e).message;
}

/**
 * Recording ids with a stop or cancel in flight, until the refreshed list
 * arrives. Every Stop and cancel button reads it (`useCancelPending`), so a
 * second click, or the guide and the Scheduled page at once, cannot send
 * another cancel or show a second toast.
 */
const useCancelling = create<{ ids: ReadonlySet<string> }>(() => ({ ids: new Set<string>() }));
const cancelsInFlight = new Map<string, Promise<boolean>>();

function setCancelling(id: string, on: boolean): void {
  useCancelling.setState((s) => {
    const ids = new Set(s.ids);
    if (on) ids.add(id);
    else ids.delete(id);
    return { ids };
  });
}

/** True while recording `id` is being stopped or cancelled. */
export function useCancelPending(id: string | undefined): boolean {
  return useCancelling((s) => id !== undefined && s.ids.has(id));
}

/** Reminder and recording actions with their toasts. */
export function useScheduleActions() {
  const { t } = useTranslation('live');
  const { toast } = useToast();

  const toggleReminder = useCallback(
    async ({ ref, channelName, program }: ProgrammeTarget, existing?: Reminder): Promise<void> => {
      try {
        if (existing) {
          await rpc('reminders.remove', { id: existing.id });
          toast({ title: t('reminderRemoved', { title: program.title }) });
        } else {
          await rpc('reminders.add', { ref, channelName, title: program.title, start: program.start, end: program.end });
          toast({ variant: 'success', title: t('reminderSet', { title: program.title }) });
        }
      } catch (e) {
        toast({ variant: 'error', title: t('reminderFailed'), description: message(e) });
      } finally {
        void invalidate('reminders.');
      }
    },
    [t, toast],
  );

  const record = useCallback(
    async (args: { ref: ItemRef; channelName: string; program?: ProgrammeTarget['program']; durationMinutes?: number }): Promise<boolean> => {
      try {
        const res = await rpc('recordings.schedule', {
          ref: args.ref,
          channelName: args.channelName,
          ...(args.program ? { title: args.program.title, start: args.program.start, end: args.program.end } : { durationMinutes: args.durationMinutes }),
        });
        const name = args.program?.title ?? args.channelName;
        toast({
          variant: 'success',
          title: res.recording.status === 'recording' || Date.parse(res.recording.start) <= Date.now() ? t('recordingStarted', { title: name }) : t('recordingScheduled', { title: name }),
          description: res.warning ? t('recordConnectionWarning', { overlapping: res.warning.overlapping, max: res.warning.maxConnections }) : undefined,
          duration: res.warning ? 10_000 : undefined,
        });
        return true;
      } catch (e) {
        // Without mpv an HLS/DASH channel is refused up front; say so in the UI language.
        const err = RpcError.from(e);
        toast({ variant: 'error', title: t('recordFailed'), description: err.code === 'engine_missing' ? t('recordNeedsMpv') : err.message });
        return false;
      } finally {
        void invalidate('recordings.');
      }
    },
    [t, toast],
  );

  /** Stops a running recording or cancels a waiting one; resolves true on success. Repeats while one runs join it. */
  const cancelRecording = useCallback(
    (r: Recording): Promise<boolean> => {
      const running = cancelsInFlight.get(r.id);
      if (running) return running;
      setCancelling(r.id, true);
      const work = (async () => {
        try {
          await rpc('recordings.cancel', { id: r.id });
          toast({ title: r.status === 'recording' ? t('recordingStopped', { title: r.title ?? r.channelName }) : t('recordingCancelled', { title: r.title ?? r.channelName }) });
          return true;
        } catch (e) {
          toast({ variant: 'error', title: t('recordCancelFailed'), description: message(e) });
          return false;
        } finally {
          // Pending until the list no longer offers Stop for this row.
          await invalidate('recordings.').catch(() => undefined);
          cancelsInFlight.delete(r.id);
          setCancelling(r.id, false);
        }
      })();
      cancelsInFlight.set(r.id, work);
      return work;
    },
    [t, toast],
  );

  return useMemo(() => ({ toggleReminder, record, cancelRecording }), [toggleReminder, record, cancelRecording]);
}

// ---------------------------------------------------------------------------
// Series recording rules (Run 2 C5)
// ---------------------------------------------------------------------------

export function useRecordingRules() {
  return useRpcQuery('recordings.rules', undefined, { staleTime: STALE });
}

let lastRules: readonly RecordingRule[] | undefined;
let lastRuleIndex: ReadonlyMap<RuleKey, RecordingRule> | undefined;

/** Rules by channel and series title, shared by every guide cell (rebuilt when the list changes). */
export function useRuleIndex(): ReadonlyMap<RuleKey, RecordingRule> {
  const rules = useRecordingRules().data;
  if (!lastRuleIndex || lastRules !== rules) {
    lastRules = rules;
    lastRuleIndex = buildRuleIndex(rules);
  }
  return lastRuleIndex;
}

/** Add, pause/resume and remove series rules, with their toasts. Each resolves true on success. */
export function useRuleActions() {
  const { t } = useTranslation('guide');
  const { toast } = useToast();

  const addRule = useCallback(
    async (args: { ref: ItemRef; channelName: string; title: string }): Promise<boolean> => {
      try {
        const rule = await rpc('recordings.addRule', args);
        toast({ variant: 'success', title: t('seriesAdded', { title: rule.title }), description: t('seriesAddedHint', { n: rule.upcoming }) });
        return true;
      } catch (e) {
        const err = RpcError.from(e);
        toast({
          variant: 'error',
          title: err.code === 'conflict' ? t('seriesExists', { title: args.title }) : t('seriesFailed'),
          description: err.code === 'conflict' ? undefined : err.message,
        });
        return false;
      } finally {
        void invalidate('recordings.');
      }
    },
    [t, toast],
  );

  const setRuleEnabled = useCallback(
    async (rule: RecordingRule, enabled: boolean): Promise<boolean> => {
      try {
        await rpc('recordings.setRuleEnabled', { id: rule.id, enabled });
        return true;
      } catch (e) {
        toast({ variant: 'error', title: t('ruleUpdateFailed'), description: message(e) });
        return false;
      } finally {
        void invalidate('recordings.');
      }
    },
    [t, toast],
  );

  const removeRule = useCallback(
    async (rule: RecordingRule, cancelScheduled: boolean): Promise<boolean> => {
      try {
        await rpc('recordings.removeRule', { id: rule.id, keepScheduled: !cancelScheduled });
        toast({ title: t('ruleRemoved', { title: rule.title }) });
        return true;
      } catch (e) {
        toast({ variant: 'error', title: t('ruleUpdateFailed'), description: message(e) });
        return false;
      } finally {
        void invalidate('recordings.');
      }
    },
    [t, toast],
  );

  return useMemo(() => ({ addRule, setRuleEnabled, removeRule }), [addRule, setRuleEnabled, removeRule]);
}
