/**
 * The category picker a grid opens (v-vod-06, v-vod-11): its All entry carries the titles'
 * count, the list is as tall as its rows up to the cap, and on touch focus goes to the list, not
 * the filter whose keyboard would cover it.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Category } from '@/api/types';

import { CategoryPickerDialog } from '../components/CategoryPickerDialog';
import { installDomStubs } from './harness';

const cat = (i: number, itemCount: number, hidden = false): Category =>
  ({ id: `c${i}`, sourceId: 'src1', contentType: 'movie', name: `Movies | Genre ${i}`, hidden, itemCount, position: i }) as Category;

function renderPicker(categories: Category[]) {
  return render(
    <MemoryRouter>
      <CategoryPickerDialog
        open
        onClose={() => undefined}
        kind="movie"
        categories={categories}
        currentId="c1"
        hrefFor={(id) => `/s/src1/movies/c/${id}`}
        state={null}
        locked={() => false}
      />
    </MemoryRouter>,
  );
}

function setCoarse(coarse: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({ matches: coarse && query.includes('coarse'), media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList,
  );
}

beforeAll(installDomStubs);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('category picker', () => {
  it('counts All movies as the shown categories do, and sizes the list to its rows', () => {
    setCoarse(false);
    renderPicker([cat(1, 12), cat(2, 8), cat(3, 5, true)]);
    expect(screen.getByRole('link', { name: /All movies/ }).textContent).toContain('20');
    // Three rows of 44 px, not a fixed 480 px panel.
    expect(screen.getByRole('list', { name: 'Categories' }).style.height).toBe('132px');
  });

  it('caps the list at 480 px for a long index', () => {
    setCoarse(false);
    renderPicker(Array.from({ length: 150 }, (_, i) => cat(i, 1)));
    expect(screen.getByRole('list', { name: 'Categories' }).style.height).toBe('480px');
  });

  it('focuses the filter with a mouse, and the list on touch', () => {
    setCoarse(false);
    renderPicker([cat(1, 12)]);
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Filter categories'));
    cleanup();
    setCoarse(true);
    renderPicker([cat(1, 12)]);
    expect(document.activeElement).toBe(screen.getByRole('list', { name: 'Categories' }));
  });
});
