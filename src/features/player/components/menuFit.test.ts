import { afterEach, describe, expect, it } from 'vitest';

import { placeMenu, roomAbove } from './Controls';

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
});

describe('a menu taller than the room above the bar (v-player-02, -03, -05)', () => {
  function host(top: number, bottom: number, layer?: string): HTMLElement {
    const node = el(top, bottom);
    node.dataset.playerHost = '';
    if (layer) {
      const wrap = document.createElement('div');
      wrap.setAttribute(layer, '');
      document.body.appendChild(wrap);
      wrap.appendChild(node);
    }
    return node;
  }
  function frameIn(parent: HTMLElement, top: number, bottom: number): HTMLElement {
    const node = el(top, bottom);
    parent.appendChild(node);
    return node;
  }
  const height = (h: number): void => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
  };

  it('stays above the bar when it fits there', () => {
    expect(placeMenu(frameIn(host(60, 600), 100, 520), 452, 445, 'end')).toBeNull();
  });

  it('on a docked stage hangs from the player when the page below holds it', () => {
    height(900);
    el(0, 60, 'shell-header');
    // The Live page's stage at 1440x900: 270 px above the bar, 445 px of rows.
    const place = placeMenu(frameIn(host(60, 389), 100, 330), 270, 445, 'end');
    expect(place).toMatchObject({ room: 499, at: { top: 393 } });
  });

  it('slides up over the player as far as it must to show whole, under the header', () => {
    height(600);
    el(0, 60, 'shell-header');
    // 1280x600: 250 px below the player for 445 px of rows.
    expect(placeMenu(frameIn(host(60, 338), 100, 280), 205, 445, 'end')).toMatchObject({ room: 445, at: { top: 147 } });
    // Taller than the window allows: from under the header to the bottom, the room there is.
    expect(placeMenu(frameIn(host(60, 338), 100, 280), 205, 900, 'end')).toMatchObject({ room: 524, at: { top: 68 } });
  });

  it('a player that fills the window opens it as a side panel; the mini player keeps it inside', () => {
    height(390);
    expect(placeMenu(frameIn(host(0, 390, 'data-player-window-layer'), 60, 300), 292, 556, 'end')).toEqual({ side: true });
    expect(placeMenu(frameIn(host(500, 700, 'data-player-mini'), 520, 640), 132, 445, 'end')).toBeNull();
  });

  it('once out of the bar, a shorter view stays out', () => {
    height(900);
    el(0, 60, 'shell-header');
    expect(placeMenu(frameIn(host(60, 389), 100, 330), 270, 150, 'end', true)).toMatchObject({ at: { top: 393 } });
  });

  it('Fill window covers the header: the room above the bar reaches the top of the window', () => {
    el(0, 60, 'shell-header');
    expect(roomAbove(frameIn(host(0, 390, 'data-player-window-layer'), 60, 300))).toBe(292);
  });
});
