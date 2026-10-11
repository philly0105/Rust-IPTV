import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Channel, ItemRef, Source } from '@/api/types';

import { PosterCard, posterCardLabel } from '../components/PosterCard';
import { targetIndex } from '../lib/gridNav';
import { capSearchResult, groupSearchResults, sourceFacets, type SourceSearch } from '../lib/search';
import { installDomStubs } from './harness';

beforeAll(installDomStubs);
afterEach(cleanup);

describe('R6-r3 F3: grid arrows follow the screen in RTL', () => {
  it('moves forward on ArrowRight in LTR and on ArrowLeft in RTL', () => {
    expect(targetIndex('ArrowRight', 2, 5, 12)).toBe(3);
    expect(targetIndex('ArrowLeft', 2, 5, 12)).toBe(1);
    expect(targetIndex('ArrowRight', 2, 5, 12, 3, true)).toBe(1);
    expect(targetIndex('ArrowLeft', 2, 5, 12, 3, true)).toBe(3);
  });

  it('clamps at the row ends and leaves vertical keys alone in RTL', () => {
    expect(targetIndex('ArrowRight', 0, 5, 12, 3, true)).toBeNull();
    expect(targetIndex('ArrowLeft', 11, 5, 12, 3, true)).toBeNull();
    expect(targetIndex('ArrowDown', 3, 5, 12, 3, true)).toBe(8);
    expect(targetIndex('Home', 4, 5, 12, 3, true)).toBe(0);
  });
});

const sources = [
  { id: 'big', name: 'Big 50k', kind: 'm3u' },
  { id: 'stb', name: 'Mock Stalker', kind: 'stalker' },
  { id: 'xt', name: 'Mock Xtream', kind: 'xtream' },
] as Source[];

const channel = (sourceId: string, i: number): Channel =>
  ({ ref: { sourceId, contentType: 'live', itemId: `${sourceId}-${i}` } as ItemRef, name: `News ${sourceId} ${i}` }) as Channel;

const channels = (sourceId: string, n: number) => Array.from({ length: n }, (_, i) => channel(sourceId, i));

/** What a source's own facet search returns, capped like the facet view. */
function own(sourceId: string, n: number): SourceSearch {
  const capped = capSearchResult({ live: channels(sourceId, n), movies: [], series: [] }, 60);
  return { groups: groupSearchResults({ result: capped.result!, sources, sourceFilter: sourceId }), more: capped.more };
}

describe('R6-r3 F8: facet chips read "+" only where the count is a lower bound', () => {
  // Global search at the 60 cap: Big 50k floods the list, the others keep 2 and 1 rows of it.
  const global = capSearchResult({ live: [...channels('big', 57), ...channels('stb', 2), ...channels('xt', 2)], movies: [], series: [] }, 60);
  const groups = groupSearchResults({ result: global.result!, sources });

  it('without per-source counts, every source in the capped type is partial (the old lower bound)', () => {
    const chips = sourceFacets(groups, global.more);
    expect(global.more.live).toBe(true);
    expect(chips.every((c) => c.partial)).toBe(true);
  });

  it('with per-source searches, small sources are exact and only the flooded one keeps "+"', () => {
    const perSource = new Map([
      ['big', own('big', 989)],
      ['stb', own('stb', 4)],
      ['xt', own('xt', 4)],
    ]);
    const chips = sourceFacets(groups, global.more, perSource);
    expect(chips).toEqual([
      { sourceId: 'big', sourceName: 'Big 50k', count: 60, partial: true },
      { sourceId: 'stb', sourceName: 'Mock Stalker', count: 4, partial: false },
      { sourceId: 'xt', sourceName: 'Mock Xtream', count: 4, partial: false },
    ]);
  });

  it('adds a chip for a source cut out of the global list entirely and drops one with no hits', () => {
    const onlyBig = capSearchResult({ live: channels('big', 61), movies: [], series: [] }, 60);
    const perSource = new Map([
      ['big', own('big', 989)],
      ['stb', own('stb', 3)],
      ['xt', own('xt', 0)],
    ]);
    const chips = sourceFacets(groupSearchResults({ result: onlyBig.result!, sources }), onlyBig.more, perSource);
    expect(chips.map((c) => [c.sourceName, c.count, c.partial])).toEqual([
      ['Big 50k', 60, true],
      ['Mock Stalker', 3, false],
    ]);
  });

  it('keeps the larger global share for a capped source after "Show more"', () => {
    const wide = capSearchResult({ live: [...channels('big', 995), ...channels('stb', 4), ...channels('xt', 2)], movies: [], series: [] }, 1000, 1001);
    const chips = sourceFacets(groupSearchResults({ result: wide.result!, sources }), wide.more, new Map([['big', own('big', 989)]]));
    expect(chips[0]).toEqual({ sourceId: 'big', sourceName: 'Big 50k', count: 995, partial: true });
  });

  it('ignores per-source counts when no type hit its cap (the global counts are exact)', () => {
    const small = capSearchResult({ live: [...channels('stb', 4), ...channels('xt', 2)], movies: [], series: [] }, 60);
    const chips = sourceFacets(groupSearchResults({ result: small.result!, sources }), small.more, new Map([['stb', own('stb', 9)]]));
    expect(chips.map((c) => [c.sourceName, c.count, c.partial])).toEqual([
      ['Mock Stalker', 4, false],
      ['Mock Xtream', 2, false],
    ]);
  });
});

describe('R6-r3 F12: poster card accessible name', () => {
  const rated = (r: string) => `rated ${r} of 10`;

  it('names the title once, the year once and the rating as a sentence', () => {
    expect(posterCardLabel({ title: 'Black Harbor (2026)', year: 2026, rating: '8.2', ratedLabel: rated })).toBe('Black Harbor (2026), rated 8.2 of 10');
    expect(posterCardLabel({ title: 'Black Harbor', year: 2026, meta: '2026', ratedLabel: rated })).toBe('Black Harbor (2026)');
    expect(posterCardLabel({ title: 'Arrival', meta: 'Mock Xtream', badgeLabel: 'Big 50k', ratedLabel: rated })).toBe('Arrival, Mock Xtream, Big 50k');
  });

  it('renders the composed label on the link, hides the rating badge, and keeps the full-title tooltip', () => {
    render(
      <MemoryRouter>
        <PosterCard title="Black Harbor" fullTitle="Black Harbor (2026)" year={2026} rating={8.2} href="/m/1" />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('aria-label')).toBe('Black Harbor (2026), rated 8.2 of 10');
    expect(link.getAttribute('title')).toBe('Black Harbor (2026)');
    const badge = screen.getByText('8.2').closest('div')!;
    expect(badge.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('Black Harbor').getAttribute('dir')).toBe('auto');
  });
});
