import { act, cleanup, render, screen } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { lazyPart } from './lazyParts';

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('lazyPart', () => {
  it('renders synchronously on first mount once preloaded, so nothing flashes', async () => {
    const Part = lazyPart(async () => ({ label }: { label: string }) => <p>{label}</p>);
    await Part.preload();
    render(<Part label="ready" />);
    expect(screen.getByText('ready')).toBeTruthy();
  });

  it('shows the fallback while loading, then the part', async () => {
    const d = deferred<(p: { label: string }) => ReactNode>();
    const Part = lazyPart(() => d.promise, (p) => <i>{`wait ${p.label}`}</i>);
    render(<Part label="x" />);
    expect(screen.getByText('wait x')).toBeTruthy();
    await act(async () => d.resolve(({ label }) => <p>{label}</p>));
    expect(await screen.findByText('x')).toBeTruthy();
  });

  it('loads the chunk once, shared by preload and render', async () => {
    const load = vi.fn(async () => () => <p>once</p>);
    const Part = lazyPart(load);
    render(<Part />);
    await Part.preload();
    expect(await screen.findByText('once')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps a mounted instance (and its state) when the load finishes mid-life', async () => {
    const d = deferred<() => ReactNode>();
    function Counter() {
      const [n, setN] = useState(0);
      return (
        <button type="button" onClick={() => setN(n + 1)}>
          {`n${n}`}
        </button>
      );
    }
    const Part = lazyPart(() => d.promise);
    const { rerender } = render(<Part />);
    await act(async () => d.resolve(Counter));
    const button = await screen.findByText('n0');
    act(() => button.click());
    rerender(<Part />);
    expect(screen.getByText('n1')).toBeTruthy();
  });
});
