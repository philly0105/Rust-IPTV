/**
 * Subtitle files for the built-in player (C6): SRT, WebVTT and ASS/SSA become plain cues.
 * Markup is dropped (HTML-style tags, ASS override blocks), so every format is styled the
 * same way by the user's subtitle settings. Embedded mpv reads the files itself.
 */

export interface SubtitleCue {
  /** Seconds. */
  start: number;
  /** Seconds. */
  end: number;
  /** Plain text; lines separated by `\n`. */
  text: string;
}

export type SubtitleFormat = 'srt' | 'vtt' | 'ass';

/** The file has no cue this parser can read. */
export class SubtitleParseError extends Error {
  constructor(message = 'The file has no subtitles that can be read.') {
    super(message);
    this.name = 'SubtitleParseError';
  }
}

/** Largest subtitle file either player accepts (the core checks the same limit for mpv). */
export const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;

/** File extensions offered by the pickers. */
export const SUBTITLE_EXTENSIONS = ['srt', 'vtt', 'ass', 'ssa'] as const;

const TIME = String.raw`(?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?`;
/** `00:00:01,000 --> 00:00:04,000` (SRT) or `00:01.000 --> 00:04.000 line:90%` (WebVTT). */
const TIMING = new RegExp(String.raw`^\s*(${TIME})\s*-->\s*(${TIME})`);

/** BOM off, every line ending as `\n`. */
function normalize(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/** `1:02:03.5`, `02:03,500` -> seconds; null when it is not a timestamp. */
export function parseTimestamp(value: string): number | null {
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?\s*$/.exec(value);
  if (!m) return null;
  const [, h = '0', min = '0', sec = '0', frac] = m;
  const minutes = Number(min);
  const seconds = Number(sec);
  if (minutes > 59 || seconds > 59) return null;
  // The fraction is decimal whatever its width: ASS writes centiseconds, SRT milliseconds.
  return Number(h) * 3600 + minutes * 60 + seconds + (frac ? Number(`0.${frac}`) : 0);
}

/** Picks the format from the file's content first (a mislabelled file still loads), then its extension. */
export function detectFormat(fileName: string, text: string): SubtitleFormat | null {
  const head = normalize(text).trimStart().slice(0, 4096);
  if (/^WEBVTT(?:[ \t\n]|$)/.test(head)) return 'vtt';
  if (/^\[Script Info\]/i.test(head) || /^\[(?:V4\+? Styles|Events)\]/im.test(head)) return 'ass';
  const ext = /\.([a-z0-9]+)\s*$/i.exec(fileName)?.[1]?.toLowerCase();
  if (ext === 'srt') return 'srt';
  if (ext === 'vtt') return 'vtt';
  if (ext === 'ass' || ext === 'ssa') return 'ass';
  return head.split('\n').some((line) => TIMING.test(line)) ? 'srt' : null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '‎', rlm: '‏' };

/** SRT and WebVTT text: tags (`<i>`, `<font>`, `<c.yellow>`, `<00:01.000>`) and `{\an8}` codes off, entities decoded. */
function cleanMarkup(text: string): string {
  return tidy(
    text
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/<[^>\n]*>/g, '')
      .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
        if (name[0] === '#') {
          const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
          return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
        }
        return ENTITIES[name.toLowerCase()] ?? whole;
      }),
  );
}

/** Trailing spaces and blank lines off; empty when nothing readable is left. */
function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
}

function parseBlocks(text: string): SubtitleCue[] {
  const lines = normalize(text).split('\n');
  const cues: SubtitleCue[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = TIMING.exec(lines[i] ?? '');
    i++;
    if (!m) continue;
    const body: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() !== '') {
      // A timing line straight after the text starts the next cue (files with missing blank lines);
      // a bare number just above it is that cue's SRT index, not text.
      if (TIMING.test(lines[i] ?? '')) {
        if (/^\d+$/.test((body[body.length - 1] ?? '').trim())) body.pop();
        break;
      }
      body.push(lines[i] ?? '');
      i++;
    }
    const start = parseTimestamp(m[1] ?? '');
    const end = parseTimestamp(m[2] ?? '');
    const cueText = cleanMarkup(body.join('\n'));
    if (start !== null && end !== null && end > start && cueText) cues.push({ start, end, text: cueText });
  }
  return cues;
}

/** The default `[Events]` field order of ASS (SSA starts with `Marked` instead of `Layer`). */
const ASS_FIELDS = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];

/** ASS dialogue text: override blocks and drawings off, `\N` and `\n` as line breaks, `\h` as a hard space. */
export function cleanAssText(text: string): string {
  let out = '';
  let drawing = false;
  // Split into override blocks and the text between them.
  for (const part of text.split(/(\{[^}]*\})/)) {
    if (part.startsWith('{') && part.endsWith('}')) {
      // `\p1` and up switch to vector drawing commands, `\p0` back to text.
      const p = /\\p(\d+)/.exec(part);
      if (p) drawing = Number(p[1]) > 0;
      continue;
    }
    if (!drawing) out += part;
  }
  return tidy(out.replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' '));
}

function parseAss(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let section = '';
  let fields = ASS_FIELDS;
  for (const raw of normalize(text).split('\n')) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = (header[1] ?? '').toLowerCase();
      continue;
    }
    if (section !== 'events') continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const kind = line.slice(0, colon).trim().toLowerCase();
    const rest = line.slice(colon + 1);
    if (kind === 'format') {
      const named = rest.split(',').map((f) => f.trim().toLowerCase());
      if (named.includes('start') && named.includes('end') && named[named.length - 1] === 'text') fields = named;
      continue;
    }
    if (kind !== 'dialogue') continue;
    // The text is the last field and may itself contain commas.
    const values = rest.split(',');
    if (values.length < fields.length) continue;
    const head = values.slice(0, fields.length - 1);
    const body = values.slice(fields.length - 1).join(',');
    const start = parseTimestamp(head[fields.indexOf('start')] ?? '');
    const end = parseTimestamp(head[fields.indexOf('end')] ?? '');
    const cueText = cleanAssText(body);
    if (start !== null && end !== null && end > start && cueText) cues.push({ start, end, text: cueText });
  }
  // ASS events may come in any order; cues are easier to reason about sorted (the sort is stable).
  return cues.sort((a, b) => a.start - b.start);
}

/** Reads every cue of `text`. Throws `SubtitleParseError` when there is none. */
export function parseSubtitles(text: string, format: SubtitleFormat): SubtitleCue[] {
  const cues = format === 'ass' ? parseAss(text) : parseBlocks(text);
  if (cues.length === 0) throw new SubtitleParseError();
  return cues;
}
