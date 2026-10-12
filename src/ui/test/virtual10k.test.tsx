import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { VirtualGrid, VirtualList } from '..';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 960 });
  Element.prototype.scrollTo ??= function scrollTo() {};
});
afterEach(cleanup);

const N = 10_000;
const items = Array.from({ length: N }, (_, i) => ({ id: `ch-${i}`, name: `Channel ${i}` }));

/**
 * SC7: 10k-item lists stay responsive. jsdom is far slower than a real
 * browser, so the budgets are generous; they catch accidental O(n) rendering
 * (every row in the DOM, per-key full re-renders), not frame timing.
 */
describe('10k items', () => {
  it('VirtualList mounts a bounded window and keyboard paging stays fast', () => {
    const t0 = performance.now();
    render(
      <VirtualList
        items={items}
        itemHeight={48}
        label="Channels"
        getKey={(c) => c.id}
        initialRect={{ width: 960, height: 600 }}
        render={(c) => <span>{c.name}</span>}
      />,
    );
    const mountMs = performance.now() - t0;
    const list = screen.getByRole('listbox', { name: 'Channels' });
    expect(list.querySelectorAll('[role="option"]').length).toBeLessThan(60);
    expect(mountMs).toBeLessThan(1500);

    list.focus();
    const t1 = performance.now();
    for (let i = 0; i < 100; i++) fireEvent.keyDown(list, { key: 'PageDown' });
    fireEvent.keyDown(list, { key: 'End' });
    const navMs = performance.now() - t1;
    expect(list.getAttribute('aria-activedescendant')).toMatch(/-opt-9999$/);
    expect(list.querySelectorAll('[role="option"]').length).toBeLessThan(60);
    expect(navMs).toBeLessThan(3000);
  });

  it('VirtualGrid mounts a bounded window of rows and End reaches the last cell', () => {
    const t0 = performance.now();
    render(
      <VirtualGrid
        items={items}
        minColumnWidth={150}
        aspect="poster"
        label="Movies"
        getKey={(c) => c.id}
        initialRect={{ width: 960, height: 720 }}
        render={(c) => <span>{c.name}</span>}
      />,
    );
    const mountMs = performance.now() - t0;
    const grid = screen.getByLabelText('Movies');
    const cells = grid.querySelectorAll('[data-index]').length;
    expect(cells).toBeGreaterThan(0);
    expect(cells).toBeLessThan(120);
    expect(mountMs).toBeLessThan(1500);
    grid.focus();
    fireEvent.keyDown(grid, { key: 'End' });
    expect(grid.getAttribute('aria-activedescendant')).toMatch(/9999$/);
  });
});

describe('50k items', () => {
  const big = Array.from({ length: 50_000 }, (_, i) => ({ id: `ch-${i}`, name: `Channel ${i}` }));

  it('VirtualList keeps a bounded window and Home/End/PageUp cross the whole list', () => {
    const t0 = performance.now();
    render(
      <VirtualList
        items={big}
        itemHeight={48}
        label="Channels"
        getKey={(c) => c.id}
        initialRect={{ width: 960, height: 600 }}
        render={(c) => <span>{c.name}</span>}
      />,
    );
    expect(performance.now() - t0).toBeLessThan(2000);
    const list = screen.getByRole('listbox', { name: 'Channels' });
    list.focus();
    fireEvent.keyDown(list, { key: 'End' });
    expect(list.getAttribute('aria-activedescendant')).toMatch(/-opt-49999$/);
    fireEvent.keyDown(list, { key: 'PageUp' });
    expect(list.getAttribute('aria-activedescendant')).not.toMatch(/-opt-49999$/);
    fireEvent.keyDown(list, { key: 'Home' });
    expect(list.getAttribute('aria-activedescendant')).toMatch(/-opt-0$/);
    expect(list.querySelectorAll('[role="option"]').length).toBeLessThan(60);
  });

  it('VirtualGrid reaches the last of 50k cells with a bounded DOM', () => {
    render(
      <VirtualGrid
        items={big}
        minColumnWidth={150}
        aspect="poster"
        label="Movies"
        getKey={(c) => c.id}
        initialRect={{ width: 960, height: 720 }}
        render={(c) => <span>{c.name}</span>}
      />,
    );
    const grid = screen.getByLabelText('Movies');
    grid.focus();
    fireEvent.keyDown(grid, { key: 'End' });
    expect(grid.getAttribute('aria-activedescendant')).toMatch(/49999$/);
    expect(grid.querySelectorAll('[data-index]').length).toBeLessThan(120);
  });
});

describe('VirtualGrid cursor restore', () => {
  const few = items.slice(0, 40);
  const grid = (extra: { initialActiveIndex?: number; onSelect?: (c: (typeof items)[number], i: number) => void }) => (
    <VirtualGrid
      items={few}
      minColumnWidth={150}
      aspect="poster"
      label="Movies"
      getKey={(c) => c.id}
      initialRect={{ width: 960, height: 720 }}
      render={(c) => <span>{c.name}</span>}
      {...extra}
    />
  );

  it('starts the keyboard cursor on initialActiveIndex', () => {
    render(grid({ initialActiveIndex: 7 }));
    const g = screen.getByLabelText('Movies');
    expect(g.getAttribute('aria-activedescendant')).toMatch(/-7$/);
    fireEvent.keyDown(g, { key: 'ArrowRight' });
    expect(g.getAttribute('aria-activedescendant')).toMatch(/-8$/);
  });

  it('ignores an out-of-range initialActiveIndex', () => {
    render(grid({ initialActiveIndex: 400 }));
    expect(screen.getByLabelText('Movies').hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('a click moves the cursor to the cell and then selects it', () => {
    const onSelect = vi.fn();
    render(grid({ onSelect }));
    fireEvent.click(screen.getByText('Channel 3'));
    expect(onSelect).toHaveBeenCalledWith(few[3], 3);
    expect(screen.getByLabelText('Movies').getAttribute('aria-activedescendant')).toMatch(/-3$/);
  });
});
