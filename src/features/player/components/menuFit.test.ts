import { afterEach, describe, expect, it } from 'vitest';

import { roomAbove } from './Controls';

const rect = (top: number, bottom: number): DOMRect => ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) });

function el(top: number, bottom: number, testId?: string): HTMLElement {
  const node = document.createElement('div');
  if (testId) node.dataset.testid = testId;
  node.getBoundingClientRect = () => rect(top, bottom);
  document.body.appendChild(node);
  return node;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('options menu height', () => {
  it('fits a menu that grows up from its bottom edge below the app header', () => {
    el(0, 56, 'shell-header');
    // Bottom edge at 179 px (the 390 px inline player): 179 - 56 - 8 px of space.
    expect(roomAbove(el(-159, 179))).toBe(115);
  });

  it('uses the top of the window without a header, and never goes below zero', () => {
    expect(roomAbove(el(100, 500))).toBe(492);
    el(0, 56, 'shell-header');
    expect(roomAbove(el(40, 60))).toBe(0);
  });

  it('cannot measure an element that is not laid out', () => {
    expect(roomAbove(el(0, 0))).toBeNull();
  });
});
