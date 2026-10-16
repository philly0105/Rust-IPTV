import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';

import { useUrlSearchDraft } from '../hooks/useUrlSearchDraft';

/** L3-vod-1: the search boxes of /search and the category grid debounce into `?q=`. */
function Box({ delayMs, keepSpaces }: { delayMs: number; keepSpaces?: boolean }) {
  const [draft, setDraft] = useUrlSearchDraft(keepSpaces ? { delayMs, toParam: (d) => (d.trim() ? d : '') } : { delayMs });
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <input aria-label="search" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <output data-testid="q">{new URLSearchParams(location.search).get('q') ?? ''}</output>
      <button type="button" onClick={() => void navigate('?q=chip')}>
        chip
      </button>
    </>
  );
}

const field = () => screen.getByLabelText<HTMLInputElement>('search');
const urlQ = () => screen.getByTestId('q').textContent;

/**
 * Types `text` one key at a time, `gapMs` apart. Each key lands in the same task as the timers
 * that came due before it, so a debounced URL write that fires just before a key commits only
 * after it: the order a browser gives at ordinary typing speed.
 */
function typeAt(text: string, gapMs: number, from = '') {
  let typed = from;
  for (const ch of text) {
    typed += ch;
    const value = typed;
    act(() => {
      vi.advanceTimersByTime(gapMs);
      fireEvent.change(field(), { target: { value } });
    });
  }
}

describe('L3-vod-1: typing never loses letters to the debounced URL write', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('keeps every letter at 120 ms per key across router commits (global search, 100 ms debounce)', () => {
    render(
      <MemoryRouter initialEntries={['/search']}>
        <Box delayMs={100} keepSpaces />
      </MemoryRouter>,
    );
    typeAt('northbound', 120);
    expect(field().value).toBe('northbound');
    act(() => vi.advanceTimersByTime(500));
    expect(field().value).toBe('northbound');
    expect(urlQ()).toBe('northbound');
  });

  it.each([60, 90, 105, 130])('keeps "black harbor" at %i ms per key', (gap) => {
    render(
      <MemoryRouter initialEntries={['/search']}>
        <Box delayMs={100} keepSpaces />
      </MemoryRouter>,
    );
    typeAt('black harbor', gap);
    act(() => vi.advanceTimersByTime(500));
    expect(field().value).toBe('black harbor');
    expect(urlQ()).toBe('black harbor');
  });

  it('keeps a space typed just before a pause (category grid, trimmed into the URL)', () => {
    render(
      <MemoryRouter initialEntries={['/grid']}>
        <Box delayMs={250} />
      </MemoryRouter>,
    );
    typeAt('blue ', 120);
    act(() => vi.advanceTimersByTime(1000));
    expect(field().value).toBe('blue ');
    expect(urlQ()).toBe('blue');
    typeAt('current', 120, 'blue ');
    act(() => vi.advanceTimersByTime(1000));
    expect(field().value).toBe('blue current');
    expect(urlQ()).toBe('blue current');
  });

  it('still follows the URL when something else changes it (a chip, Back)', () => {
    render(
      <MemoryRouter initialEntries={['/search?q=harbor']}>
        <Box delayMs={100} keepSpaces />
      </MemoryRouter>,
    );
    expect(field().value).toBe('harbor');
    fireEvent.click(screen.getByRole('button', { name: 'chip' }));
    expect(field().value).toBe('chip');
    act(() => vi.advanceTimersByTime(500));
    expect(urlQ()).toBe('chip');
  });

  it('clearing the box removes q after the pause', () => {
    render(
      <MemoryRouter initialEntries={['/search?q=harbor']}>
        <Box delayMs={100} keepSpaces />
      </MemoryRouter>,
    );
    act(() => {
      fireEvent.change(field(), { target: { value: '' } });
    });
    act(() => vi.advanceTimersByTime(200));
    expect(field().value).toBe('');
    expect(urlQ()).toBe('');
  });
});
