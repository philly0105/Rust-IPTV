import { describe, expect, it, vi } from 'vitest';

import type { PlayerSource, SourceKind } from '@/api/types';

vi.mock('@/api/transport', () => ({
  rpc: vi.fn(() => Promise.reject(new Error('offline'))),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));

const { canShareSource, isShareableUrl } = await import('./shareable');

describe('isShareableUrl', () => {
  it.each([
    // Xtream short form without an extension (panel get.php exports), and with other extensions.
    'http://iptv.example.com:8080/demo/secret/12345',
    'http://iptv.example.com:8080/demo/secret/12345.mkv',
    'http://iptv.example.com:8080/demo/secret/12345.mp4',
    'http://iptv.example.com:8080/demo/secret/12345.ts',
    'http://h/play/demo/secret/12345.ts',
    'http://xt.example.com/live/demo/secret/1234.m3u8',
    'http://xt.example.com/timeshift/demo/secret/60/2026-10-11:20-00/5.ts',
    'http://xt.example.com/demo/secret/12345/index.m3u8',
    // Login parameters, short, odd or percent-encoded names.
    'http://h/live.m3u8?u=demo&p=secret',
    'http://h/live.m3u8?pw=secret',
    'http://h/live.m3u8?%70assword=secret',
    'http://h/get.php?username=demo&password=secret&type=m3u_plus',
    'http://h/hls/a.m3u8?token=x',
    'http://h/hls/a.m3u8?anything=x',
    'http://portal.example.com/play/live.php?mac=00:1A:79:00:00:01&stream=5&play_token=abc',
    'http://portal.example.com/00:1A:79:00:00:01/a.ts',
    // Userinfo, fragments, signed segments, other schemes.
    'https://bob:pw@cdn.example.com/a.m3u8',
    'https://token@cdn.example.com/a.m3u8',
    'http://cdn.example.com/a.m3u8#token=x',
    'https://cdn.example.com/s/eyJhbGciOiJIUzI1NiJ9abc123def456/index.m3u8',
    // Round 2: credentials in other path shapes.
    'http://h/hls/user/secretpass/channel.m3u8',
    'http://h/user/secretpass/channel.m3u8',
    'http://h/x;jsessionid=abc.m3u8',
    'http://h/auth/user:pass/stream.m3u8',
    'http://h/token=abcd1234/stream.m3u8',
    'http://h/u%2Fp%2F123.ts',
    'http://h/live/u%2Fp%2F123',
    'http://h/001A79000001/stream.ts',
    'http://h/play/001a79000001.ts',
    'http://h/play/dXNlcjpwYXNz.m3u8',
    'http://h/dXNlckBob3N0LmNvbQ/a.ts',
    'http://h/bob@pw/a.m3u8',
    // Round 3: the public-CDN exemptions do not reopen login shapes.
    'http://h/live/demo/secret/1080p/index.m3u8',
    'http://h/hls/live/demo/secret/12345.ts',
    'http://h/hls/live/12345/secret/678.ts',
    'http://h/live/2000341/secret/12345.ts',
    'http://h/a8F3k2x9Qz7Lm0pR4sT6vW8yB1/index.m3u8',
    'http://h/a8F3k2-x9Qz7L_m0pR4sT6vW/index.m3u8',
    'http://h/live/index.m3u8?checkedby=iptvcat&token=x',
    'rtmp://h/live/stream',
    'file:///C:/videos/a.mkv',
    'not a url',
    '',
  ])('denies %s', (url) => {
    expect(isShareableUrl(url)).toBe(false);
  });

  it.each([
    'http://cdn.example.com/live/news/index.m3u8',
    'https://example.com/movies/big-buck-bunny.mp4',
    'http://h/live.m3u8?format=hls&quality=hd',
    'http://h/movie/1.mkv',
    'https://cdn.example.com/hls/news/index.m3u8',
    'https://cdn.example.com/channels/arte/playlist.m3u8',
    // Round 3: public CDN and test-stream links (R3 review).
    'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8',
    'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    'https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8',
    'https://moiptvhls-i.akamaihd.net/hls/live/652313/secure/master.m3u8',
    'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8',
    'https://dai2.xumo.com/amagi_hls_data_xumo1212A-redboxrakuten/CDN/playlist.m3u8',
    'https://abcnews-streams.akamaized.net/hls/live/2023560/abcnews1/master.m3u8',
    'https://d2e1asnsl7br7b.cloudfront.net/7782e205e72f43aeb4a48ec97f66ebbe/index_5.m3u8',
    'https://example.com/streams/bbc-one/1080p/index.m3u8',
    'https://example.com/live/index.m3u8?checkedby=iptvcat',
  ])('allows the plain link %s', (url) => {
    expect(isShareableUrl(url)).toBe(true);
  });
});

describe('canShareSource', () => {
  const src = (url: string, sourceId?: string): PlayerSource => ({
    url,
    kind: 'hls',
    title: 'X',
    isLive: true,
    isRadio: false,
    ...(sourceId ? { ref: { sourceId, contentType: 'live' as const, itemId: '1' } } : {}),
  });
  const kinds: Record<string, SourceKind> = { m: 'm3u', x: 'xtream', s: 'stalker' };
  const kindOf = (id: string): SourceKind | undefined => kinds[id];

  it('only M3U items and loose links, and only when the link itself is clean', () => {
    expect(canShareSource(src('http://cdn.example.com/a.m3u8', 'm'), kindOf)).toBe(true);
    expect(canShareSource(src('http://cdn.example.com/a.m3u8'), kindOf)).toBe(true);
    expect(canShareSource(src('http://cdn.example.com/a.m3u8', 'x'), kindOf)).toBe(false);
    expect(canShareSource(src('http://cdn.example.com/a.m3u8', 's'), kindOf)).toBe(false);
    expect(canShareSource(src('http://cdn.example.com/a.m3u8', 'unknown'), kindOf)).toBe(false);
    // An M3U playlist can still list an Xtream login link.
    expect(canShareSource(src('http://iptv.example.com:8080/demo/secret/12345', 'm'), kindOf)).toBe(false);
  });

  it('defaults to the kinds this session has looked up (none here)', () => {
    expect(canShareSource(src('http://cdn.example.com/a.m3u8', 'm'))).toBe(false);
    expect(canShareSource(src('http://cdn.example.com/a.m3u8'))).toBe(true);
  });
});
