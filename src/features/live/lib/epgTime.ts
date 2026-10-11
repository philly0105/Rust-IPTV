import type { Channel, EpgNowNext, EpgProgram, SourceKind } from '@/api/types';

import { type CatchupChannel, isM3uCatchupSupported } from './catchup';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export type ProgramWhen = 'past' | 'now' | 'future';

export function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

export function programWhen(p: EpgProgram, now: number): ProgramWhen {
  if (ms(p.end) <= now) return 'past';
  if (ms(p.start) <= now) return 'now';
  return 'future';
}

/** 0..1 elapsed fraction of a programme. */
export function programProgress(p: EpgProgram, now: number): number {
  const s = ms(p.start);
  const e = ms(p.end);
  if (e <= s) return 0;
  return Math.min(1, Math.max(0, (now - s) / (e - s)));
}

export function minutesLeft(p: EpgProgram, now: number): number {
  return Math.max(0, Math.ceil((ms(p.end) - now) / MINUTE));
}

export function durationMinutes(p: EpgProgram): number {
  return Math.max(1, Math.round((ms(p.end) - ms(p.start)) / MINUTE));
}

export function floorTo(t: number, stepMs: number): number {
  return Math.floor(t / stepMs) * stepMs;
}

const timeFormatters = new Map<string, Intl.DateTimeFormat>();
export function formatClock(t: number, locale?: string): string {
  const key = locale ?? '';
  let f = timeFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
    timeFormatters.set(key, f);
  }
  return f.format(t);
}

export function formatDay(t: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(t);
}

export function formatRange(p: EpgProgram, locale?: string): string {
  return `${formatClock(ms(p.start), locale)} – ${formatClock(ms(p.end), locale)}`;
}

/**
 * True when the channel's archive can actually be played: xtream and stalker archives, and M3U
 * channels whose `catchup` attributes resolve to a URL builder.
 */
export function hasUsableArchive(channel: CatchupChannel | undefined, kind: SourceKind | undefined): boolean {
  if (!channel?.archive?.enabled) return false;
  if (kind === 'xtream' || kind === 'stalker') return true;
  if (kind === 'm3u') return isM3uCatchupSupported(channel);
  // Kind unknown (the source is still loading): only M3U rows carry `catchup`.
  return channel.catchup ? isM3uCatchupSupported(channel) : true;
}

/** Catch-up works for ended and airing programmes inside the archive window of a usable archive. */
export function canCatchUp(p: EpgProgram, channel: CatchupChannel, kind: SourceKind | undefined, now: number): boolean {
  if (kind !== 'xtream' && kind !== 'stalker' && kind !== 'm3u') return false;
  if (!hasUsableArchive(channel, kind)) return false;
  const when = programWhen(p, now);
  if (when === 'future') return false;
  const hours = channel.archive?.durationHours ?? 0;
  if (hours > 0 && ms(p.start) < now - hours * HOUR) return false;
  return true;
}

/** Longest archive window the ribbon looks back over. */
export const MAX_LOOKBACK_HOURS = 7 * 24;

/** How far back the ribbon looks for a channel: its archive window (max 7 days, 24 h when unknown) or 3 h. */
export function lookbackMs(channel: Pick<Channel, 'archive'> | undefined): number {
  if (channel?.archive?.enabled) {
    const h = channel.archive.durationHours && channel.archive.durationHours > 0 ? channel.archive.durationHours : 24;
    return Math.min(h, MAX_LOOKBACK_HOURS) * HOUR;
  }
  return 3 * HOUR;
}

export interface Block {
  program: EpgProgram;
  /** px from the window start */
  left: number;
  width: number;
  when: ProgramWhen;
  /** clipped at the window's left or right edge */
  clipStart: boolean;
  clipEnd: boolean;
}

/**
 * Lays programmes out on a horizontal axis. Programmes outside [from, to) are dropped,
 * overlapping ones are trimmed so blocks never cover each other.
 */
export function layoutBlocks(programs: EpgProgram[], from: number, to: number, pxPerMinute: number, now: number): Block[] {
  const sorted = [...programs].sort((a, b) => ms(a.start) - ms(b.start));
  const out: Block[] = [];
  let cursor = from;
  for (const p of sorted) {
    const s = ms(p.start);
    const e = ms(p.end);
    if (e <= from || s >= to || e <= s) continue;
    const start = Math.max(s, from, cursor);
    const end = Math.min(e, to);
    if (end <= start) continue;
    cursor = end;
    out.push({
      program: p,
      left: ((start - from) / MINUTE) * pxPerMinute,
      width: ((end - start) / MINUTE) * pxPerMinute,
      when: programWhen(p, now),
      clipStart: s < from,
      clipEnd: e > to,
    });
  }
  return out;
}

/** Index of the programme covering `t`, else the first starting after it, else the last. */
export function programIndexAt(programs: EpgProgram[], t: number): number {
  if (programs.length === 0) return -1;
  for (let i = 0; i < programs.length; i++) {
    const p = programs[i]!;
    if (ms(p.end) > t) return i;
  }
  return programs.length - 1;
}

/** Moves a programme by `settings.epgOffsetMinutes` (guides published in the wrong time zone). */
export function shiftProgram(p: EpgProgram, offsetMinutes: number): EpgProgram {
  if (!offsetMinutes) return p;
  const d = offsetMinutes * MINUTE;
  return { ...p, start: new Date(ms(p.start) + d).toISOString(), end: new Date(ms(p.end) + d).toISOString() };
}

export function shiftPrograms(list: EpgProgram[], offsetMinutes: number): EpgProgram[] {
  return offsetMinutes ? list.map((p) => shiftProgram(p, offsetMinutes)) : list;
}

export function shiftNowNext(nn: EpgNowNext | undefined, offsetMinutes: number): EpgNowNext | undefined {
  if (!nn || !offsetMinutes) return nn;
  return {
    ...nn,
    now: nn.now ? shiftProgram(nn.now, offsetMinutes) : nn.now,
    next: nn.next ? shiftProgram(nn.next, offsetMinutes) : nn.next,
  };
}
