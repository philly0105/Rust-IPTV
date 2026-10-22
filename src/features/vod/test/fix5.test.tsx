/**
 * U4-fix5. R2-r2 F1: poster cards without artwork show per-title initials on
 * a per-title tint, while the image itself stays decorative (alt="").
 * R6-r2 F7: a rail snapped to its padding still counts as the start.
 * R6-r2 F10: ratings use the UI language's decimal separator.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { LibraryCard } from '@/features/library/components/LibraryCard';
import type { MovieEntry } from '@/features/library/lib/myvideos';
import { hueOf } from '@/ui/Poster';

import { PosterCard } from '../components/PosterCard';
import { PosterRail, railEdges } from '../components/PosterRail';
import { formatRating } from '../lib/format';
import { i18n, installDomStubs, QueryWrapper } from './harness';

beforeAll(installDomStubs);
afterEach(cleanup);

const tileOf = (text: string) => screen.getByText(text).parentElement as HTMLElement;

describe('F1: poster fallback tiles differ per title', () => {
  it('PosterCard without artwork shows the title initials on the title tint', () => {
    render(
      <MemoryRouter>
        <PosterCard title="Arrival" href="/a" />
        <PosterCard title="Blade Runner" href="/b" />
      </MemoryRouter>,
    );
    expect(screen.queryByText('?')).toBeNull();
    const a = tileOf('AR');
    const b = tileOf('BR');
    expect(a.getAttribute('aria-hidden')).toBe('true');
    // jsdom reports the gradient in rgb; distinct hues give distinct tints.
    expect(hueOf('Arrival')).not.toBe(hueOf('Blade Runner'));
    expect(a.style.background).toContain('linear-gradient');
    expect(a.style.background).not.toBe(b.style.background);
  });

  it('keeps the image decorative and falls back to the title when it fails', () => {
    const { container } = render(
      <MemoryRouter>
        <PosterCard title="Dune Part Two" href="/d" posterUrl="http://img/broken.jpg" />
      </MemoryRouter>,
    );
    expect(container.querySelector('img')!.getAttribute('alt')).toBe('');
    // Run 3 C3: the cache URL fails, then the original and the cache URL again; only then do the initials show.
    for (let attempt = 0; attempt < 4; attempt++) {
      const img = container.querySelector('img');
      if (!img) break;
      expect(img.getAttribute('alt')).toBe('');
      fireEvent.error(img);
    }
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('DP')).toBeTruthy();
  });

  it('LibraryCard without artwork uses the entry title', () => {
    const entry = {
      kind: 'movie',
      key: 'k',
      title: 'Heat',
      missing: false,
      completedAt: '2026-10-01T00:00:00Z',
      download: { ref: { sourceId: 's1', contentType: 'movie', itemId: 'm1' }, positionSeconds: 0, bytesDownloaded: 0 },
    } as unknown as MovieEntry;
    render(<LibraryCard entry={entry} />);
    expect(screen.getByText('HE')).toBeTruthy();
    expect(screen.queryByText('?')).toBeNull();
  });
});

describe('R6-r2 F7: rail start after the snap settles on the padding', () => {
  it('treats scrollLeft 4 / -4 as the start, and further as scrolled', () => {
    expect(railEdges(4, 500, 2000).start).toBe(true);
    expect(railEdges(-4, 500, 2000).start).toBe(true);
    expect(railEdges(12, 500, 2000).start).toBe(false);
    expect(railEdges(1496, 500, 2000).end).toBe(true);
  });

  it('keeps "Scroll back" disabled at a 4 px snap offset; the snap padding matches the rail padding', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <PosterRail title="Rail" items={Array.from({ length: 20 }, (_, i) => i)} render={(i) => <span>Card {i}</span>} />
      </I18nextProvider>,
      { wrapper: QueryWrapper },
    );
    const list = screen.getByRole('list');
    expect(list.className).toContain('scroll-px-1');
    Object.defineProperty(list, 'clientWidth', { configurable: true, value: 900 });
    Object.defineProperty(list, 'scrollWidth', { configurable: true, value: 3000 });
    Object.defineProperty(list, 'scrollLeft', { configurable: true, writable: true, value: 4 });
    fireEvent.scroll(list);
    expect((screen.getByRole('button', { name: 'Scroll back' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Scroll forward' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('R6-r2 F10: localized rating decimals', () => {
  it('uses the locale separator and keeps one decimal', () => {
    expect(formatRating(8.24, 'en')).toBe('8.2');
    expect(formatRating(8.24, 'de')).toBe('8,2');
    expect(formatRating(7, 'pl')).toBe('7,0');
    expect(formatRating(8.25, 'ru')).toMatch(/^8,[23]$/);
    expect(formatRating(0, 'de')).toBeUndefined();
    expect(formatRating(6.5, 'not a locale!')).toBe('6.5');
  });

  it('PosterCard shows the German separator', async () => {
    await i18n.changeLanguage('de');
    try {
      render(
        <I18nextProvider i18n={i18n}>
          <MemoryRouter>
            <PosterCard title="Arrival" href="/a" rating={7.9} />
          </MemoryRouter>
        </I18nextProvider>,
      );
      expect(screen.getByText('7,9')).toBeTruthy();
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
