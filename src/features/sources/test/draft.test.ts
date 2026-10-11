import { describe, expect, it } from 'vitest';

import { buildAddArgs, buildUpdatePatch, emptyDraft, patchNeedsRefresh, type SourceDraft } from '../lib/draft';
import { addSourceHref, addSourcePathFromDeepLink } from '../lib/links';
import { checkHttpUrl, formatMacInput, hasInfomirOui, looksLikeFullPortal, normalizeMac, normalizeXtreamServer, parseXtreamLink } from '../lib/validate';
import { makeSource } from './harness';

const desktop = { isDesktop: true };
const web = { isDesktop: false };

function draft(kind: SourceDraft['kind'], edit: (d: SourceDraft) => void): SourceDraft {
  const d = emptyDraft(kind);
  d.name = 'My list';
  edit(d);
  return d;
}

describe('buildAddArgs produces the exact sources.add args', () => {
  it('m3u by url, without empty headers', () => {
    const r = buildAddArgs(draft('m3u', (d) => {
      d.autoRefresh = true;
      d.m3u.url = '  lists.example.com/tv.m3u ';
    }), web);
    expect(r).toEqual({
      ok: true,
      errors: {},
      value: { kind: 'm3u', name: 'My list', autoRefresh: true, m3u: { origin: 'url', url: 'http://lists.example.com/tv.m3u' } },
    });
  });

  it('m3u by url with headers', () => {
    const r = buildAddArgs(draft('m3u', (d) => {
      d.m3u.url = 'https://lists.example.com/tv.m3u';
      d.m3u.headers = { userAgent: 'VLC/3.0', referrer: 'https://example.com/page', origin: '' };
    }), web);
    expect(r.ok && r.value.m3u).toEqual({
      origin: 'url',
      url: 'https://lists.example.com/tv.m3u',
      headers: { userAgent: 'VLC/3.0', referrer: 'https://example.com/page' },
    });
  });

  it('m3u file on desktop sends the path', () => {
    const r = buildAddArgs(draft('m3u', (d) => {
      d.autoRefresh = true;
      d.m3u.origin = 'file';
      d.m3u.filePath = 'C:\\lists\\tv.m3u';
    }), desktop);
    expect(r.ok && r.value).toEqual({ kind: 'm3u', name: 'My list', autoRefresh: true, m3u: { origin: 'file', filePath: 'C:\\lists\\tv.m3u' } });
  });

  it('m3u file on web sends the text and turns auto refresh off', () => {
    const r = buildAddArgs(draft('m3u', (d) => {
      d.autoRefresh = true;
      d.m3u.origin = 'file';
      d.m3u.fileName = 'tv.m3u';
      d.m3u.fileText = '#EXTM3U\n#EXTINF:-1,One\nhttp://a/1';
    }), web);
    expect(r.ok && r.value).toEqual({
      kind: 'm3u',
      name: 'My list',
      autoRefresh: false,
      m3u: { origin: 'text', text: '#EXTM3U\n#EXTINF:-1,One\nhttp://a/1' },
    });
  });

  it('m3u pasted text', () => {
    const text = '#EXTM3U\n#EXTINF:-1,One\nhttp://a/1';
    const r = buildAddArgs(draft('m3u', (d) => {
      d.m3u.origin = 'text';
      d.m3u.text = text;
    }), desktop);
    expect(r.ok && r.value).toEqual({ kind: 'm3u', name: 'My list', autoRefresh: false, m3u: { origin: 'text', text } });
  });

  it('xtream normalizes the server and keeps the password untrimmed of inner content', () => {
    const r = buildAddArgs(draft('xtream', (d) => {
      d.xtream = { serverUrl: 'http://xt.example.com:8080/player_api.php?x=1', username: ' alice ', password: 'p@ss word' };
    }), web);
    expect(r.ok && r.value).toEqual({
      kind: 'xtream',
      name: 'My list',
      autoRefresh: false,
      xtream: { serverUrl: 'http://xt.example.com:8080', username: 'alice', password: 'p@ss word' },
    });
  });

  it('stalker with only required fields always sends headers {}', () => {
    const r = buildAddArgs(draft('stalker', (d) => {
      d.stalker.portalUrl = 'http://portal.example.com/c/';
      d.stalker.macAddress = '001a79aabbcc';
    }), web);
    expect(r.ok && r.value).toEqual({
      kind: 'stalker',
      name: 'My list',
      autoRefresh: false,
      stalker: { portalUrl: 'http://portal.example.com/c/', macAddress: '00:1A:79:AA:BB:CC', isFullPortal: false, headers: {} },
    });
  });

  it('stalker with optional identity fields includes only the filled ones', () => {
    const r = buildAddArgs(draft('stalker', (d) => {
      d.stalker.portalUrl = 'http://portal.example.com/stalker_portal/c/';
      d.stalker.macAddress = '00-1A-79-01-02-03';
      d.stalker.isFullPortal = true;
      d.stalker.username = 'bob';
      d.stalker.password = 'secret';
      d.stalker.serialNumber = 'SN123';
      d.stalker.headers = { userAgent: 'MAG250', referrer: '', origin: '' };
    }), web);
    expect(r.ok && r.value.stalker).toEqual({
      portalUrl: 'http://portal.example.com/stalker_portal/c/',
      macAddress: '00:1A:79:01:02:03',
      isFullPortal: true,
      headers: { userAgent: 'MAG250' },
      username: 'bob',
      password: 'secret',
      serialNumber: 'SN123',
    });
  });
});

describe('buildAddArgs validation', () => {
  it('requires a name and a url', () => {
    const d = emptyDraft('m3u');
    const r = buildAddArgs(d, web);
    expect(r.ok).toBe(false);
    expect(r.errors).toMatchObject({ name: 'errorRequired', 'm3u.url': 'errorRequired' });
  });

  it('rejects non-http schemes and over-long names', () => {
    const r = buildAddArgs(draft('m3u', (d) => {
      d.name = 'x'.repeat(121);
      d.m3u.url = 'ftp://example.com/a.m3u';
    }), web);
    expect(r.errors).toMatchObject({ name: 'errorNameTooLong', 'm3u.url': 'errorUrlScheme' });
  });

  it('rejects text that is not a playlist and a missing file', () => {
    expect(buildAddArgs(draft('m3u', (d) => {
      d.m3u.origin = 'text';
      d.m3u.text = 'hello world';
    }), web).errors).toEqual({ 'm3u.text': 'errorNotM3u' });
    expect(buildAddArgs(draft('m3u', (d) => {
      d.m3u.origin = 'file';
    }), desktop).errors).toEqual({ 'm3u.file': 'errorFileRequired' });
  });

  it('flags every missing xtream field', () => {
    expect(buildAddArgs(draft('xtream', () => undefined), web).errors).toEqual({
      'xtream.serverUrl': 'errorRequired',
      'xtream.username': 'errorRequired',
      'xtream.password': 'errorRequired',
    });
  });

  it('rejects a malformed MAC and a bad origin header', () => {
    const r = buildAddArgs(draft('stalker', (d) => {
      d.stalker.portalUrl = 'http://portal.example.com/c/';
      d.stalker.macAddress = '00:1A:79:ZZ';
      d.stalker.headers.origin = 'https://example.com/path';
    }), web);
    expect(r.errors).toEqual({ 'stalker.macAddress': 'errorMac', 'stalker.headers.origin': 'errorOrigin' });
  });
});

describe('buildUpdatePatch', () => {
  it('sends only what changed', () => {
    const src = makeSource('a', { name: 'Old', autoRefresh: false });
    const d = emptyDraft('m3u');
    d.name = 'New';
    d.m3u.url = 'http://lists.example.com/tv.m3u';
    const r = buildUpdatePatch(src, d, web);
    expect(r.ok && r.value).toEqual({ name: 'New' });
  });

  it('keeps a grandfathered malformed MAC', () => {
    const src = makeSource('b', {
      kind: 'stalker',
      m3u: undefined,
      stalker: { portalUrl: 'http://p.example.com/c/', macAddress: 'legacy-mac', isFullPortal: false, headers: {} },
    });
    const d = emptyDraft('stalker');
    d.name = src.name;
    d.stalker.portalUrl = 'http://p.example.com/c/';
    d.stalker.macAddress = 'legacy-mac';
    d.autoRefresh = src.autoRefresh;
    const r = buildUpdatePatch(src, d, web);
    expect(r.ok).toBe(true);
  });
});

describe('patchNeedsRefresh', () => {
  const url = makeSource('u', { m3u: { origin: 'url', url: 'http://a.example/x.m3u', headers: { userAgent: 'A/1' } } });
  const text = makeSource('t', { m3u: { origin: 'text', headers: {} } });

  it('is false for a header-only edit of a URL playlist', () => {
    expect(patchNeedsRefresh({ m3u: { origin: 'url', url: 'http://a.example/x.m3u', headers: { userAgent: 'B/2' } } }, url)).toBe(false);
  });
  it('is true when the playlist address changes', () => {
    expect(patchNeedsRefresh({ m3u: { origin: 'url', url: 'http://b.example/x.m3u', headers: { userAgent: 'A/1' } } }, url)).toBe(true);
  });
  it('is false for a pasted playlist, which cannot refresh', () => {
    expect(patchNeedsRefresh({ m3u: { origin: 'text', headers: { userAgent: 'EditedUA/2' } } }, text)).toBe(false);
    expect(patchNeedsRefresh({ m3u: { origin: 'text', headers: { userAgent: 'EditedUA/2' } } })).toBe(false);
  });
  it('is true for portal and Xtream config changes, false for name-only edits', () => {
    expect(patchNeedsRefresh({ xtream: { serverUrl: 'http://x', username: 'a', password: 'b' } })).toBe(true);
    expect(patchNeedsRefresh({ name: 'Renamed' }, url)).toBe(false);
  });
});

describe('validators', () => {
  it('normalizes and formats MACs', () => {
    expect(normalizeMac('001a79aabbcc')).toBe('00:1A:79:AA:BB:CC');
    expect(normalizeMac('00-1a-79-aa-bb-cc')).toBe('00:1A:79:AA:BB:CC');
    expect(normalizeMac('00:1A:79:AA:BB')).toBeNull();
    expect(formatMacInput('001a7')).toBe('00:1A:7');
    expect(formatMacInput('zz001a79aabbccdd')).toBe('00:1A:79:AA:BB:CC');
    expect(hasInfomirOui('00:1A:79:00:00:01')).toBe(true);
    expect(hasInfomirOui('AA:BB:CC:00:00:01')).toBe(false);
  });

  it('detects full portals', () => {
    expect(looksLikeFullPortal('http://x.example.com/stalker_portal/c/')).toBe(true);
    expect(looksLikeFullPortal('http://x.example.com/server/load.php')).toBe(true);
    expect(looksLikeFullPortal('http://x.example.com/c/')).toBe(false);
  });

  it('checks urls', () => {
    expect(checkHttpUrl('example.com/a')).toEqual({ ok: true, url: 'http://example.com/a' });
    expect(checkHttpUrl('')).toEqual({ ok: false, error: 'errorRequired' });
    expect(checkHttpUrl('http://')).toEqual({ ok: false, error: 'errorUrlInvalid' });
    expect(normalizeXtreamServer('https://xt.example.com/get.php?username=a')).toEqual({ ok: true, url: 'https://xt.example.com' });
  });

  it('parses xtream get.php links', () => {
    expect(parseXtreamLink('http://xt.example.com:8080/get.php?username=al&password=pw&type=m3u_plus')).toEqual({
      serverUrl: 'http://xt.example.com:8080',
      username: 'al',
      password: 'pw',
    });
    expect(parseXtreamLink('http://lists.example.com/tv.m3u')).toBeNull();
  });

  it('builds and reads add-source links', () => {
    expect(addSourceHref({ url: 'http://a.example.com/x.m3u', kind: 'm3u' })).toBe('/sources?add=http%3A%2F%2Fa.example.com%2Fx.m3u&kind=m3u');
    expect(addSourcePathFromDeepLink('iptv://add?url=http%3A%2F%2Fa.example.com%2Fx.m3u')).toBe('/sources?add=http%3A%2F%2Fa.example.com%2Fx.m3u');
    expect(addSourcePathFromDeepLink('iptv://add?url=file%3A%2F%2F%2Fetc%2Fpasswd')).toBeNull();
  });
});
