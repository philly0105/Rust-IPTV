/** The day strip opens with the picked day in its middle, and glides to each day picked after. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DayStrip } from '../components/DayStrip';
import { etDate, etDays } from '../lib/espn';
import { i18n } from './harness';

const TAB = 60;
const BOX = 240;

/** jsdom lays nothing out: the tabs are 60 px side by side in a 240 px box that scrolls. */
function layOut() {
  const proto = HTMLElement.prototype;
  const isList = (el: HTMLElement) => el.getAttribute('role') === 'tablist';
  vi.spyOn(proto, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return isList(this) ? this.children.length * TAB : 0;
  });
  vi.spyOn(proto, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return isList(this) ? BOX : 0;
  });
  vi.spyOn(proto, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const list = this.parentElement;
    if (isList(this)) return { left: 0, right: BOX, width: BOX } as DOMRect;
    if (this.getAttribute('role') === 'tab' && list) {
      const left = [...list.children].indexOf(this) * TAB - list.scrollLeft;
      return { left, right: left + TAB, width: TAB } as DOMRect;
    }
    return { left: 0, right: 0, width: 0 } as DOMRect;
  });
}

function Strip() {
  const now = Date.now();
  const today = etDate(now);
  const [day, setDay] = useState(today);
  return <DayStrip days={etDays(now, 7, 7)} value={day} today={today} onChange={setDay} panelIdPrefix="d" />;
}

afterEach(cleanup);

describe('day strip', () => {
  it('opens with today in the middle, so Yesterday and Tomorrow show beside it', () => {
    layOut();
    render(
      <I18nextProvider i18n={i18n}>
        <Strip />
      </I18nextProvider>,
    );
    const list = screen.getByRole('tablist');
    // Today is the eighth of fifteen tabs: its middle (7 * 60 + 30) on the box's (120).
    expect(list.scrollLeft).toBe(7 * TAB + TAB / 2 - BOX / 2);
  });

  it('glides a picked day to the middle, unless motion is turned down', () => {
    layOut();
    const scrollBy = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollBy', { value: scrollBy, configurable: true });
    try {
      render(
        <I18nextProvider i18n={i18n}>
          <Strip />
        </I18nextProvider>,
      );
      const list = screen.getByRole('tablist');
      const start = list.scrollLeft;
      fireEvent.click(screen.getByRole('tab', { name: /^Tomorrow / }));
      // One tab further on: its middle is a tab's width right of the box's.
      expect(scrollBy).toHaveBeenLastCalledWith({ left: TAB, behavior: 'smooth' });
      expect(list.scrollLeft).toBe(start);

      // jsdom has no matchMedia: this one says the user turned motion down.
      Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: true }), configurable: true });
      fireEvent.click(screen.getByRole('tab', { name: /^Yesterday / }));
      expect(scrollBy).toHaveBeenCalledTimes(1);
      // The glide above was a mock, so Today is still in the middle: Yesterday, a tab before it, jumps there.
      expect(list.scrollLeft).toBe(start - TAB);
    } finally {
      delete (HTMLElement.prototype as { scrollBy?: unknown }).scrollBy;
      delete (window as { matchMedia?: unknown }).matchMedia;
    }
  });
});
