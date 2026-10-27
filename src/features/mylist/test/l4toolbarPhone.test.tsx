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

  it('draws every control at the md height of the pill tabs and the view switch', () => {
    render(
      <MyListToolbar
        filter="all"
        sort="order"
        hideWatched={false}
        counts={{ all: 2, movie: 1, series: 1 }}
        watchedCount={0}
        query=""
        onQuery={noop}
        onFilter={noop}
        onSort={noop}
        onHideWatched={noop}
        onView={noop}
      />,
    );
    const classes = (el: Element) => el.className.split(/\s+/);
    // The field and the menu are h-10, as tall as a pill tab's track and the md segmented control.
    expect(classes(screen.getByTestId('mylist-search'))).toContain('h-10');
    expect(classes(screen.getByTestId('mylist-sort'))).toContain('h-10');
    expect(classes(screen.getByTestId('mylist-sort'))).not.toContain('h-9');
    // The view switch keeps the default (md) size: no compact track.
    const view = screen.getByRole('radiogroup', { name: 'View' });
    expect(classes(view)).not.toContain('p-0.5');
  });
});
