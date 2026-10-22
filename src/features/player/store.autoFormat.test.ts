import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, type ItemRef, type Settings } from '@/api/types';

const env = vi.hoisted(() => ({ desktop: true }));
const calls: Array<[string, unknown]> = [];

vi.mock('@/api/transport', () => ({
  rpc: async (name: string, args?: unknown) => {
    calls.push([name, args]);
    if (name !== 'xtream.streamUrl') throw new Error(`unmocked rpc ${name}`);
    return { url: 'http://x/live/u/p/1.ts', kind: 'direct', title: 'One', isLive: true, isRadio: false };
  },
  get isDesktop() {
    return env.desktop;
  },
  proxiedUrl: (s: { url: string }) => s.url,
}));

const { resolveSource, setSettingsCache, __resetPlayerForTests } = await import('./store');

const live: ItemRef = { sourceId: 's1', contentType: 'live', itemId: '1' };
const args = { ref: live, title: 'One', isLive: true, sourceKind: 'xtream' } as const;

class FakeMediaSource {
  static isTypeSupported = (): boolean => true;
}

/** The arguments the last `xtream.streamUrl` went out with. */
async function asked(settings: Partial<Settings>, a: Parameters<typeof resolveSource>[0] = args): Promise<unknown> {
  setSettingsCache({ ...DEFAULT_SETTINGS, ...settings });
  await resolveSource(a);
  return calls.filter(([n]) => n === 'xtream.streamUrl').at(-1)?.[1];
}

beforeEach(() => {
  __resetPlayerForTests();
  calls.length = 0;
  env.desktop = true;
  vi.stubGlobal('MediaSource', FakeMediaSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamFormat 'auto' (PL-1)", () => {
  it('asks for TS for the built-in player where MSE plays it', async () => {
    expect(DEFAULT_SETTINGS.streamFormat).toBe('auto');
    expect(await asked({})).toEqual({ ref: live, autoFormat: 'ts' });
    // Radio plays in the built-in player too.
    expect(await asked({}, { ...args, ref: { ...live, contentType: 'radio' }, isRadio: true })).toMatchObject({ autoFormat: 'ts' });
  });

  it('leaves mpv, VLC and embedded mpv on HLS in the desktop app', async () => {
    for (const player of ['mpv', 'vlc', 'embedded-mpv'] as const) {
      expect(await asked({ player })).toEqual({ ref: live });
    }
  });

  it('in the browser, where mpv and VLC fall back to the built-in player, asks for TS', async () => {
    env.desktop = false;
    for (const player of ['mpv', 'vlc', 'embedded-mpv'] as const) {
      expect(await asked({ player })).toEqual({ ref: live, autoFormat: 'ts' });
    }
  });

  it('without W3C MSE (iPhone Safari has only ManagedMediaSource) stays on HLS', async () => {
    vi.stubGlobal('MediaSource', undefined);
    vi.stubGlobal('ManagedMediaSource', FakeMediaSource);
    expect(await asked({})).toEqual({ ref: live });
    vi.stubGlobal('MediaSource', class {
      static isTypeSupported = (): boolean => false;
    });
    expect(await asked({})).toEqual({ ref: live });
  });

  it('sends nothing for a picked format or a movie', async () => {
    expect(await asked({ streamFormat: 'm3u8' })).toEqual({ ref: live });
    expect(await asked({ streamFormat: 'ts' })).toEqual({ ref: live });
    const movie: ItemRef = { sourceId: 's1', contentType: 'movie', itemId: '9' };
    expect(await asked({}, { ...args, ref: movie, isLive: false })).toEqual({ ref: movie });
  });
});
