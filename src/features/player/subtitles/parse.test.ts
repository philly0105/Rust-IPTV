import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { cleanAssText, detectFormat, parseSubtitles, parseTimestamp, SubtitleParseError } from './parse';

describe('parseTimestamp', () => {
  it('reads SRT, WebVTT and ASS timestamps as seconds', () => {
    expect(parseTimestamp('00:00:01,000')).toBe(1);
    expect(parseTimestamp('01:02:03,456')).toBeCloseTo(3723.456);
    expect(parseTimestamp('00:01.500')).toBe(1.5);
    expect(parseTimestamp('12:34.5')).toBe(754.5);
    // ASS writes one-digit hours and centiseconds.
    expect(parseTimestamp('0:00:05.25')).toBe(5.25);
    expect(parseTimestamp('10:00:00.00')).toBe(36000);
  });

  it('rejects anything that is not a timestamp', () => {
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp('abc')).toBeNull();
    expect(parseTimestamp('00:61:00,000')).toBeNull();
    expect(parseTimestamp('00:00:75,000')).toBeNull();
    expect(parseTimestamp('1.5')).toBeNull();
  });
});

describe('detectFormat', () => {
  it('trusts the content first', () => {
    expect(detectFormat('movie.srt', 'WEBVTT\n\n00:01.000 --> 00:02.000\nHi')).toBe('vtt');
    expect(detectFormat('movie.txt', '﻿WEBVTT - English\n')).toBe('vtt');
    expect(detectFormat('movie.srt', '[Script Info]\nTitle: x\n')).toBe('ass');
    expect(detectFormat('movie', '\n[Events]\nFormat: Layer, Start, End, Style, Text\n')).toBe('ass');
  });

  it('falls back to the extension, then to an SRT timing line', () => {
    expect(detectFormat('a.SRT', '')).toBe('srt');
    expect(detectFormat('a.vtt', '')).toBe('vtt');
    expect(detectFormat('a.ass', '')).toBe('ass');
    expect(detectFormat('a.ssa', '')).toBe('ass');
    expect(detectFormat('subs.txt', '1\n00:00:01,000 --> 00:00:02,000\nHello')).toBe('srt');
    expect(detectFormat('notes.txt', 'just some words')).toBeNull();
  });
});

describe('parseSubtitles: SRT', () => {
  it('reads cues, multi-line text and Windows line endings', () => {
    const srt = ['1', '00:00:01,000 --> 00:00:04,000', 'First line', 'second line', '', '2', '00:00:05,500 --> 00:00:07,250', 'Next', ''].join('\r\n');
    expect(parseSubtitles(srt, 'srt')).toEqual([
      { start: 1, end: 4, text: 'First line\nsecond line' },
      { start: 5.5, end: 7.25, text: 'Next' },
    ]);
  });

  it('strips tags and position codes and decodes entities', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\n{\\an8}<i>Hello</i> <font color="#ff0">there</font> &amp; you\n';
    expect(parseSubtitles(srt, 'srt')).toEqual([{ start: 1, end: 2, text: 'Hello there & you' }]);
  });

  it('copes with a missing blank line between cues', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nOne\n2\n00:00:03,000 --> 00:00:04,000\nTwo\n';
    expect(parseSubtitles(srt, 'srt').map((c) => c.text)).toEqual(['One', 'Two']);
  });

  it('skips cues that end before they start or have no text', () => {
    const srt = '1\n00:00:05,000 --> 00:00:04,000\nBackwards\n\n2\n00:00:06,000 --> 00:00:07,000\n<i></i>\n\n3\n00:00:08,000 --> 00:00:09,000\nKept\n';
    expect(parseSubtitles(srt, 'srt')).toEqual([{ start: 8, end: 9, text: 'Kept' }]);
  });
});

describe('parseSubtitles: WebVTT', () => {
  it('reads hour-less timestamps and ignores cue settings, ids, notes and voice tags', () => {
    const vtt = [
      'WEBVTT',
      '',
      'NOTE a comment',
      '',
      'intro',
      '00:01.000 --> 00:03.000 line:90% align:center',
      '<v Anna>Where are you?</v>',
      '',
      '01:00:00.000 --> 01:00:02.500',
      '<c.yellow>Here</c>',
      'and <00:00:01.500>there',
      '',
    ].join('\n');
    expect(parseSubtitles(vtt, 'vtt')).toEqual([
      { start: 1, end: 3, text: 'Where are you?' },
      { start: 3600, end: 3602.5, text: 'Here\nand there' },
    ]);
  });
});

describe('parseSubtitles: ASS', () => {
  const ass = (events: string[]): string =>
    ['[Script Info]', 'Title: Test', '', '[V4+ Styles]', 'Format: Name, Fontname', 'Style: Default,Arial', '', '[Events]', ...events].join('\n');

  it('reads Dialogue lines in start order, keeping commas in the text', () => {
    const text = ass([
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Comment: 0,0:00:00.00,0:00:09.00,Default,,0,0,0,,Not shown',
      'Dialogue: 0,0:00:04.00,0:00:05.50,Default,,0,0,0,,Later, with a comma',
      'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Earlier',
    ]);
    expect(parseSubtitles(text, 'ass')).toEqual([
      { start: 1, end: 2, text: 'Earlier' },
      { start: 4, end: 5.5, text: 'Later, with a comma' },
    ]);
  });

  it('strips override tags and drawings, and turns \\N and \\h into a line break and a hard space', () => {
    const text = ass([
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8\\b1\\c&H00FFFF&}Top{\\b0} line\\Nsecond\\hline',
      'Dialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}',
    ]);
    expect(parseSubtitles(text, 'ass')).toEqual([{ start: 1, end: 3, text: 'Top line\nsecond line' }]);
    expect(cleanAssText('{\\i1}a{\\p2}m 1 1{\\p0}b')).toBe('ab');
  });

  it('follows the Format line of an SSA file', () => {
    const text = ass([
      'Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: Marked=0,0:00:02.00,0:00:03.00,Default,NTP,0000,0000,0000,!Effect,Old style',
    ]);
    expect(parseSubtitles(text, 'ass')).toEqual([{ start: 2, end: 3, text: 'Old style' }]);
  });
});

describe('parseSubtitles: bad input', () => {
  it('throws SubtitleParseError when nothing can be read', () => {
    expect(() => parseSubtitles('', 'srt')).toThrow(SubtitleParseError);
    expect(() => parseSubtitles('WEBVTT\n\nno cues here', 'vtt')).toThrow(SubtitleParseError);
    expect(() => parseSubtitles('1\nnot a time --> also not\nHello', 'srt')).toThrow(SubtitleParseError);
    expect(() => parseSubtitles('[Script Info]\nTitle: no events', 'ass')).toThrow(SubtitleParseError);
    expect(() => parseSubtitles('\u0000\u0001binary\u0002', 'srt')).toThrow(SubtitleParseError);
  });
});

describe('the e2e fixture files', () => {
  const read = (name: string): string => readFileSync(resolve(process.cwd(), 'e2e/fixtures/subtitles', name), 'utf8');

  it.each([
    ['sample.srt', 'srt', 3, 'First subtitle line\nwith a second line'],
    ['sample.vtt', 'vtt', 2, 'Web cue one'],
    ['sample.ass', 'ass', 2, 'Styled line\nsecond row'],
  ] as const)('%s reads as %s', (name, format, count, first) => {
    const text = read(name);
    expect(detectFormat(name, text)).toBe(format);
    const cues = parseSubtitles(text, format);
    expect(cues).toHaveLength(count);
    expect(cues[0]?.text).toBe(first);
  });

  it('broken.srt has nothing to read', () => {
    expect(() => parseSubtitles(read('broken.srt'), 'srt')).toThrow(SubtitleParseError);
  });
});
