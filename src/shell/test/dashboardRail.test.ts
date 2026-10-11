import { afterEach, describe, expect, it, vi } from 'vitest';

import { railScrollBehavior } from '../dashboard/DashboardRail';

function stubMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduce && q.includes('prefers-reduced-motion: reduce'), media: q }));
}

afterEach(() => vi.unstubAllGlobals());

describe('dashboard rail arrow scrolling', () => {
  it('jumps instantly under prefers-reduced-motion: reduce', () => {
    stubMotion(true);
    expect(railScrollBehavior()).toBe('auto');
  });

  it('scrolls smoothly otherwise', () => {
    stubMotion(false);
    expect(railScrollBehavior()).toBe('smooth');
  });
});
