/** Loop 2 cross-area fixes in the shared UI kit (XB2). */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import '@/i18n';

import { Badge, LivePill, Tabs, Tooltip } from '..';
import { placeMenu } from '../Menu';
import { hiddenTabEdges } from '../Tabs';

/** Stands in for the Fullscreen API, which jsdom lacks. */
function setFullscreen(el: Element | null): void {
  Object.defineProperty(document, 'fullscreenElement', { value: el, configurable: true });
  document.dispatchEvent(new Event('fullscreenchange'));
}

afterEach(() => {
  cleanup();
  setFullscreen(null);
  document.body.querySelectorAll('[data-test-stage]').forEach((n) => n.remove());
});

describe('Tooltip in element fullscreen (XB2-20)', () => {
  it('portals into the fullscreen element, so it shows over the player or the wall', async () => {
    const stage = document.body.appendChild(document.createElement('div'));
    stage.dataset['testStage'] = '';
    setFullscreen(stage);
    render(
      <Tooltip content="Mute" delay={0}>
        <button type="button">M</button>
      </Tooltip>,
    );
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'M' }));
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(stage.contains(screen.getByRole('tooltip'))).toBe(true);
  });
});

describe('Tooltip in Fill window', () => {
  it('paints inside the raised player layer instead of underneath it', async () => {
    const stage = document.body.appendChild(document.createElement('div'));
    stage.dataset['testStage'] = '';
    stage.dataset['playerWindowLayer'] = '';
    render(
      <Tooltip content="Exit Fill window" delay={0} tone="glass">
        <button type="button">Fill</button>
      </Tooltip>,
    );
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Fill' }));
    await act(() => new Promise((r) => setTimeout(r, 10)));
    const tip = screen.getByRole('tooltip');
    expect(stage.contains(tip)).toBe(true);
    expect(tip.textContent).toBe('Exit Fill window');
    expect(tip.className).toContain('z-[70]');
  });
});

describe('Badge text truncates (XB2-24)', () => {
  it('puts text in a shrinking, truncating span so a max-w shows an ellipsis', () => {
    render(
      <Badge className="max-w-[110px]" data-testid="b">
        A very long source name
      </Badge>,
    );
    const badge = screen.getByTestId('b');
    const inner = badge.firstElementChild as HTMLElement;
    expect(inner.tagName).toBe('SPAN');
    expect(inner.className).toBe('min-w-0 truncate leading-normal');
    expect(inner.textContent).toBe('A very long source name');
    expect(badge.textContent).toBe('A very long source name');
  });

  it('keeps icons beside the text, and joins interpolated text into one run', () => {
    const n = 3;
    render(
      <Badge data-testid="b">
        <svg aria-hidden data-icon="" />
        Season {n}
      </Badge>,
    );
    const kids = Array.from(screen.getByTestId('b').children);
    expect(kids.map((k) => k.tagName.toLowerCase())).toEqual(['svg', 'span']);
    expect(kids[1]!.textContent).toBe('Season 3');
    expect(kids[1]!.className).toBe('min-w-0 truncate leading-normal');
  });

  it('LivePill keeps its pulse dot as a sized flex item', () => {
    const { container } = render(<LivePill />);
    const kids = Array.from(container.firstElementChild!.children);
    expect(kids).toHaveLength(2);
    expect(kids[0]!.className).toContain('h-1.5 w-1.5');
    expect(kids[1]!.className).toBe('min-w-0 truncate leading-normal');
    expect(kids[1]!.textContent).toBe('Live');
  });
});

describe('Tabs that overflow (XB2-29)', () => {
  const items = [
    { id: 'm3u', label: 'M3U playlist' },
    { id: 'xtream', label: 'Xtream Codes' },
    { id: 'stalker', label: 'Stalker portal' },
  ];

  it('scroll sideways with a hidden scrollbar, and the tabs keep their whole label', () => {
    render(<Tabs items={items} value="m3u" onChange={() => {}} label="Kind" />);
    const list = screen.getByRole('tablist', { name: 'Kind' });
    expect(list.className.split(/\s+/)).toEqual(expect.arrayContaining(['overflow-x-auto', 'scrollbar-none', 'max-w-full']));
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.className.split(/\s+/)).toEqual(expect.arrayContaining(['shrink-0', 'whitespace-nowrap']));
    }
  });

  it('finds the edges that hide tabs, in LTR and RTL', () => {
    const box = (scrollLeft: number, rtl = false) => ({ scrollLeft, scrollWidth: 500, clientWidth: 300, rtl });
    expect(hiddenTabEdges({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300, rtl: false })).toEqual({ left: false, right: false });
    expect(hiddenTabEdges(box(0))).toEqual({ left: false, right: true });
    expect(hiddenTabEdges(box(100))).toEqual({ left: true, right: true });
    expect(hiddenTabEdges(box(200))).toEqual({ left: true, right: false });
    // RTL starts at the right edge (scrollLeft 0) and runs negative toward the end.
    expect(hiddenTabEdges(box(0, true))).toEqual({ left: true, right: false });
    expect(hiddenTabEdges(box(-200, true))).toEqual({ left: false, right: true });
  });

  it('fades the edge that hides tabs, only on the underline variant', () => {
    const sized = (el: HTMLElement) => {
      Object.defineProperty(el, 'scrollWidth', { configurable: true, value: 500 });
      Object.defineProperty(el, 'clientWidth', { configurable: true, value: 300 });
    };
    render(<Tabs items={items} value="m3u" onChange={() => {}} label="Kind" />);
    const list = screen.getByRole('tablist');
    sized(list);
    fireEvent.scroll(list);
    expect(list.style.maskImage).toContain('transparent 100%');
    expect(list.style.maskImage).not.toContain('transparent 0');

    cleanup();
    render(<Tabs items={items} value="m3u" onChange={() => {}} label="Kind" variant="pill" />);
    const pill = screen.getByRole('tablist');
    sized(pill);
    fireEvent.scroll(pill);
    expect(pill.style.maskImage).toBe('');
  });
});

describe("Menu placement 'inline-end' (XB2-27)", () => {
  const vp = { width: 1000, height: 700 };
  const size = { width: 200, height: 300 };
  // A collapsed-rail trigger: 56 px wide at the left edge in LTR, at the right edge in RTL.
  const ltrMark = { top: 100, bottom: 140, left: 8, right: 64 };
  const rtlMark = { top: 100, bottom: 140, left: 936, right: 992 };

  it('opens beside the trigger on its inline-end side, top edges lined up', () => {
    expect(placeMenu(ltrMark, size, vp, { align: 'start', rtl: false, placement: 'inline-end' })).toEqual({ top: 100, left: 70, side: 'inline-end' });
    // RTL mirrors it: the menu opens to the left of a trigger on the right edge.
    expect(placeMenu(rtlMark, size, vp, { align: 'start', rtl: true, placement: 'inline-end' })).toEqual({
      top: 100,
      left: 936 - 6 - 200,
      side: 'inline-end',
    });
  });

  it('flips to the inline-start side when the end side has no room and the start side has more', () => {
    const p = placeMenu({ top: 100, bottom: 140, left: 900, right: 956 }, size, vp, { align: 'start', rtl: false, placement: 'inline-end' });
    expect(p.side).toBe('inline-start');
    expect(p.left).toBe(900 - 6 - 200);
  });

  it('lines up bottom edges near the bottom of the screen and stays inside the viewport', () => {
    const low = placeMenu({ top: 600, bottom: 640, left: 8, right: 64 }, size, vp, { align: 'start', rtl: false, placement: 'inline-end' });
    expect(low.top).toBe(640 - 300);
    const tall = placeMenu(ltrMark, { width: 200, height: 900 }, vp, { align: 'start', rtl: false, placement: 'inline-end' });
    expect(tall.top).toBe(8);
    // On a phone a menu wider than the room beside the rail slides back over it, inside the margin.
    const narrow = placeMenu(ltrMark, { width: 330, height: 200 }, { width: 390, height: 844 }, { align: 'start', rtl: false, placement: 'inline-end' });
    expect(narrow.left).toBe(390 - 8 - 330);
  });
});
