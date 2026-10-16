/**
 * Pure helpers for guide reminders and scheduled recordings: matching them to
 * guide programmes, the Scheduled page's grouping, and display numbers.
 *
 * Every time here is display time: the core stores reminders and recordings
 * with `settings.epgOffsetMinutes` already applied, the same way the guide
 * views shift programmes before showing them.
 */

import { itemKey, type EpgProgram, type ItemRef, type Recording, type RecordingStatus, type Reminder } from '@/api/types';

/** `${itemKey}@${start ms}`: one programme on one channel. */
export type SlotKey = `${string}@${number}`;

function epoch(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

export function slotKey(ref: ItemRef, start: string): SlotKey {
  return `${itemKey(ref)}@${epoch(start)}`;
}

/** Recording states that still hold the channel: waiting or writing. */
export function isActiveRecording(r: Pick<Recording, 'status'>): boolean {
  return r.status === 'scheduled' || r.status === 'recording';
}

export interface ScheduleIndex {
  /** Pending reminders by programme. */
  reminders: ReadonlyMap<SlotKey, Reminder>;
  /** Waiting or running programme recordings by programme. */
  recordings: ReadonlyMap<SlotKey, Recording>;
  /** Running recordings (programme or channel) by channel `itemKey`. */
  recordingChannels: ReadonlyMap<string, Recording>;
}

export const EMPTY_INDEX: ScheduleIndex = { reminders: new Map(), recordings: new Map(), recordingChannels: new Map() };

export function buildScheduleIndex(reminders: readonly Reminder[] = [], recordings: readonly Recording[] = []): ScheduleIndex {
  const rem = new Map<SlotKey, Reminder>();
  for (const r of reminders) if (r.status === 'pending') rem.set(slotKey(r.ref, r.start), r);
  const rec = new Map<SlotKey, Recording>();
  const channels = new Map<string, Recording>();
  for (const r of recordings) {
    if (!isActiveRecording(r)) continue;
    if (r.kind === 'programme') rec.set(slotKey(r.ref, r.start), r);
    if (r.status === 'recording') channels.set(itemKey(r.ref), r);
  }
  return { reminders: rem, recordings: rec, recordingChannels: channels };
}

export interface ProgramMark {
  reminder?: Reminder;
  recording?: Recording;
}

export function markFor(index: ScheduleIndex, ref: ItemRef | undefined, program: Pick<EpgProgram, 'start'>): ProgramMark {
  if (!ref) return {};
  const key = slotKey(ref, program.start);
  return { reminder: index.reminders.get(key), recording: index.recordings.get(key) };
}

/** What the programme dialog may offer for a programme at `now`. */
export function programOptions(program: Pick<EpgProgram, 'start' | 'end'>, now: number): { remind: boolean; record: boolean } {
  const start = epoch(program.start);
  const end = epoch(program.end);
  return { remind: start > now, record: end > now && end > start };
}

/** Lengths offered for "Record channel", in minutes. */
export const CHANNEL_DURATIONS = [30, 60, 120, 180] as const;

// ---------------------------------------------------------------------------
// Scheduled page
// ---------------------------------------------------------------------------

export type UpcomingEntry =
  | { type: 'reminder'; id: string; at: number; reminder: Reminder }
  | { type: 'recording'; id: string; at: number; recording: Recording };

/** Padded start of a recording (when the engine begins), epoch ms. */
export function recordingBegins(r: Pick<Recording, 'start' | 'paddingBeforeMinutes'>): number {
  return epoch(r.start) - r.paddingBeforeMinutes * 60_000;
}

/** Padded end of a recording, epoch ms. */
export function recordingEnds(r: Pick<Recording, 'end' | 'paddingAfterMinutes'>): number {
  return epoch(r.end) + r.paddingAfterMinutes * 60_000;
}

/** Pending reminders and waiting recordings, soonest first. */
export function upcoming(reminders: readonly Reminder[] = [], recordings: readonly Recording[] = []): UpcomingEntry[] {
  const out: UpcomingEntry[] = [];
  for (const r of reminders) if (r.status === 'pending') out.push({ type: 'reminder', id: r.id, at: epoch(r.start), reminder: r });
  for (const r of recordings) if (r.status === 'scheduled') out.push({ type: 'recording', id: r.id, at: epoch(r.start), recording: r });
  return out.sort((a, b) => a.at - b.at || a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
}

/** Recordings writing now, earliest first. */
export function recordingNow(recordings: readonly Recording[] = []): Recording[] {
  return recordings.filter((r) => r.status === 'recording').sort((a, b) => epoch(a.start) - epoch(b.start));
}

const FINISHED: ReadonlySet<RecordingStatus> = new Set(['completed', 'failed', 'missed', 'cancelled']);

/** Finished recordings, newest first. */
export function finishedRecordings(recordings: readonly Recording[] = []): Recording[] {
  const at = (r: Recording) => epoch(r.endedAt ?? r.end);
  return recordings.filter((r) => FINISHED.has(r.status)).sort((a, b) => at(b) - at(a));
}

/** Groups entries by local calendar day, keeping order. */
export function groupByDay<T extends { at: number }>(entries: readonly T[]): { day: number; entries: T[] }[] {
  const groups: { day: number; entries: T[] }[] = [];
  for (const e of entries) {
    const d = new Date(e.at);
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.entries.push(e);
    else groups.push({ day, entries: [e] });
  }
  return groups;
}

/** Local midnight of the day `at` falls on. */
function startOfDay(at: number): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Clock time as the Scheduled list shows it ("02:45 AM"). */
export function clockTime(at: number, lang: string): string {
  return new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' }).format(at);
}

/** Day heading of the Scheduled list: "today", "tomorrow" (the locale's words), else "Friday, October 16". */
export function dayLabel(day: number, now: number, lang: string): string {
  const diff = Math.round((startOfDay(day) - startOfDay(now)) / 86_400_000);
  if (diff === 0 || diff === 1) return new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }).format(diff, 'day');
  return new Intl.DateTimeFormat(lang, { weekday: 'long', day: 'numeric', month: 'long' }).format(day);
}

/**
 * When an airing starts, in the Scheduled list's words, for places that show it
 * on one line (a series rule's next airing): "today 02:45 AM", "tomorrow
 * 09:00 PM", else "Saturday, October 17 at 02:45 AM".
 */
export function airingLabel(at: number, now: number, lang: string): string {
  const diff = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
  if (diff === 0 || diff === 1) return `${dayLabel(at, now, lang)} ${clockTime(at, lang)}`;
  return new Intl.DateTimeFormat(lang, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(at);
}

/** Seconds a running recording has been writing. */
export function elapsedSeconds(r: Pick<Recording, 'startedAt'>, now: number, reported?: number): number {
  if (reported !== undefined) return Math.max(0, reported);
  const s = r.startedAt ? epoch(r.startedAt) : 0;
  return s ? Math.max(0, Math.floor((now - s) / 1000)) : 0;
}

/**
 * When a recording began writing, epoch ms: `startedAt`, or the padded start
 * when the engine has not reported one. A programme recorded part-way through
 * starts late, so this is what the recording itself covers.
 */
export function recordingStartedAt(r: Pick<Recording, 'start' | 'paddingBeforeMinutes' | 'startedAt'>): number {
  const s = r.startedAt ? epoch(r.startedAt) : 0;
  return s || recordingBegins(r);
}

/**
 * 0..1 of a running recording: from when it began writing to its padded end.
 * It tracks the recording, not the programme, so recording a programme that is
 * already half over starts the bar at empty, in step with the elapsed clock.
 */
export function recordingFraction(r: Recording, now: number): number {
  const from = recordingStartedAt(r);
  const to = recordingEnds(r);
  if (to <= from) return 0;
  return Math.min(1, Math.max(0, (now - from) / (to - from)));
}

/** A finished recording that ends this long before its padded end was cut short. */
const STOPPED_EARLY_SLACK_MS = 60_000;

/**
 * A completed recording that ended well before its padded end: stopped from
 * the app, or the stream or the app gave out. Its file holds less than the
 * programme, so the lists say "Stopped early" instead of "Completed".
 */
export function stoppedEarly(r: Pick<Recording, 'status' | 'endedAt' | 'end' | 'paddingAfterMinutes'>): boolean {
  if (r.status !== 'completed' || !r.endedAt) return false;
  const ended = epoch(r.endedAt);
  return ended > 0 && ended < recordingEnds(r) - STOPPED_EARLY_SLACK_MS;
}

/** `h:mm:ss` / `m:ss` clock for elapsed time; digits only, so it reads in every locale. */
export function clockDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
