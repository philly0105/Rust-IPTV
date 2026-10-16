import { describe, expect, it } from 'vitest';

import { classifyStreamError, errorCopyKeys, httpStatusOf, NO_VIDEO_MESSAGE, rpcErrorCode, type StreamErrorClass } from './errors';

import en from '@/i18n/en/player.json';

describe('classifyStreamError', () => {
  const cases: [string, Parameters<typeof classifyStreamError>[0], StreamErrorClass][] = [
    ['offline wins over everything', { message: 'HTTP 404', code: 'auth', online: false }, 'offline'],
    ['rpc auth code', { message: 'login failed', code: 'auth' }, 'auth'],
    ['rpc not_found code', { message: 'whatever', code: 'not_found' }, 'notFound'],
    ['rpc timeout code', { code: 'timeout' }, 'timeout'],
    ['rpc unsupported code', { code: 'unsupported' }, 'unsupported'],
    ['hls.js 401', { message: 'HTTP 401 on the playlist', kind: 'network' }, 'auth'],
    ['403 forbidden', { message: 'HTTP 403', kind: 'network' }, 'auth'],
    ['404', { message: 'HTTP 404', kind: 'network' }, 'notFound'],
    ['410', { message: 'HTTP error 410' }, 'notFound'],
    ['504 is a timeout', { message: 'HTTP 504' }, 'timeout'],
    ['other 5xx is the server', { message: 'HTTP 502' }, 'server'],
    ['status phrase without HTTP', { message: '503 Service Unavailable' }, 'server'],
    ['mpv crash', { message: 'mpv stopped unexpectedly (exit code 3). Start playback again to restart it.' }, 'crashed'],
    ['mpv pipe lost', { message: 'Lost the connection to mpv.' }, 'crashed'],
    ['timeout phrase', { message: 'request timed out', kind: 'network' }, 'timeout'],
    ['mpv bad format', { message: 'mpv could not play this stream (unrecognized file format).' }, 'unsupported'],
    ['codec phrase', { message: 'Unsupported codec hevc' }, 'unsupported'],
    ['engine kind unsupported', { message: 'MEDIA_ERR', kind: 'unsupported' }, 'unsupported'],
    ['dns failure', { message: 'net::ERR_NAME_NOT_RESOLVED' }, 'offline'],
    ['engine network', { message: 'fragLoadError', kind: 'network' }, 'network'],
    ['engine media', { message: 'bufferAppendError', kind: 'media' }, 'media'],
    ['nothing known', { message: 'something odd' }, 'generic'],
    ['no message at all', {}, 'generic'],
    ['rpc engine_missing code', { message: 'not found', code: 'engine_missing' }, 'engineMissing'],
    ['missing mpv.exe before the core sends engine_missing', { message: 'mpv.exe was not found', code: 'not_found' }, 'engineMissing'],
    ['missing mpv wins over offline', { message: 'mpv.exe was not found', online: false }, 'engineMissing'],
    ['a stream mpv could not find is still a missing stream', { message: 'mpv: the stream was not found (HTTP 404)' }, 'notFound'],
    ['rpc server code', { message: 'upstream', code: 'server' }, 'server'],
  ];
  it.each(cases)('%s', (_name, input, expected) => {
    expect(classifyStreamError(input)).toBe(expected);
  });

  it('online true or unknown never means offline', () => {
    expect(classifyStreamError({ message: 'HTTP 404', online: true })).toBe('notFound');
    expect(classifyStreamError({ message: 'HTTP 404', online: undefined })).toBe('notFound');
  });
});

describe('helpers', () => {
  it('reads HTTP statuses only where written as statuses', () => {
    expect(httpStatusOf('HTTP 403 Forbidden')).toBe(403);
    expect(httpStatusOf('HTTP/1.1 500')).toBe(500);
    expect(httpStatusOf('channel 404 news')).toBeUndefined();
    expect(httpStatusOf(undefined)).toBeUndefined();
  });

  it('reads the RPC code from rejected calls, ignoring unknown codes', () => {
    expect(rpcErrorCode(Object.assign(new Error('x'), { code: 'auth' }))).toBe('auth');
    expect(rpcErrorCode({ code: 'nope' })).toBeUndefined();
    expect(rpcErrorCode(new Error('x'))).toBeUndefined();
    expect(rpcErrorCode(null)).toBeUndefined();
  });

  it('every class has copy in English', () => {
    const all: StreamErrorClass[] = ['engineMissing', 'offline', 'auth', 'notFound', 'timeout', 'server', 'unsupported', 'network', 'media', 'crashed', 'generic'];
    const strings: Record<string, string> = en;
    for (const cls of all) {
      const { title, hint } = errorCopyKeys(cls);
      expect(strings[title], `${cls} title`).toBeTruthy();
      expect(strings[hint], `${cls} hint`).toBeTruthy();
    }
  });
});

describe('parental refusal', () => {
  // The core refuses an item Hide mode hides as not_found (parental::refuse_hidden).
  const message = 'catalog item 666 is locked by parental controls; unlock them to open it';

  it('reads as locked, not as a stream that no longer exists', () => {
    expect(classifyStreamError({ message, code: 'not_found' })).toBe('notFound');
    expect(errorCopyKeys('notFound', { message })).toEqual({ title: 'parentalHiddenTitle', hint: 'parentalHidden' });
    expect(errorCopyKeys('notFound', { message: 'HTTP 404' })).toEqual({ title: 'errorNotFoundTitle', hint: 'errorNotFound' });
    const strings = en as Record<string, string>;
    expect(strings.parentalHiddenTitle).toBeTruthy();
    expect(strings.parentalHidden).toBeTruthy();
  });
});

describe('plain copy for what the provider said (L2-player-13)', () => {
  it('a live channel the provider does not have, a busy provider, a stream with no video', () => {
    expect(errorCopyKeys('notFound', { message: 'HTTP 404', live: true })).toEqual({
      title: 'errorChannelUnavailableTitle',
      hint: 'errorChannelUnavailable',
    });
    expect(errorCopyKeys('notFound', { message: 'HTTP 404', live: false })).toEqual({ title: 'errorNotFoundTitle', hint: 'errorNotFound' });
    expect(errorCopyKeys('server', { message: 'HttpStatusCodeInvalid (HTTP 503)' })).toEqual({ title: 'errorBusyTitle', hint: 'errorBusy' });
    expect(errorCopyKeys('server', { message: 'HTTP 500' })).toEqual({ title: 'errorServerTitle', hint: 'errorServer' });
    expect(errorCopyKeys('unsupported', { message: NO_VIDEO_MESSAGE })).toEqual({ title: 'errorNoVideoTitle', hint: 'errorNoVideo' });
    const strings = en as Record<string, string>;
    for (const key of ['errorChannelUnavailableTitle', 'errorChannelUnavailable', 'errorBusyTitle', 'errorBusy', 'errorNoVideoTitle', 'errorNoVideo']) {
      expect(strings[key]).toBeTruthy();
    }
  });
});
