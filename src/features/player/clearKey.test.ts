import { describe, expect, it, vi } from 'vitest';

import type { PlayerSource } from '@/api/types';

import { parseClearKey } from './clearKey';

const configured: Record<string, unknown>[] = [];

class FakeShakaPlayer {
  static isBrowserSupported = () => true;
  configure(cfg: Record<string, unknown>): void {
    configured.push(cfg);
  }
  getNetworkingEngine(): null {
    return null;
  }
  addEventListener(): void {}
  attach(): Promise<void> {
    return Promise.resolve();
  }
  load(): Promise<void> {
    return Promise.resolve();
  }
  setTextTrackVisibility(): Promise<void> {
    return Promise.resolve();
  }
  getVariantTracks(): unknown[] {
    return [];
  }
  getAudioLanguagesAndRoles(): unknown[] {
    return [];
  }
  getTextTracks(): unknown[] {
    return [];
  }
  destroy(): Promise<void> {
    return Promise.resolve();
  }
}

vi.mock('shaka-player', () => ({
  default: {
    polyfill: { installAll: () => undefined },
    Player: FakeShakaPlayer,
    net: { NetworkingEngine: { RequestType: { MANIFEST: 0, LICENSE: 2 } } },
    util: { Error: { Severity: { CRITICAL: 2 }, Category: { NETWORK: 1 } } },
  },
}));

const KID = '00112233445566778899aabbccddeeff';
const KEY = 'ffeeddccbbaa99887766554433221100';
// The same 16 bytes as base64url.
const KID_B64 = 'ABEiM0RVZneImaq7zN3u_w';
const KEY_B64 = '_-7dzLuqmYh3ZlVEMyIRAA';

describe('parseClearKey', () => {
  it('reads kid:key pairs, hex or base64url, several at once', () => {
    expect(parseClearKey(`${KID}:${KEY}`)).toEqual({ clearKeys: { [KID]: KEY } });
    expect(parseClearKey(`${KID.toUpperCase()}:${KEY}, ${KEY}:${KID}`)).toEqual({ clearKeys: { [KID]: KEY, [KEY]: KID } });
    expect(parseClearKey(`${KID_B64}:${KEY_B64}`)).toEqual({ clearKeys: { [KID]: KEY } });
    expect(parseClearKey('00112233-4455-6677-8899-aabbccddeeff:' + KEY)).toEqual({ clearKeys: { [KID]: KEY } });
  });

  it('reads a JSON key map and a JWK set', () => {
    expect(parseClearKey(JSON.stringify({ [KID]: KEY }))).toEqual({ clearKeys: { [KID]: KEY } });
    const jwks = { keys: [{ kty: 'oct', kid: KID_B64, k: KEY_B64 }], type: 'temporary' };
    expect(parseClearKey(JSON.stringify(jwks))).toEqual({ clearKeys: { [KID]: KEY } });
  });

  it('takes a licence URL as the server, without Kodi header parts', () => {
    expect(parseClearKey('https://lic.example/ck?id=1')).toEqual({ licenseServer: 'https://lic.example/ck?id=1' });
    expect(parseClearKey('https://lic.example/ck|User-Agent=x|R{SSM}|')).toEqual({ licenseServer: 'https://lic.example/ck' });
  });

  it('gives nothing for blank, malformed or short keys', () => {
    expect(parseClearKey(undefined)).toBeUndefined();
    expect(parseClearKey('  ')).toBeUndefined();
    expect(parseClearKey('{not json')).toBeUndefined();
    expect(parseClearKey('abcd:1234')).toBeUndefined();
    expect(parseClearKey(`${KID}`)).toBeUndefined();
  });
});

describe('shaka gets the keys', () => {
  it('configures drm.clearKeys or the ClearKey licence server for a DASH source', async () => {
    const { createEngine } = await import('./engines');
    const cb = { onTracks: vi.fn(), onError: vi.fn() };
    const source: PlayerSource = {
      url: 'http://h/a.mpd',
      kind: 'dash',
      title: 't',
      isLive: true,
      isRadio: false,
      drm: { clearKeys: { [KID]: KEY } },
    };
    await createEngine(document.createElement('video'), source, source.url, cb, { captions: false });
    expect(configured).toContainEqual({ drm: { clearKeys: { [KID]: KEY } } });

    configured.length = 0;
    const served = { ...source, drm: { licenseServer: 'https://lic.example/ck' } };
    await createEngine(document.createElement('video'), served, served.url, cb, { captions: false });
    expect(configured).toContainEqual({ drm: { servers: { 'org.w3.clearkey': 'https://lic.example/ck' } } });

    configured.length = 0;
    await createEngine(document.createElement('video'), { ...source, drm: undefined }, source.url, cb, { captions: false });
    expect(configured.some((c) => 'drm' in c)).toBe(false);
  });
});
