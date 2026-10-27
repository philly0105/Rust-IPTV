/**
 * The kinds of source as tiles: list rows in one column (a phone), full cards from @3xl.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { SourceKindTiles } from '../components/Onboarding';

afterEach(cleanup);

describe('SourceKindTiles', () => {
  it('keeps Xtream first and every tile named by its kind, what it is and what it needs', () => {
    const onPick = vi.fn();
    render(<SourceKindTiles onPick={onPick} />);
    const tiles = screen.getAllByRole('button');
    expect(tiles.map((b) => b.dataset.testid)).toEqual(['onboard-xtream', 'onboard-m3u', 'onboard-stalker']);
    const xtream = tiles[0]!;
    // The sentence on what the kind is stays for screen readers in the compact row.
    expect(xtream.textContent).toContain('Live TV, movies and series from an account login.');
    expect(xtream.textContent).toContain('Server, username and password');
    fireEvent.click(xtream);
    expect(onPick).toHaveBeenCalledWith('xtream');
  });

  it('draws one-column tiles as short rows: no body sentence or ruled footer until @3xl', () => {
    render(<SourceKindTiles onPick={() => undefined} />);
    const m3u = screen.getByTestId('onboard-m3u');
    const body = within(m3u).getByText('A link or file listing channels, usually ending in .m3u.');
    expect(body.className).toContain('sr-only');
    expect(body.className).toContain('@3xl:not-sr-only');
    // What the user needs: a quiet line in the row, the ruled "You need" footer on a card.
    const [line, footerValue] = within(m3u).getAllByText('A URL, a file, or the playlist text');
    expect(line!.className).toContain('@3xl:hidden');
    const footer = within(m3u).getByText('You need').closest('.border-t')!;
    expect(footer.contains(footerValue!)).toBe(true);
    expect(footer.className).toMatch(/(^| )hidden( |$)/);
    expect(footer.className).toContain('@3xl:flex');
    // The badge sits beside the name in a row and at the icon row's end on a card.
    const badges = within(screen.getByTestId('onboard-xtream')).getAllByText('Most common');
    expect(badges).toHaveLength(2);
    expect(badges.filter((b) => b.closest('[class~="@3xl:inline-flex"]'))).toHaveLength(1);
    expect(badges.filter((b) => b.closest('[class~="@3xl:hidden"]'))).toHaveLength(1);
  });
});
