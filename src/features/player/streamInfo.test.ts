import type { TFunction } from 'i18next';
import { afterEach, describe, expect, it } from 'vitest';

import {
  bufferAhead,
  channelsLabel,
  codecLabel,
  containerLabel,
  hwdecLabel,
  readStats,
  setStatsProvider,
  statsRows,
  streamHost,
  toggleStreamInfo,
  useStreamInfoStore,
} from './streamInfo';
import { usePlayerStore } from './store';

const t = ((key: string) => key) as unknown as TFunction<'player'>;

describe('stream info labels', () => {
  it('names common codecs and keeps unknown ones as given', () => {
    expect(codecLabel('avc1.4d401f')).toBe('H.264');
    expect(codecLabel('hvc1.1.6.L93.B0')).toBe('HEVC');
    expect(codecLabel('mp4a.40.2')).toBe('AAC');
    expect(codecLabel('mp4a.40.5')).toBe('HE-AAC');
    expect(codecLabel('avc1.64001f, mp4a.40.2')).toBe('H.264');
    expect(codecLabel('ec-3')).toBe('E-AC-3');
    expect(codecLabel('theora')).toBe('theora');
    expect(codecLabel('')).toBeUndefined();
  });

  it('names channel layouts', () => {
    expect(channelsLabel(1, t)).toBe('infoMono');
    expect(channelsLabel(2, t)).toBe('infoStereo');
    expect(channelsLabel(6, t)).toBe('5.1');
    expect(channelsLabel(8, t)).toBe('7.1');
    expect(channelsLabel(3, t)).toBe('3');
    expect(channelsLabel(undefined, t)).toBeUndefined();
  });

  it('shows only the host, never the path, user or password', () => {
    const url = 'http://demo:secret@iptv.example.com:8080/live/demo/secret/101.ts?token=abc';
    expect(streamHost(url, t)).toBe('iptv.example.com:8080');
    expect(streamHost('C:\\Videos\\clip.mkv', t)).toBe('infoLocalFile');
    expect(streamHost('file:///home/me/clip.mkv', t)).toBe('infoLocalFile');
    expect(streamHost('/home/me/clip.mkv', t)).toBe('infoLocalFile');
    expect(streamHost('not a url', t)).toBeUndefined();
  });

  it('builds every row with no credential in any value', () => {
    const url = 'http://demo:secret@h.example/live/demo/secret/1.m3u8';
    const rows = statsRows({ engine: 'hls', videoCodec: 'avc1.64001f', width: 1920, height: 1080, fps: 25, audioChannels: 2 }, url, t, 'en');
    expect(rows).toHaveLength(13);
    const byKey = Object.fromEntries(rows);
    expect(byKey.infoEngine).toBe('hls.js');
    expect(byKey.infoVideoCodec).toBe('H.264');
    expect(byKey.infoResolution).toBe('1920×1080');
    expect(byKey.infoFrameRate).toBe('25 fps');
    expect(byKey.infoChannels).toBe('infoStereo');
    expect(byKey.infoVideoBitrate).toBe('–');
    expect(byKey.infoContainer).toBe('HLS');
    expect(byKey.infoHost).toBe('h.example');
    expect(rows.flat().join(' ')).not.toMatch(/secret|demo/);
  });

  it('tells software decoding apart from no answer', () => {
    expect(hwdecLabel({ engine: 'mpv', hwdec: 'd3d11va', hwdecKnown: true }, t)).toBe('d3d11va');
    expect(hwdecLabel({ engine: 'mpv', hwdecKnown: true }, t)).toBe('infoHwdecOff');
    expect(hwdecLabel({ engine: 'mpv', hwdecKnown: false }, t)).toBe('–');
    expect(hwdecLabel({ engine: 'hls' }, t)).toBe('infoHwdecBrowser');
  });

  it('prefers the container mpv reports', () => {
    expect(containerLabel({ engine: 'mpv', container: 'mpegts' }, 'http://h/1.m3u8')).toBe('mpegts');
    expect(containerLabel({ engine: 'native' }, 'http://h/movie.mkv?x=1')).toBe('MKV');
  });

  it('measures the buffer ahead of the play position', () => {
    const ranges = { length: 2, start: (i: number) => [0, 30][i]!, end: (i: number) => [10, 50][i]! } as TimeRanges;
    expect(bufferAhead(ranges, 4)).toBe(6);
    expect(bufferAhead(ranges, 35)).toBe(15);
    expect(bufferAhead(ranges, 20)).toBe(0);
  });
});

describe('stats provider', () => {
  afterEach(() => useStreamInfoStore.setState({ open: false }));

  it('reads the registered provider and nothing after it unregisters', async () => {
    expect(await readStats()).toBeNull();
    const off = setStatsProvider(() => ({ engine: 'mpv', width: 640 }));
    expect(await readStats()).toEqual({ engine: 'mpv', width: 640 });
    off();
    expect(await readStats()).toBeNull();
  });

  it('returns null when the provider fails', async () => {
    const off = setStatsProvider(async () => {
      throw new Error('no session');
    });
    expect(await readStats()).toBeNull();
    off();
  });

  it('toggles the panel', () => {
    expect(toggleStreamInfo()).toBe(true);
    expect(useStreamInfoStore.getState().open).toBe(true);
    expect(toggleStreamInfo()).toBe(false);
  });

  it('closes when playback stops or turns to radio, so it cannot pop up on the next video', () => {
    const src = { url: 'http://h/1.m3u8', kind: 'hls' as const, title: 'A', isLive: true, isRadio: false };
    usePlayerStore.setState({ source: src, mode: 'inline' });
    toggleStreamInfo();
    usePlayerStore.setState({ source: { ...src, isRadio: true }, mode: 'radio' });
    expect(useStreamInfoStore.getState().open).toBe(false);
    usePlayerStore.setState({ source: src, mode: 'inline' });
    toggleStreamInfo();
    usePlayerStore.setState({ source: undefined });
    expect(useStreamInfoStore.getState().open).toBe(false);
  });
});
