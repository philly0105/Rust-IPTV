/**
 * P2-RAILS-3: a chip row's edge fades read no layout while it mounts. They measured in an effect
 * right after the commit, which forced the page's layout (the landing's category chips); now a
 * ResizeObserver's callback measures, after the browser's layout, and a new one for new content.
 *
 * jsdom has no layout: `layOut()` (fakeResizeObservers) stands in for the browser's.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useEdgeFades } from '../hooks/useEdgeFades';
import { actEnvironment, fakeResizeObservers, layOutBox, spyLayoutReads } from './harness';

function Row({ content }: { content: string }) {
  const fades = useEdgeFades(content);
  return (
    <ul ref={fades.ref} style={fades.style} data-testid="row">
      <li>{content}</li>
    </ul>
  );
}

let observers: ReturnType<typeof fakeResizeObservers>;
beforeEach(() => {
  observers = fakeResizeObservers();
});
afterEach(() => {
  actEnvironment(true);
  cleanup();
  observers.restore();
});

describe('P2-RAILS-3: edge fades measure after layout', () => {
  it('reads nothing while it mounts, then fades the edge that hides chips, and measures new content again', () => {
    const reads = spyLayoutReads();
    const { rerender } = render(<Row content="a" />);
    expect(reads.count()).toBe(0);
    const row = screen.getByTestId('row');
    expect(row.style.maskImage).toBe('');
    layOutBox(row, { clientWidth: 300, scrollWidth: 500 });
    act(() => observers.layOut());
    expect(row.style.maskImage).toContain('transparent 100%');
    // Fewer chips, same box: the new content's observer reads it again.
    rerender(<Row content="b" />);
    layOutBox(row, { clientWidth: 300, scrollWidth: 300 });
    act(() => observers.layOut());
    expect(row.style.maskImage).toBe('');
  });

  it("puts the first reading on screen in the observer's callback, so the row never shows without its fade", () => {
    render(<Row content="a" />);
    const row = screen.getByTestId('row');
    layOutBox(row, { clientWidth: 300, scrollWidth: 500 });
    // The callback runs after layout and before paint: the fade is in the DOM when it returns, not
    // in a render a frame after the row first showed.
    actEnvironment(false);
    observers.layOut();
    expect(row.style.maskImage).toContain('transparent 100%');
  });
});
