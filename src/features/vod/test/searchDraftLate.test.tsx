/**
 * The search box's debounced URL write, against a router that commits late: on a slow machine
 * the router's navigation (a transition the keys keep interrupting) can land after the box has
 * written the next value. Following that older value back into the box dropped the letter typed
 * in between ('dark river' became 'dark rver').
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The URL's `q`, and the writes the router has been asked for but has not committed yet. */
const url = vi.hoisted(() => ({ q: '', queued: [] as string[], listeners: new Set<() => void>() }));

vi.mock('react-router', () => ({
  useSearchParams: () => {
    const q = useSyncExternalStore(
      (l: () => void) => (url.listeners.add(l), () => url.listeners.delete(l)),
      () => url.q,
    );
    const params = useMemo(() => new URLSearchParams(q ? { q } : {}), [q]);
    const set = useCallback((next: (prev: URLSearchParams) => URLSearchParams) => {
      url.queued.push(next(new URLSearchParams(url.q ? { q: url.q } : {})).get('q') ?? '');
    }, []);
    return [params, set];
  },
}));

const { useUrlSearchDraft } = await import('../hooks/useUrlSearchDraft');

function Box() {
  const [draft, setDraft] = useUrlSearchDraft({ delayMs: 100, toParam: (d) => (d.trim() ? d : '') });
  return <input aria-label="search" value={draft} onChange={(e) => setDraft(e.target.value)} />;
}

const field = () => screen.getByLabelText<HTMLInputElement>('search');

function key(value: string, gapMs = 120) {
  act(() => {
    vi.advanceTimersByTime(gapMs);
    fireEvent.change(field(), { target: { value } });
  });
}

/** The router commits the oldest write it was asked for. */
function commitOldest() {
  act(() => {
    url.q = url.queued.shift()!;
    for (const l of url.listeners) l();
  });
}

/** The router commits something nobody typed (Back, a chip). */
function navigateTo(q: string) {
  act(() => {
    url.queued.length = 0;
    url.q = q;
    for (const l of url.listeners) l();
  });
}

describe('typing against a router that commits late', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    url.q = '';
    url.queued.length = 0;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('keeps a letter typed while an older write is still on its way', () => {
    render(<Box />);
    key('a');
    key('ab');
    // Both writes are out ('a' fired before 'b'; 'ab' 100 ms after it); the router has committed neither.
    act(() => vi.advanceTimersByTime(100));
    expect(url.queued).toEqual(['a', 'ab']);
    commitOldest();
    expect(field().value).toBe('ab');
    key('abc', 20);
    commitOldest();
    expect(field().value).toBe('abc');
    act(() => vi.advanceTimersByTime(200));
    while (url.queued.length) commitOldest();
    expect(field().value).toBe('abc');
    expect(url.q).toBe('abc');
  });

  it('still follows the URL when something else moves it after its own writes', () => {
    render(<Box />);
    key('dark');
    act(() => vi.advanceTimersByTime(200));
    while (url.queued.length) commitOldest();
    expect(field().value).toBe('dark');
    navigateTo('harbor');
    expect(field().value).toBe('harbor');
    // A write of its own that was never committed does not hide a later move to the same text.
    key('harbo');
    act(() => vi.advanceTimersByTime(200));
    navigateTo('dark');
    expect(field().value).toBe('dark');
  });
});
