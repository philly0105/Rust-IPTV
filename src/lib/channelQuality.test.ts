import { describe, expect, it } from 'vitest';

import { channelQuality, qualityOrder } from './channelQuality';

describe('channelQuality', () => {
  // The core's cases (crates/iptv-core/src/live/matcher.rs, quality_is_the_signature_quality).
  it('reads the quality the core reads', () => {
    for (const [name, want] of [
      ['UK: Sky Sports 1 FHD', 'fhd'],
      ['4K | Sky Cinema', 'uhd'],
      ['4K-DE - Das Erste', 'uhd'],
      ['[DE-4K] Das Erste', 'uhd'],
      ['UK HD | Sky', 'hd'],
      ['FULL HD | Sky', 'fhd'],
      ['BBC One HD 4K', 'uhd'],
      ['Channel 5 SD', 'sd'],
      ['Das Erste 1080p', 'fhd'],
      ['ZDF HD +', 'hd'],
      ['BBC One Full HD', 'fhd'],
      ['Sky Sports FULL HD+', 'fhd'],
      ['Sky Cinema Ultra HD', 'uhd'],
      ['Full Moon HD', 'hd'],
      ['Full HD', 'fhd'],
      ['ITV 720', 'hd'],
      ['Télé ꜰʜᴅ', 'fhd'],
      ['Sky Sports 1 H.265', null],
      ['Film4 +1', null],
      ['BBC One', null],
      ['', null],
    ] as const) {
      expect(channelQuality(name), name).toBe(want);
    }
  });

  it("reads a real provider's superscript markers, and no others", () => {
    expect(channelQuality('NBA: BOSTON CELTICS ᴴᴰ')).toBe('hd');
    expect(channelQuality('4K: ESPN ᵁᴴᴰ ³⁸⁴⁰ᴾ')).toBe('uhd');
    expect(channelQuality('NF: NETFLIX 01 (FHD@30FPS) EVENTS ONLY')).toBe('fhd');
    expect(channelQuality('NBA: BOSTON CELTICS SD')).toBe('sd');
    // RAW, 60 fps and a superscript "8K" name no picture size.
    expect(channelQuality('US: NBC 4 (WNBC) NEW YORK (A) ᴿᴬᵂ')).toBeNull();
    expect(channelQuality('UK: SKY SPORT MAIN EVENT ⁸ᴷ ⁶⁰ᶠᵖˢ')).toBeNull();
  });

  it('reads no quality in the "8K EXCLUSIVE" brand of a provider\'s event channels', () => {
    expect(channelQuality('NEXT | BOS - CELTICS VS BKN - NETS | Tue 27 Oct 18:30 EDT (US) | 8K EXCLUSIVE | US: NBA PASS PPV 1')).toBeNull();
    expect(channelQuality('NO EVENT STREAMING NOW - | 8K EXCLUSIVE | US: DAZN PPV 1')).toBeNull();
    expect(channelQuality('Sky 8K EXCLUSIVE HD')).toBe('hd');
    // 8K anywhere else is still 4K or better.
    expect(channelQuality('Sky 8K')).toBe('uhd');
    expect(channelQuality('Sky 8K Demo')).toBe('uhd');
    expect(channelQuality('8K | Sky')).toBe('uhd');
  });

  it('orders the qualities', () => {
    expect([qualityOrder('sd'), qualityOrder('hd'), qualityOrder('fhd'), qualityOrder('uhd')]).toEqual([1, 2, 3, 4]);
  });
});
