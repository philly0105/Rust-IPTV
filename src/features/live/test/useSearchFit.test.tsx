// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useSearchFit } from '../hooks/useSearchFit';

function Probe({ placeholder }: { placeholder: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const fit = useSearchFit(ref, placeholder);
  return (
    <>
      <input ref={ref} placeholder={placeholder} />
      <span data-testid="fit">{`${fit.caps ? 'caps' : 'no caps'} ${fit.textWidth}`}</span>
    </>
  );
}

describe('useSearchFit', () => {
  const original = globalThis.ResizeObserver;
  afterEach(() => {
    cleanup();
    globalThis.ResizeObserver = original;
    vi.restoreAllMocks();
  });

  it('drops the key caps when the placeholder would be cut beside them', () => {
    let notify: ((width: number) => void) | undefined;
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        notify = (width) => cb([{ borderBoxSize: [{ inlineSize: width }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    // 8 px a character.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      font: '',
      measureText: (s: string) => ({ width: s.length * 8 }),
    } as unknown as CanvasRenderingContext2D);

    render(<Probe placeholder="Αναζήτηση καναλιών" />);
    // Until the first report the field keeps its caps.
    expect(screen.getByTestId('fit').textContent).toBe('caps 0');
    // 18 characters (144 px, 148 with the slack) beside 6.25rem (100 px) of icon and caps.
    act(() => notify?.(260));
    expect(screen.getByTestId('fit').textContent).toBe('caps 148');
    act(() => notify?.(240));
    expect(screen.getByTestId('fit').textContent).toBe('no caps 148');
  });
});
