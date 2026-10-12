/**
 * B4-vod review round 2.
 * D16: the cast chip row scrolls sideways; with no linked chip it must be
 * focusable and named itself (axe scrollable-region-focusable).
 * D17: the poster caption joins year and language with the locale's list
 * separator, not a hard-coded middle dot.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Person } from '@/api/types';
import { joinList } from '@/shell/dashboard/cards';

import { CastRow } from '../components/detail/CastRow';
import { PosterCard } from '../components/PosterCard';
import { PosterRail } from '../components/PosterRail';
import { i18n, installDomStubs } from './harness';

beforeAll(installDomStubs);
afterEach(cleanup);

const people = (withIds: boolean): Person[] =>
  ['Amy Adams', 'Jeremy Renner', 'Forest Whitaker'].map((name, i) => (withIds ? { id: i + 1, name } : { name }));

describe('B4-vod-D16: horizontally scrolling VOD rows are keyboard reachable', () => {
  it('a cast row with no linked chip is a focusable, named list with a focus ring', () => {
    render(<MemoryRouter><CastRow cast={people(false)} sourceId="src1" /></MemoryRouter>);
    const row = screen.getByRole('list', { name: 'Cast' });
    expect(row.tabIndex).toBe(0);
    expect(row.className).toContain('focus-visible:ring-2');
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('with linked chips the links take focus, so the row adds no extra tab stop', () => {
    render(<MemoryRouter><CastRow cast={people(true)} sourceId="src1" /></MemoryRouter>);
    const row = screen.getByRole('list', { name: 'Cast' });
    expect(row.hasAttribute('tabindex')).toBe(false);
    expect(screen.getAllByRole('link')).toHaveLength(3);
  });

  it('a loading poster rail (skeletons only, nothing to focus) clips instead of scrolling', () => {
    const { rerender } = render(<MemoryRouter><PosterRail title="Movies" items={[]} render={() => null} loading /></MemoryRouter>);
    const loadingRow = screen.getByRole('list');
    expect(loadingRow.className).toContain('overflow-x-hidden');
    expect(loadingRow.className).not.toContain('overflow-x-auto');
    rerender(
      <MemoryRouter>
        <PosterRail title="Movies" items={['a']} render={() => <a href="/a">A</a>} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('list').className).toContain('overflow-x-auto');
  });
});

describe('B4-vod-D17: poster caption uses the locale list separator', () => {
  it('joins year and language with joinList, no middle dot', () => {
    render(<MemoryRouter><PosterCard title="Arrival" href="/a" year={2016} language={{ code: 'EN', tag: 'en' }} /></MemoryRouter>);
    const lang = new Intl.DisplayNames([i18n.language], { type: 'language' }).of('en')!;
    const caption = screen.getByText(joinList(['2016', lang], i18n.language));
    expect(caption.textContent).not.toContain('·');
  });
});
