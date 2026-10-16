// The core's title_base (crates/iptv-core/src/catalog/title.rs), ported for saved snapshot titles.
// The first three groups are the Rust tests' cases, one for one.
import { describe, expect, it } from 'vitest';

import { baseTitle, snapshotTitle } from './title';

const tb = (s: string) => {
  const r = baseTitle(s);
  return [r.title, r.year] as const;
};

describe('baseTitle (core title_base)', () => {
  it('strips years and tags', () => {
    expect(tb('The Matrix (1999)')).toEqual(['The Matrix', 1999]);
    expect(tb('The Matrix [4K] (1999)')).toEqual(['The Matrix', 1999]);
    expect(tb('The Matrix - 1999')).toEqual(['The Matrix', 1999]);
    expect(tb('Dune Part Two (2024) [MULTI-SUB] FHD')).toEqual(['Dune Part Two', 2024]);
    expect(tb('Inception 1080p HEVC')).toEqual(['Inception', undefined]);
    expect(tb('Heat (VOSTFR) (1995)')).toEqual(['Heat', 1995]);
  });

  it('strips language prefixes', () => {
    expect(tb('EN - The Matrix (1999)')).toEqual(['The Matrix', 1999]);
    expect(tb('|EN| The Matrix')).toEqual(['The Matrix', undefined]);
    expect(tb('[FR] Amélie (2001)')).toEqual(['Amélie', 2001]);
    expect(tb('EN: Up (2009)')).toEqual(['Up', 2009]);
    expect(tb('4K-EN - Oppenheimer (2023)')).toEqual(['Oppenheimer', 2023]);
  });

  it('keeps meaningful titles', () => {
    expect(tb('CSI: Miami')[0]).toBe('CSI: Miami');
    expect(tb('24: Legacy')[0]).toBe('24: Legacy');
    expect(tb('Blade Runner 2049')).toEqual(['Blade Runner 2049', undefined]);
    expect(tb('1917 (2019)')).toEqual(['1917', 2019]);
    expect(tb('HD')).toEqual(['HD', undefined]);
    expect(tb('  ')).toEqual(['', undefined]);
    expect(tb('Movie (3000)')[1]).toBeUndefined();
    expect(tb('Movie (3000)')[0]).toBe('Movie (3000)');
  });

  it.each([
    ['US The Paper Astronaut (2026)', 'US The Paper Astronaut', 2026],
    ['|EN| 4K - Night Train [MULTI-SUB] (2019)', 'Night Train', 2019],
    ['EN: Quiet Coast - 2021', 'Quiet Coast', 2021],
    ['FR - Le Signal FHD', 'Le Signal', undefined],
    ['[DE] Der Hafen (HEVC)', 'Der Hafen', undefined],
    ['(2019)', '(2019)', 2019],
  ])('provider title %s', (raw, title, year) => {
    expect(baseTitle(raw)).toEqual(year === undefined ? { title } : { title, year });
  });
});

describe('snapshotTitle', () => {
  it('cleans movie and series titles and leaves channel names alone', () => {
    expect(snapshotTitle({ contentType: 'movie' }, 'EN - The Matrix (1999) [4K]')).toEqual({ title: 'The Matrix', year: 1999 });
    expect(snapshotTitle({ contentType: 'series' }, '|FR| Le Bureau FHD')).toEqual({ title: 'Le Bureau' });
    expect(snapshotTitle({ contentType: 'live' }, 'US: News HD')).toEqual({ title: 'US: News HD' });
    expect(snapshotTitle({ contentType: 'radio' }, 'EN - Jazz (1999)')).toEqual({ title: 'EN - Jazz (1999)' });
  });
});
