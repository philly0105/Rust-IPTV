/**
 * L4-vod-5: at 390 px the sort menu kept an 11rem minimum width and wrapped onto its own row,
 * right-aligned under Hide watched. Below sm the two share one row and the menu takes the rest.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import '@/i18n';

import { MyListToolbar } from '../components/MyListToolbar';

afterEach(() => cleanup());

const noop = () => {};

describe('MyListToolbar on phones (L4-vod-5)', () => {
  it('lets the sort menu fill the row beside Hide watched below sm, and keeps 11rem from sm', () => {
    render(
      <MyListToolbar
        filter="all"
        sort="order"
        hideWatched={false}
        counts={{ all: 2, movie: 1, series: 1 }}
        watchedCount={1}
        query=""
        onQuery={noop}
        onFilter={noop}
        onSort={noop}
        onHideWatched={noop}
      />,
    );
    const select = screen.getByTestId('mylist-sort');
    const cls = select.className.split(/\s+/);
    expect(cls).toContain('sm:min-w-[11rem]');
    expect(cls).not.toContain('min-w-[11rem]');
    const wrapper = select.parentElement!.className.split(/\s+/);
    expect(wrapper).toEqual(expect.arrayContaining(['ms-auto', 'min-w-0', 'flex-1', 'sm:flex-none']));
    expect(screen.getByRole('switch', { name: 'Hide watched' })).toBeTruthy();
  });
});
