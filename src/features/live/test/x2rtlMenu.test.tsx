/** X2-craft: the channel context menu opens toward the reading direction. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContextMenu } from '../components/ContextMenu';

const items = [{ id: 'play', label: 'Play', onSelect: () => undefined }];

afterEach(() => {
  cleanup();
  document.documentElement.dir = '';
  vi.restoreAllMocks();
});

function openAt(x: number) {
  // jsdom has no layout: give the menu a measurable size.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 200, height: 100, top: 0, left: 0, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
  render(<ContextMenu pos={{ x, y: 50 }} label="Channel 1" items={items} onClose={() => undefined} />);
  return screen.getByRole('menu');
}

describe('context menu placement', () => {
  it('grows to the right of the pointer in LTR', () => {
    expect(openAt(500).style.left).toBe('500px');
  });

  it('grows to the left of the pointer in RTL', () => {
    document.documentElement.dir = 'rtl';
    expect(openAt(500).style.left).toBe('300px');
  });

  it('still stays inside the window in RTL near the left edge', () => {
    document.documentElement.dir = 'rtl';
    expect(openAt(50).style.left).toBe('8px');
  });
});
