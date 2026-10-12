import type { Channel, EpgNowNext, EpgProgram, SourceKind } from '@/api/types';

import { type CatchupChannel, isM3uCatchupSupported } from './catchup';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export type ProgramWhen = 'past' | 'now' | 'future';

/** XMLTV's compact form: `20261012100000 +0545` (offset optional, UTC when missing). */
const XMLTV_COMPACT = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*(?:([+-])(\d{2}):?(\d{2}))?$/;

/** Epoch ms of a programme time; 0 when it cannot be read (see `isValidProgram`). */
export function ms(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isNaN(t)) return t;
  const m = XMLTV_COMPACT.exec(iso.trim());
  if (!m) return 0;
  const [, y, mo, d, h, mi, s, sign, oh, om] = m;
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  const offset = sign ? (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om)) * MINUTE : 0;
  const out = utc - offset;
  return Number.isFinite(out) ? out : 0;
}

/** Both times readable and the programme has a length. Unreadable times must never read as 1970. */
export function isValidProgram(p: Pick<EpgProgram, 'start' | 'end'>): boolean {
  const s = ms(p.start);
  const e = ms(p.end);
  return s > 0 && e > s;
}

// ---- local calendar (the viewer's time zone, DST and :30/:45 offsets included) ----

/** Latest local `step`-minute boundary at or before `t` (10:52 -> 10:30 for 30; Nepal stays on its own :00/:30). */
export function floorLocal(t: number, stepMinutes: number): number {
  const d = new Date(t);
  const minutes = d.getHours() * 60 + d.getMinutes();
  // Step back by the wall-clock distance, not by rebuilding the wall time: in the repeated hour
  // of a DST fall-back, "01:30" names two instants and setHours may pick the wrong one.
  const into = (minutes % stepMinutes) * MINUTE + d.getSeconds() * 1000 + d.getMilliseconds();
  return t - into;
}

/** Same local wall time `days` calendar days later (a DST day is 23 or 25 h long). */
export function addLocalDays(t: number, days: number): number {
  const d = new Date(t);
  const h = d.getHours();
  const m = d.getMinutes();
  d.setDate(d.getDate() + days);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/** Local calendar key `YYYY-M-D`, for "did the day change between these two instants". */
export function localDayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Local whole-hour instants in (from, to): the ribbon's ticks. Skips the hour a DST jump removes. */
export function localHourTicks(from: number, to: number): number[] {
  const out: number[] = [];
  // Each tick re-snaps to the local hour, so a half-hour DST change (Lord Howe) stays on :00.
  let t = floorLocal(from + HOUR, 60);
  for (let guard = 0; t < to && guard < 24 * 32; guard++) {
    if (t > from) out.push(t);
    t = floorLocal(t + HOUR + MINUTE, 60);
  }
  return out;
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

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
export function formatDay(t: number, locale?: string): string {
  const key = locale ?? '';
  let f = dayFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' });
    dayFormatters.set(key, f);
  }
  return f.format(t);
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
    if (e <= from || s >= to || !isValidProgram(p)) continue;
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
