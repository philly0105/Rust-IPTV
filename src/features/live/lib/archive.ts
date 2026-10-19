import type { Channel, EpgProgram, ItemRef, SourceKind } from '@/api/types';

import { addLocalDays, canCatchUp, floorLocal, hasUsableArchive, HOUR, ms, programWhen } from './epgTime';

/** Days the archive browser offers when the channel does not say how long its archive is. */
export const DEFAULT_ARCHIVE_DAYS = 1;
/** Longest archive the day picker lists (panels advertise up to a year). */
export const MAX_ARCHIVE_DAYS = 30;

/** Route of a channel's archive browser. */
export function archivePath(ref: Pick<ItemRef, 'sourceId' | 'itemId'>): string {
  return `/live/archive/${encodeURIComponent(ref.sourceId)}/${encodeURIComponent(ref.itemId)}`;
}

/** True when the channel has an archive the app can play (shows the "Browse archive" entry points); needs the source kind. */
export function canBrowseArchive(channel: Pick<Channel, 'archive' | 'url' | 'isRadio'> & { catchup?: Channel['catchup'] }, kind: SourceKind | undefined): boolean {
  return !!kind && !channel.isRadio && hasUsableArchive(channel, kind);
}

/** Whole days of archive: `durationHours`, else M3U `catchup-days`, else a default. */
export function archiveDayCount(channel: Pick<Channel, 'archive'> & { catchup?: Channel['catchup'] }): number {
  const hours = channel.archive?.durationHours ?? 0;
  const catchupDays = channel.catchup?.days ?? 0;
  const days = hours > 0 ? Math.ceil(hours / 24) : catchupDays > 0 ? catchupDays : DEFAULT_ARCHIVE_DAYS;
  return Math.min(Math.max(1, days), MAX_ARCHIVE_DAYS);
}

/** Local midnight of the day holding `t`. */
export function dayStart(t: number): number {
  return floorLocal(t, 24 * 60);
}

/**
 * The days the picker offers, newest first: today, then back `count` calendar days
 * (an archive of 72 h reaches into the third day before today).
 */
export function archiveDays(now: number, count: number): number[] {
  const today = dayStart(now);
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push(dayStart(addLocalDays(today, -i)));
  return out;
}

/** `[start, end)` of the local day starting at `day` (23 or 25 h across a DST change). */
export function dayRange(day: number): { start: number; end: number } {
  return { start: day, end: dayStart(addLocalDays(day, 1)) };
}

/**
 * What the archive browser offers for a programme:
 * - `playable`: ended and inside the archive window;
 * - `airing`: on now, can be watched from its start;
 * - `live`: on now but the archive cannot replay it (watch live instead);
 * - `expired`: ended before the archive window;
 * - `future`: not aired yet.
 */
export type ArchiveProgramState = 'playable' | 'airing' | 'live' | 'expired' | 'future';

export function archiveProgramState(
  program: EpgProgram,
  channel: Parameters<typeof canCatchUp>[1],
  kind: SourceKind | undefined,
  now: number,
): ArchiveProgramState {
  const when = programWhen(program, now);
  if (when === 'future') return 'future';
  const ok = canCatchUp(program, channel, kind, now);
  if (when === 'now') return ok ? 'airing' : 'live';
  return ok ? 'playable' : 'expired';
}

/** Programmes overlapping `[start, end)`, start-ordered, without duplicates or empty slots. */
export function programsInDay(list: readonly EpgProgram[], start: number, end: number): EpgProgram[] {
  const seen = new Set<string>();
  return list
    .filter((p) => ms(p.end) > ms(p.start) && ms(p.end) > start && ms(p.start) < end)
    .sort((a, b) => ms(a.start) - ms(b.start))
    .filter((p) => {
      if (seen.has(p.start)) return false;
      seen.add(p.start);
      return true;
    });
}

/**
 * A day without any guide: hour-long slots from the day's start (or the archive window's) up to
 * the hour airing now, each a stand-in programme the catch-up URL builders play from its start.
 * The window is `durationHours`, else the whole days `archiveDayCount` gives. `title` names each
 * slot from its start.
 */
export function archiveHourSlots(
  start: number,
  end: number,
  now: number,
  channel: Pick<Channel, 'archive' | 'ref'> & { catchup?: Channel['catchup'] },
  title: (slotStart: number) => string,
): EpgProgram[] {
  const hours = channel.archive?.durationHours ?? 0;
  const oldest = now - (hours > 0 ? hours : archiveDayCount(channel) * 24) * HOUR;
  const out: EpgProgram[] = [];
  // Whole local hours: the day starts at local midnight, and a DST day just has 23 or 25 of them.
  for (let s = start; s < end && s < now; s += HOUR) {
    // A slot that starts before the window would be refused (canCatchUp): left out.
    if (s < oldest) continue;
    out.push({ channelId: channel.ref.itemId, start: new Date(s).toISOString(), end: new Date(Math.min(s + HOUR, end)).toISOString(), title: title(s) });
  }
  return out;
}

/** Row the list should focus first: the airing programme on today, else the last one that can play, else the first. */
export function initialProgramIndex(states: readonly ArchiveProgramState[]): number {
  const airing = states.indexOf('airing');
  if (airing >= 0) return airing;
  const live = states.indexOf('live');
  if (live >= 0) return live;
  const lastPlayable = states.lastIndexOf('playable');
  if (lastPlayable >= 0) return lastPlayable;
  return states.length > 0 ? 0 : -1;
}
