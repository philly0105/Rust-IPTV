// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useNarrow } from './useNarrow';

function Probe() {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const narrow = useNarrow(el);
  return (
    <div ref={setEl} data-testid="probe">
      {narrow ? 'narrow' : 'wide'}
    </div>
  );
}

describe('useNarrow', () => {
  const original = globalThis.ResizeObserver;
  afterEach(() => {
    cleanup();
    globalThis.ResizeObserver = original;
  });

  it('reads the width in the observer callback, not while the player mounts', () => {
    let notify: (() => void) | undefined;
    globalThis.ResizeObserver = class {
      constructor(cb: () => void) {
        notify = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(390);

    render(<Probe />);
    // Mounting reads no layout: a read here would force one in the frame of the click.
    expect(width).not.toHaveBeenCalled();
    expect(screen.getByTestId('probe').textContent).toBe('wide');

    act(() => notify?.());
    expect(screen.getByTestId('probe').textContent).toBe('narrow');

    width.mockReturnValue(640);
    act(() => notify?.());
    expect(screen.getByTestId('probe').textContent).toBe('wide');
  });
});
