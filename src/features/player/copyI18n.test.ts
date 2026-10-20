/** PL-COPY-I18N: bitrates and unnamed tracks in the app's language. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlayerSource } from '@/api/types';
import { applyLanguage, i18n } from '@/i18n';

import { createEngine, formatBitrate, qualityLabels, type EngineTracks } from './engines';

afterEach(async () => {
  await applyLanguage('en');
});

describe('bitrates and track names follow the UI language', () => {
  it('formats bitrates with Intl units, megabits from 1 Mb/s', async () => {
    expect(formatBitrate(4_500_000)).toBe('4.5 Mb/s');
    expect(formatBitrate(640_000)).toBe('640 kb/s');
    expect(qualityLabels([{ bitrate: 800_000 }])).toEqual(['800 kb/s']);
    await i18n.changeLanguage('de');
    // German: a decimal comma.
    expect(formatBitrate(4_500_000)).toMatch(/^4,5\s/);
  });

  it('an unnamed track is "Subtitle 1" in the UI language, never the English fallback', async () => {
    const tracksIn = async (): Promise<string[]> => {
      const el = document.createElement('video');
      const unnamed = { kind: 'subtitles', label: '', language: '', mode: 'disabled' as TextTrackMode };
      Object.defineProperty(el, 'textTracks', { value: Object.assign([unnamed], { addEventListener() {}, removeEventListener() {} }) });
      const onTracks = vi.fn<(t: EngineTracks) => void>();
      const source: PlayerSource = { url: 'http://h/m.mp4', kind: 'direct', title: 'Movie', isLive: false, isRadio: false };
      const engine = await createEngine(el, source, source.url, { onTracks, onError: () => undefined }, { captions: false });
      el.dispatchEvent(new Event('loadedmetadata'));
      engine.destroy();
      return onTracks.mock.calls.at(-1)![0].text.map((x) => x.label);
    };
    expect(await tracksIn()).toEqual(['Subtitle 1']);
    await applyLanguage('de');
    expect(await tracksIn()).toEqual(['Untertitel 1']);
  });
});
