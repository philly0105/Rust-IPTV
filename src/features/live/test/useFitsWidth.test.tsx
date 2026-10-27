// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useFitsWidth } from '../hooks/useFitsWidth';

function Probe() {
  const ref = useRef<HTMLDivElement>(null);
  const fits = useFitsWidth(ref, 60);
  return (
    <div ref={ref} data-testid="probe">
      {fits ? 'fits' : 'narrow'}
    </div>
  );
}

describe('useFitsWidth', () => {
  const original = globalThis.ResizeObserver;
  afterEach(() => {
    cleanup();
    globalThis.ResizeObserver = original;
    vi.restoreAllMocks();
  });

  it('takes the width from the observer, not from a read while the page mounts', () => {
    let notify: ((width: number) => void) | undefined;
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        notify = (width) => cb([{ contentRect: { width } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    const client = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(2000);
    const offset = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(2000);
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect');

    render(<Probe />);
    // Mounting reads no layout: a read here would force the new page's layout inside the commit.
    expect(client).not.toHaveBeenCalled();
    expect(offset).not.toHaveBeenCalled();
    expect(rect).not.toHaveBeenCalled();
    // Until the first report the element counts as wide enough.
    expect(screen.getByTestId('probe').textContent).toBe('fits');

    // jsdom's root is 16 px, so 60rem is 960 px.
    act(() => notify?.(776));
    expect(screen.getByTestId('probe').textContent).toBe('narrow');
    act(() => notify?.(960));
    expect(screen.getByTestId('probe').textContent).toBe('fits');
    // A report of no width (a hidden page) keeps the last answer.
    act(() => notify?.(776));
    act(() => notify?.(0));
    expect(screen.getByTestId('probe').textContent).toBe('narrow');
  });

  it('reads the width at once where there is no ResizeObserver', () => {
    // An engine without the observer.
    globalThis.ResizeObserver = undefined as unknown as typeof ResizeObserver;
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(776);
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('narrow');
  });
});
