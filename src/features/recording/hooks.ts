/**
 * Queries and actions shared by the guide, the Scheduled page and My Videos.
 * Every action reports through a toast; callers only decide where to show it.
 */

import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';

import { invalidate, useRpcQuery } from '@/api/query';
import { RpcError, rpc } from '@/api/transport';
import type { EpgProgram, ItemRef, Recording, RecordingProgressEvent, Reminder } from '@/api/types';
import { useToast } from '@/ui';

import { buildScheduleIndex, type ScheduleIndex } from './lib/schedule';

const STALE = 30_000;

export function useReminders() {
  return useRpcQuery('reminders.list', undefined, { staleTime: STALE });
}

export function useRecordings() {
  return useRpcQuery('recordings.list', undefined, { staleTime: STALE });
}

export function useRecordingCapabilities() {
  return useRpcQuery('recordings.capabilities', undefined, { staleTime: 5 * 60_000 });
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

  const cancelRecording = useCallback(
    async (r: Recording): Promise<void> => {
      try {
        await rpc('recordings.cancel', { id: r.id });
        toast({ title: r.status === 'recording' ? t('recordingStopped', { title: r.title ?? r.channelName }) : t('recordingCancelled', { title: r.title ?? r.channelName }) });
      } catch (e) {
        toast({ variant: 'error', title: t('recordCancelFailed'), description: message(e) });
      } finally {
        void invalidate('recordings.');
      }
    },
    [t, toast],
  );

  return useMemo(() => ({ toggleReminder, record, cancelRecording }), [toggleReminder, record, cancelRecording]);
}
