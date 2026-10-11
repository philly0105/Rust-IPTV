import { describe, expect, it } from 'vitest';

import { type CatchupChannel, fillCatchupTemplate, isM3uCatchupSupported, m3uCatchupMode, resolveM3uCatchupUrl } from '../lib/catchup';
import { displayChannelName, stripCountryPrefix } from '../lib/channelName';
import { HOUR, MINUTE, canCatchUp, hasUsableArchive, lookbackMs, shiftNowNext, shiftProgram } from '../lib/epgTime';

// 2026-10-11 10:00 UTC to 11:30 UTC, watched at 12:00 UTC.
const START = Date.UTC(2026, 9, 11, 10, 0);
const END = Date.UTC(2026, 9, 11, 11, 30);
const NOW = Date.UTC(2026, 9, 11, 12, 0);
const W = { start: START, end: END, now: NOW };
const S = 1791712800; // START in seconds
const E = 1791718200;
const N = 1791720000;

const ch = (url: string, catchup?: CatchupChannel['catchup'], enabled = true): CatchupChannel => ({
  url,
  archive: enabled ? { enabled: true, durationHours: 72 } : undefined,
  catchup,
});

describe('fillCatchupTemplate', () => {
  it('fills timestamps, durations, offsets and date parts', () => {
    expect(fillCatchupTemplate('{utc}|{start}|${start}|{utcend}|{end}|${end}|{lutc}|{now}|${timestamp}', W)).toBe(
      `${S}|${S}|${S}|${E}|${E}|${E}|${N}|${N}|${N}`,
    );
    expect(fillCatchupTemplate('{duration}|${duration}|{duration:60}|{offset}|{offset:60}|${offset:3600}', W)).toBe('5400|5400|90|7200|120|2');
    expect(fillCatchupTemplate('{Y}-{m}-{d}:{H}-{M}-{S}', W)).toBe('2026-10-11:10-00-00');
    expect(fillCatchupTemplate('{utc:Y-m-d:H-M}/{utcend:YmdHM}/${now:H-M}', W)).toBe('2026-10-11:10-00/202610111130/12-00');
    expect(fillCatchupTemplate('{unknown}/{duration:x}', W)).toBe('{unknown}/{duration:x}');
  });
});

describe('resolveM3uCatchupUrl', () => {
  it('default: an absolute catchup-source is the template', () => {
    const c = ch('http://live.example/ch1.m3u8', { type: 'default', source: 'http://arc.example/ch1/{Y}/{m}/{d}/{H}{M}.m3u8?dur={duration:60}' });
    expect(m3uCatchupMode(c)).toBe('template');
    expect(resolveM3uCatchupUrl(c, W)).toBe('http://arc.example/ch1/2026/10/11/1000.m3u8?dur=90');
  });

  it('default: a relative source is appended, no source means shift', () => {
    expect(resolveM3uCatchupUrl(ch('http://live.example/ch1.m3u8', { type: 'default', source: '?utc={utc}' }), W)).toBe(
      `http://live.example/ch1.m3u8?utc=${S}`,
    );
    expect(resolveM3uCatchupUrl(ch('http://live.example/ch1.m3u8', { type: 'default' }), W)).toBe(
      `http://live.example/ch1.m3u8?utc=${S}&lutc=${N}`,
    );
  });

  it('append: adds the filled source to the live URL', () => {
    const c = ch('http://127.0.0.1:7290/xtream/live/demo/secret/104.m3u8', { type: 'append', days: 3, source: '?utc={utc}&lutc={lutc}' });
    expect(resolveM3uCatchupUrl(c, W)).toBe(`http://127.0.0.1:7290/xtream/live/demo/secret/104.m3u8?utc=${S}&lutc=${N}`);
    // a live URL that already has a query joins with &
    expect(resolveM3uCatchupUrl(ch('http://l/x.m3u8?token=a', { type: 'append', source: '?start={start}&end={end}' }), W)).toBe(
      `http://l/x.m3u8?token=a&start=${S}&end=${E}`,
    );
    expect(isM3uCatchupSupported(ch('http://l/x.m3u8', { type: 'append' }))).toBe(false);
  });

  it('shift: utc and lutc query parameters, also for an archive without a type', () => {
    expect(resolveM3uCatchupUrl(ch('http://l/x.m3u8', { type: 'shift' }), W)).toBe(`http://l/x.m3u8?utc=${S}&lutc=${N}`);
    expect(resolveM3uCatchupUrl(ch('http://l/x.m3u8?a=1', { type: 'timeshift' }), W)).toBe(`http://l/x.m3u8?a=1&utc=${S}&lutc=${N}`);
    expect(resolveM3uCatchupUrl(ch('http://l/x.m3u8'), W)).toBe(`http://l/x.m3u8?utc=${S}&lutc=${N}`);
  });

  it('xc: Xtream timeshift path from the live URL', () => {
    expect(resolveM3uCatchupUrl(ch('http://127.0.0.1:7290/xtream/live/demo/secret/101.m3u8', { type: 'xc', days: 7 }), W)).toBe(
      'http://127.0.0.1:7290/xtream/timeshift/demo/secret/90/2026-10-11:10-00/101.m3u8',
    );
    expect(resolveM3uCatchupUrl(ch('http://xc.example:8080/user/pass/42', { type: 'xc' }), W)).toBe(
      'http://xc.example:8080/timeshift/user/pass/90/2026-10-11:10-00/42.ts',
    );
    expect(resolveM3uCatchupUrl(ch('http://xc.example/live/u/p/42.ts', { type: 'xc' }), W)).toBe('http://xc.example/timeshift/u/p/90/2026-10-11:10-00/42.ts');
    expect(isM3uCatchupSupported(ch('http://xc.example/stream', { type: 'xc' }))).toBe(false);
  });

  it('flussonic: archive playlists and mpegts timeshift', () => {
    expect(resolveM3uCatchupUrl(ch('http://fs.example/ch1/index.m3u8?token=t', { type: 'flussonic' }), W)).toBe(
      `http://fs.example/ch1/index-${S}-5400.m3u8?token=t`,
    );
    expect(resolveM3uCatchupUrl(ch('http://fs.example/ch1/video.m3u8', { type: 'flussonic-hls' }), W)).toBe(`http://fs.example/ch1/video-${S}-5400.m3u8`);
    expect(resolveM3uCatchupUrl(ch('http://fs.example/ch1/mpegts?token=t', { type: 'fs' }), W)).toBe(`http://fs.example/ch1/timeshift_abs-${S}.ts?token=t`);
  });

  it('refuses channels without a usable archive', () => {
    expect(resolveM3uCatchupUrl(ch('http://l/x.m3u8', { type: 'shift' }, false), W)).toBeNull();
    expect(resolveM3uCatchupUrl(ch('rtmp://l/x', { type: 'shift' }), W)).toBeNull();
    expect(resolveM3uCatchupUrl(ch('http://l/x.m3u8', { type: 'vod' }), W)).toBeNull();
  });
});

describe('catch-up gating for M3U', () => {
  const p = (s: number, e: number) => ({ channelId: 'c', title: 'x', start: new Date(s).toISOString(), end: new Date(e).toISOString() });

  it('allows m3u only when the catch-up attributes resolve', () => {
    const ended = p(NOW - 3 * HOUR, NOW - 2 * HOUR);
    const usable = ch('http://l/x.m3u8', { type: 'append', source: '?utc={utc}' });
    expect(canCatchUp(ended, usable, 'm3u', NOW)).toBe(true);
    expect(canCatchUp(ended, ch('http://l/x.m3u8', { type: 'append' }), 'm3u', NOW)).toBe(false);
    expect(hasUsableArchive(ch('http://l/x.m3u8', { type: 'append' }), 'm3u')).toBe(false);
    expect(hasUsableArchive(ch('http://l/x.m3u8', { type: 'append' }), undefined)).toBe(false);
    expect(hasUsableArchive({ archive: { enabled: true } }, 'xtream')).toBe(true);
    // outside the 72 h window
    expect(canCatchUp(p(NOW - 80 * HOUR, NOW - 79 * HOUR), usable, 'm3u', NOW)).toBe(false);
  });

  it('looks back over the archive window, at most 7 days', () => {
    expect(lookbackMs({ archive: { enabled: true, durationHours: 72 } })).toBe(72 * HOUR);
    expect(lookbackMs({ archive: { enabled: true, durationHours: 24 * 14 } })).toBe(168 * HOUR);
  });
});

describe('display preferences', () => {
  it('strips country tags', () => {
    expect(stripCountryPrefix('UK: BBC One')).toBe('BBC One');
    expect(stripCountryPrefix('US | CNN')).toBe('CNN');
    expect(stripCountryPrefix('DE - ARD')).toBe('ARD');
    expect(stripCountryPrefix('[FR] TF1')).toBe('TF1');
    expect(stripCountryPrefix('|DE| ARD')).toBe('ARD');
    expect(stripCountryPrefix('4K-DE - The Pitt')).toBe('The Pitt');
    expect(stripCountryPrefix('Sky - Sports F1')).toBe('Sky - Sports F1');
    expect(stripCountryPrefix('NCIS: LA')).toBe('NCIS: LA');
    expect(stripCountryPrefix('1917 - Documentary')).toBe('1917 - Documentary');
    expect(stripCountryPrefix('[UK]')).toBe('[UK]');
    expect(displayChannelName('UK: BBC One', false)).toBe('UK: BBC One');
    expect(displayChannelName('UK: BBC One', true)).toBe('BBC One');
  });

  it('shifts programme times by the EPG offset', () => {
    const prog = { channelId: 'c', title: 'x', start: new Date(START).toISOString(), end: new Date(END).toISOString() };
    expect(shiftProgram(prog, 0)).toBe(prog);
    expect(shiftProgram(prog, 60)).toMatchObject({ start: new Date(START + 60 * MINUTE).toISOString(), end: new Date(END + 60 * MINUTE).toISOString() });
    expect(shiftNowNext({ now: prog }, -30)?.now?.start).toBe(new Date(START - 30 * MINUTE).toISOString());
  });
});
