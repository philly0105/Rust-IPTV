/**
 * U4-fix4: craft review findings F7/F8 (PosterRail RTL + reduced motion),
 * F9 (capped search with "Show more"), F11 (localized runtimes), and F1
 * (detail backdrop stacking context; see also pages.test.tsx).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CatalogSearchResult } from '@/api/rpc';
import type { VodItem } from '@/api/types';

import { PosterRail, railEdges, railScrollDelta } from '../components/PosterRail';
import { formatRuntime, resetRuntimeFormatCache, type RuntimeKey } from '../lib/format';
import {
  SEARCH_LIMIT,
  SEARCH_SERVER_MAX,
  capSearchResult,
  nextSearchLimit,
  searchLimitSteps,
  searchRequestLimit,
} from '../lib/search';
import { i18n, installDomStubs } from './harness';

beforeAll(installDomStubs);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetRuntimeFormatCache();
});

describe('F7: PosterRail RTL', () => {
  it('flips the scroll delta in RTL and keeps the page size', () => {
    expect(railScrollDelta(1, false, 900, 150)).toBe(750);
    expect(railScrollDelta(-1, false, 900, 150)).toBe(-750);
    expect(railScrollDelta(1, true, 900, 150)).toBe(-750);
    expect(railScrollDelta(-1, true, 900, 150)).toBe(750);
    // Narrow rail: never less than one card.
    expect(railScrollDelta(1, true, 100, 150)).toBe(-150);
  });

  it('computes edges from |scrollLeft| so RTL negative offsets work', () => {
    expect(railEdges(0, 500, 2000)).toEqual({ start: true, end: false });
    expect(railEdges(-4, 500, 2000)).toEqual({ start: false, end: false });
    expect(railEdges(-1500, 500, 2000)).toEqual({ start: false, end: true });
    expect(railEdges(1500, 500, 2000)).toEqual({ start: false, end: true });
    expect(railEdges(0, 500, 400)).toEqual({ start: true, end: true });
  });
});

function renderRail(opts: { rtl: boolean; reduced: boolean }) {
  const scrollBy = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollBy', { configurable: true, writable: true, value: scrollBy });
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query.includes('prefers-reduced-motion') ? opts.reduced : false,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
  const realStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
    const style = realStyle(el, pseudo);
    return new Proxy(style, {
      get: (target, prop) => (prop === 'direction' ? (opts.rtl ? 'rtl' : 'ltr') : Reflect.get(target, prop, target)),
    });
  });
  const items = Array.from({ length: 20 }, (_, i) => i);
  render(
    <I18nextProvider i18n={i18n}>
      <div dir={opts.rtl ? 'rtl' : 'ltr'}>
        <PosterRail title="Rail" items={items} render={(i) => <span>Card {i}</span>} cardWidth={150} />
      </div>
    </I18nextProvider>,
  );
  const list = screen.getByRole('list');
  Object.defineProperty(list, 'clientWidth', { configurable: true, value: 900 });
  Object.defineProperty(list, 'scrollWidth', { configurable: true, value: 3000 });
  return { scrollBy, list };
}

describe('F7/F8: PosterRail paging', () => {
  it('scrolls toward the inline end in RTL (negative left) and enables back after moving', () => {
    const { scrollBy, list } = renderRail({ rtl: true, reduced: false });
    Object.defineProperty(list, 'scrollLeft', { configurable: true, writable: true, value: 0 });
    fireEvent.scroll(list);
    const next = screen.getByRole('button', { name: 'Scroll forward' });
    const prev = screen.getByRole('button', { name: 'Scroll back' });
    expect((next as HTMLButtonElement).disabled).toBe(false);
    expect((prev as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(next);
    expect(scrollBy).toHaveBeenCalledWith({ left: -750, behavior: 'smooth' });
    // The browser reports a negative scrollLeft once the RTL rail moved.
    list.scrollLeft = -750;
    fireEvent.scroll(list);
    expect((prev as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(prev);
    expect(scrollBy).toHaveBeenLastCalledWith({ left: 750, behavior: 'smooth' });
  });

  it('jumps instead of smooth-scrolling under prefers-reduced-motion', () => {
    const { scrollBy, list } = renderRail({ rtl: false, reduced: true });
    fireEvent.scroll(list);
    fireEvent.click(screen.getByRole('button', { name: 'Scroll forward' }));
    expect(scrollBy).toHaveBeenCalledWith({ left: 750, behavior: 'auto' });
  });
});

const movie = (i: number): VodItem => ({ ref: { sourceId: 's', contentType: 'movie', itemId: `m${i}` }, title: `M${i}`, categoryId: 'c' });
const result = (live: number, movies: number, series: number): CatalogSearchResult => ({
  live: Array.from({ length: live }, (_, i) => ({ ref: { sourceId: 's', contentType: 'live', itemId: `l${i}` }, name: `L${i}`, categoryId: 'g', categoryName: 'G', isRadio: false })),
  movies: Array.from({ length: movies }, (_, i) => movie(i)),
  series: Array.from({ length: series }, (_, i) => ({ ref: { sourceId: 's', contentType: 'series', itemId: `s${i}` }, title: `S${i}`, categoryId: 'c' })),
});

describe('F9: search caps', () => {
  it('steps through the reachable limits under the server clamp', () => {
    expect(SEARCH_LIMIT).toBe(60);
    // The 1001 clamp leaves room for the 1000 step's probe row, and no pointless 1001 step.
    expect(searchLimitSteps()).toEqual([60, 200, 1000]);
    expect(searchLimitSteps(1000)).toEqual([60, 200, 1000]);
    expect(searchLimitSteps(500)).toEqual([60, 200, 500]);
    expect(searchLimitSteps(201)).toEqual([60, 200]);
    expect(nextSearchLimit(60)).toBe(200);
    expect(nextSearchLimit(200)).toBe(1000);
    expect(nextSearchLimit(1000)).toBeUndefined();
    expect(nextSearchLimit(200, 201)).toBeUndefined();
  });

  it('asks for one extra row to detect more, within the clamp', () => {
    expect(searchRequestLimit(60)).toBe(61);
    expect(searchRequestLimit(SEARCH_SERVER_MAX)).toBe(SEARCH_SERVER_MAX);
  });

  it('trims each type to the limit and flags the types that have more', () => {
    const { result: r, more } = capSearchResult(result(61, 60, 3), 60);
    expect(r?.live).toHaveLength(60);
    expect(r?.movies).toHaveLength(60);
    expect(r?.series).toHaveLength(3);
    expect(more).toEqual({ live: true, movies: false, series: false });
  });

  it('at the clamp, a full page counts as "probably more"', () => {
    expect(capSearchResult(result(200, 199, 0), 200, 200).more).toEqual({ live: true, movies: false, series: false });
    // Below the clamp the probe row decides: 1001 rows at the 1000 step means more.
    expect(capSearchResult(result(1001, 1000, 0), 1000).more).toEqual({ live: true, movies: false, series: false });
    expect(capSearchResult(undefined, 60)).toEqual({ result: undefined, more: { live: false, movies: false, series: false } });
  });
});

describe('F11: localized runtimes', () => {
  const keys: Record<RuntimeKey, string> = { runtimeHours: '{{h}} Std.', runtimeMinutes: '{{m}} Min.', runtimeHoursMinutes: '{{h}} Std. {{m}} Min.' };
  const t = (key: RuntimeKey, vars: { h?: number; m?: number }) => keys[key].replace('{{h}}', String(vars.h)).replace('{{m}}', String(vars.m));

  it('keeps the compact English form', () => {
    expect(formatRuntime(5580, { locale: 'en' })).toBe('1h 33m');
    expect(formatRuntime(2700, { locale: 'en' })).toBe('45m');
    expect(formatRuntime(7200, { locale: 'en' })).toBe('2h');
    expect(formatRuntime(5580)).toBe('1h 33m');
    expect(formatRuntime(0, { locale: 'en' })).toBeUndefined();
    expect(formatRuntime(undefined)).toBeUndefined();
    expect(formatRuntime(20)).toBe('1m');
  });

  it('uses Intl.DurationFormat units for other languages', () => {
    const ja = formatRuntime(5580, { locale: 'ja' });
    const de = formatRuntime(2700, { locale: 'de' });
    expect(ja).toContain('時間');
    expect(ja).toContain('33');
    expect(de).toContain('Min');
    expect(de).not.toBe('45m');
  });

  it('falls back to the i18n keys without Intl.DurationFormat or for unsupported locales', () => {
    vi.stubGlobal('Intl', { ...Intl, DurationFormat: undefined });
    expect(formatRuntime(5580, { locale: 'de', t })).toBe('1 Std. 33 Min.');
    expect(formatRuntime(2700, { locale: 'de', t })).toBe('45 Min.');
    expect(formatRuntime(7200, { locale: 'de', t })).toBe('2 Std.');
    vi.unstubAllGlobals();
    resetRuntimeFormatCache();
    // `ary` has no CLDR data: the keys win over the runtime's default locale.
    expect(formatRuntime(2700, { locale: 'ary', t })).toBe('45 Min.');
  });

  it('ships English runtime keys with {{h}}/{{m}} placeholders', async () => {
    const vod = (await import('@/i18n/en/vod.json')).default as Record<string, string>;
    expect(vod.runtimeHoursMinutes).toBe('{{h}}h {{m}}m');
    expect(vod.runtimeHours).toContain('{{h}}');
    expect(vod.runtimeMinutes).toContain('{{m}}');
  });
});
