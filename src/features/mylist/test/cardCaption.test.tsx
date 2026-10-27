/**
 * My List's grid captions its posters as the VOD grids and rails do: the title gets two lines
 * before it is cut, and the row height the grid reserves holds both and the line of facts, so a
 * narrow phone column shows "The Clubhouse" rather than "The Clubh…".
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import '@/i18n';
import type { WatchlistEntry } from '@/api/types';

import { CARD_CAPTION_HEIGHT, MyListCard } from '../components/MyListCard';

afterEach(() => cleanup());

const entry: WatchlistEntry = {
  ref: { sourceId: 's1', contentType: 'series', itemId: 'x1' },
  snapshot: { title: 'The Clubhouse', contentType: 'series' },
  addedAt: '2026-10-01T00:00:00Z',
  watched: false,
} as WatchlistEntry;

describe('My List card captions', () => {
  it('lets the title take two lines, with the whole title as a tooltip', () => {
    render(<MyListCard entry={entry} busy={false} onRemove={() => {}} />);
    const title = screen.getByTestId('mylist-title');
    const cls = title.className.split(/\s+/);
    expect(cls).toContain('line-clamp-2');
    expect(cls).not.toContain('truncate');
    expect(title.getAttribute('title')).toBe('The Clubhouse');
    // The facts line stays one line under it.
    expect(title.nextElementSibling!.className.split(/\s+/)).toContain('truncate');
  });

  it('reserves room for two title lines (20 px each), the facts line (16 px) and the 8 px gap', () => {
    expect(CARD_CAPTION_HEIGHT).toBeGreaterThanOrEqual(2 * 20 + 16 + 8);
    render(<MyListCard entry={entry} busy={false} onRemove={() => {}} />);
    const caption = screen.getByTestId('mylist-title').parentElement!;
    expect(caption.style.height).toBe(`${CARD_CAPTION_HEIGHT - 8}px`);
  });
});
