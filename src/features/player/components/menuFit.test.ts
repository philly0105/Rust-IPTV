import { afterEach, describe, expect, it } from 'vitest';

import { roomAbove, roomInDock } from './Controls';

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

describe('options menu in a player', () => {
  function host(top: number, bottom: number): HTMLElement {
    const node = el(top, bottom);
    node.dataset.playerHost = '';
    return node;
  }
  function menuIn(parent: HTMLElement, top: number, bottom: number): HTMLElement {
    const node = el(top, bottom);
    parent.appendChild(node);
    return node;
  }

  it('a floating menu stops at the top of the player that clips it', () => {
    el(0, 56, 'shell-header');
    // A docked stage from 300 to 520 px: the menu above the bar may reach 308, not the header.
    expect(roomAbove(menuIn(host(300, 520), 200, 480))).toBe(172);
  });

  it('a docked menu may take up to 55 % of the player height', () => {
    expect(roomInDock(menuIn(host(100, 500), 0, 0))).toBe(220);
    // Outside a player (or not laid out): no limit of its own.
    expect(roomInDock(el(0, 200))).toBeNull();
    expect(roomInDock(menuIn(host(0, 0), 0, 0))).toBeNull();
  });
});
