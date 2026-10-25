import type { Channel, EpgNowNext, EpgProgram, SourceKind } from '@/api/types';
import { intlLocale } from '@/lib/intl';

import { type CatchupChannel, isM3uCatchupSupported } from './catchup';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export type ProgramWhen = 'past' | 'now' | 'future';

/** XMLTV's compact form: `20261012100000 +0545` (offset optional, UTC when missing). */
const XMLTV_COMPACT = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*(?:([+-])(\d{2}):?(\d{2}))?$/;

/**
 * Times already read, by their text (P2-GUIDE-4): a guide row reads each programme's start and
 * end many times per render (sorting, layout, past/now/future, catch-up, its label), and a fling
 * renders hundreds of rows. Only UTC texts ("...Z", as the core and toISOString write them): a
 * text without a zone is local time, which can change while the app runs.
 */
const parsedTimes = new Map<string, number>();
const PARSED_TIMES_MAX = 4096;

/** Epoch ms of a programme time; 0 when it cannot be read (see `isValidProgram`). */
export function ms(iso: string | null | undefined): number {
  if (!iso) return 0;
  if (!iso.endsWith('Z')) return parseTime(iso);
  let t = parsedTimes.get(iso);
  if (t === undefined) {
    t = parseTime(iso);
    if (parsedTimes.size >= PARSED_TIMES_MAX) parsedTimes.clear();
    parsedTimes.set(iso, t);
  }
  return t;
}

function parseTime(iso: string): number {
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

// guide: jump to a date and time (Run 2 C5). Calendar days are built from local dates, never by
// adding 24 h, so a 23 h or 25 h DST day still lands on the right midnight.

/** First instant of the local calendar day holding `t` (01:00 where midnight does not exist). */
export function localDayStart(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Start of each local day from `back` days before `now`'s day to `ahead` days after it. */
export function jumpDays(now: number, back = 2, ahead = 13): number[] {
  const d = new Date(now);
  const out: number[] = [];
  for (let i = -back; i <= ahead; i++) out.push(new Date(d.getFullYear(), d.getMonth(), d.getDate() + i).getTime());
  return out;
}

/** Whole local days from `now`'s day to `t`'s day (0 today, -1 yesterday), counted on the calendar. */
export function localDayDiff(t: number, now: number): number {
  const a = new Date(t);
  const b = new Date(now);
  return Math.round((Date.UTC(a.getFullYear(), a.getMonth(), a.getDate()) - Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())) / DAY);
}

/** Minutes past local midnight on the wall clock (01:30 -> 90), whatever the DST state. */
export function wallMinutes(t: number): number {
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * The 30-minute instants of the local day starting at `day`: 48 on most days, 46 on a
 * spring-forward day (the skipped hour has no slots), 50 on a fall-back day (the repeated hour
 * appears twice, as two different instants).
 */
export function daySlots(day: number, stepMinutes = 30): number[] {
  const key = localDayKey(day);
  const out: number[] = [];
  // Step real time, re-snapped to the local grid, so :30 and :45 zones stay on local :00/:30.
  for (let t = floorLocal(day, stepMinutes), guard = 0; localDayKey(t) === key && guard < 200; guard++) {
    if (t >= day) out.push(t);
    t = floorLocal(t + stepMinutes * MINUTE + MINUTE, stepMinutes);
  }
  return out;
}

/**
 * The instant of wall time `minutes` (past midnight) on the local day starting at `day`: the
 * first of the two in a repeated hour, the next slot that exists when a DST gap swallowed it.
 */
export function atWallTime(day: number, minutes: number, stepMinutes = 30): number {
  const slots = daySlots(day, stepMinutes);
  return slots.find((t) => wallMinutes(t) >= minutes) ?? slots[slots.length - 1] ?? day;
}

/** Earliest and latest window starts the `at` URL parameter accepts (2000-01-01 .. 2100-01-01 UTC). */
const AT_MIN = Date.UTC(2000, 0, 1);
const AT_MAX = Date.UTC(2100, 0, 1);

/** Reads the guide's `at=<epoch ms>` URL parameter, floored to the local 30-minute slot; null when absent or unusable. */
export function parseWindowAt(raw: string | null | undefined): number | null {
  if (!raw || !/^\d{1,15}$/.test(raw)) return null;
  const t = Number(raw);
  if (!Number.isSafeInteger(t) || t < AT_MIN || t > AT_MAX) return null;
  return floorLocal(t, 30);
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

/**
 * Where a time track (the guide grid, the ribbon's timeline) scrolls to when it rests on now, in
 * px from its start `from`: the start of the local half hour now is in, so the track begins on a
 * slot line, its first time label is whole and cells start whole instead of as slivers. Should
 * that leave less than `lead` px before now, where the now mark's head would sit on the edge
 * (cut by it, or under the first label), the half hour before. Should now then sit past three
 * quarters of a narrow track (`view` px wide; 0 or less: not measured yet), a quarter of the
 * track before now instead.
 */
export function nowRestLeft(now: number, from: number, pxPerMin: number, view: number, lead: number): number {
  const nowX = ((now - from) / MINUTE) * pxPerMin;
  let slotX = ((floorLocal(now, 30) - from) / MINUTE) * pxPerMin;
  if (nowX - slotX < lead) slotX -= 30 * pxPerMin;
  if (view > 0 && nowX - slotX > view * 0.75) return Math.max(0, Math.round(nowX - view / 4));
  return Math.max(0, slotX);
}

/**
 * The hour form of a locale's clock: two digits on a 24-hour clock ("08:05", as de, fr, ja and
 * the rest write it, and as wide as any other time, so the guide's columns line up), numeric on a
 * 12-hour one ("8:05 PM", "오후 8:05": a leading zero there reads as a typo).
 */
function hourForm(tag: string): '2-digit' | 'numeric' {
  const cycle = new Intl.DateTimeFormat(tag, { hour: 'numeric' }).resolvedOptions().hourCycle;
  return cycle === 'h23' || cycle === 'h24' ? '2-digit' : 'numeric';
}

const timeFormatters = new Map<string, Intl.DateTimeFormat>();
function clockFormatter(locale?: string): Intl.DateTimeFormat {
  const key = locale ?? '';
  let f = timeFormatters.get(key);
  if (!f) {
    const tag = intlLocale(locale);
    f = new Intl.DateTimeFormat(tag, { hour: hourForm(tag), minute: '2-digit' });
    timeFormatters.set(key, f);
  }
  return f;
}

/** Clock time in the UI language: "8:30 PM", "20:30", "08:05". */
export function formatClock(t: number, locale?: string): string {
  return clockFormatter(locale).format(t);
}

/** The parts of a formatted time, with the day period (AM/PM) and the space next to it dropped. */
function withoutDayPeriod(parts: Intl.DateTimeFormatPart[]): string {
  const i = parts.findIndex((p) => p.type === 'dayPeriod');
  if (i < 0) return parts.map((p) => p.value).join('');
  // The literal between the period and the time goes with it ("8:30 PM" -> "8:30", "오후 8:30" -> "8:30").
  const drop = new Set([i, i === 0 ? 1 : i - 1]);
  return parts
    .filter((p, j) => !(drop.has(j) && (j === i || p.type === 'literal')))
    .map((p) => p.value)
    .join('')
    .trim();
}

/**
 * Clock time without AM/PM ("8:30"), for the guide's time ruler, which names the period on
 * the hour only. Locales without a day period get the same string as {@link formatClock}.
 */
export function formatClockBare(t: number, locale?: string): string {
  return withoutDayPeriod(clockFormatter(locale).formatToParts(t));
}

/**
 * Ranges already formatted, by locale, start and end (P2-GUIDE-4): every guide cell names its
 * range, a guide's programmes share a few dozen times, and formatting one takes two
 * formatToParts and two format calls. Keyed like the formatters, which keep the zone they were
 * made in.
 */
const ranges = new Map<string, string>();
const RANGES_MAX = 2000;

/**
 * "8:00 – 8:30 PM": a time range that names a shared AM/PM once, on the side the locale puts
 * it ("오후 8:00 – 8:30" in Korean). Hours keep the locale's form; 24-hour locales read "08:00 – 08:30".
 * Intl's own formatRange is not used: it switches some locales to longer forms ("8時00分～").
 */
export function formatTimeRange(start: number, end: number, locale?: string): string {
  const key = `${locale ?? ''}|${start}|${end}`;
  let out = ranges.get(key);
  if (out === undefined) {
    out = timeRange(clockFormatter(locale), start, end);
    if (ranges.size >= RANGES_MAX) ranges.clear();
    ranges.set(key, out);
  }
  return out;
}

function timeRange(f: Intl.DateTimeFormat, start: number, end: number): string {
  const a = f.formatToParts(start);
  const b = f.formatToParts(end);
  const pa = a.find((p) => p.type === 'dayPeriod')?.value;
  const pb = b.find((p) => p.type === 'dayPeriod')?.value;
  const join = (x: string, y: string) => `${x} – ${y}`;
  if (pa === undefined || pa !== pb) return join(f.format(start), f.format(end));
  // The period leads in some locales (ko, zh-TW): it stays on the start and goes from the end.
  const leads = a.findIndex((p) => p.type === 'dayPeriod') === 0;
  return leads ? join(f.format(start), withoutDayPeriod(b)) : join(withoutDayPeriod(a), f.format(end));
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
export function formatDay(t: number, locale?: string): string {
  const key = locale ?? '';
  let f = dayFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(intlLocale(locale), { weekday: 'short', day: 'numeric', month: 'short' });
    dayFormatters.set(key, f);
  }
  return f.format(t);
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();
/** Clock time with the zone's short name ("01:30 GMT+1", "1:30 AM GMT"): tells the two 01:30s of a fall-back night apart. */
export function formatClockZone(t: number, locale?: string): string {
  const key = locale ?? '';
  let f = zoneFormatters.get(key);
  if (!f) {
    const tag = intlLocale(locale);
    f = new Intl.DateTimeFormat(tag, { hour: hourForm(tag), minute: '2-digit', timeZoneName: 'short' });
    zoneFormatters.set(key, f);
  }
  return f.format(t);
}

// Many channels share slot times. Reuse their labels when virtual rows mount or a rolling
// query returns new programme objects, instead of repeating Intl.formatToParts per tile.
const rangeLabels = new Map<string, string>();
const MAX_RANGE_LABELS = 4096;
export function formatRange(p: EpgProgram, locale?: string): string {
  const key = `${locale ?? ''}|${p.start}|${p.end}`;
  const hit = rangeLabels.get(key);
  if (hit !== undefined) return hit;
  const label = formatTimeRange(ms(p.start), ms(p.end), locale);
  if (rangeLabels.size >= MAX_RANGE_LABELS) rangeLabels.delete(rangeLabels.keys().next().value!);
  rangeLabels.set(key, label);
  return label;
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

/** Room a clipped cell keeps for its text before the cell's end pushes the text out. */
export const CELL_TEXT_MIN_PX = 48;

/**
 * How far, in px, the text of a cell `left` px into a time track and `width` px wide is pushed
 * past its own start with the track scrolled `scroll` px from its inline start: a show that began
 * before the visible edge has its text moved just past the edge, until only
 * {@link CELL_TEXT_MIN_PX} of it is left. A cell sits at left + 1 with a 1 px border and 8 px
 * padding, so its text starts at left + 10 and should start 8 px past the edge. Guide cells and
 * ribbon blocks pin their text there with `position: sticky`; this is the room the text gives up,
 * so its box (and its ellipsis) ends where the cell does.
 */
export function cellTextPadPx(scroll: number, left: number, width: number): number {
  const max = Math.max(0, width - 20 - CELL_TEXT_MIN_PX);
  return Math.min(max, Math.max(0, scroll - (left + 2)));
}

/** Widest a cell's sticky text may be (see {@link cellTextPadPx}); undefined when the cell is not clipped. */
export function cellTextMaxPx(scroll: number, left: number, width: number): number | undefined {
  const pad = cellTextPadPx(scroll, left, width);
  return pad > 0 ? width - 20 - pad : undefined;
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
