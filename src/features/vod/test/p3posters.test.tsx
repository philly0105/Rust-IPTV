/**
 * Third performance pass, posters lane. P2-POSTERS-1: search's tab grids mount their cells at the
 * width they read before having any, hand their posters the column width, and measure their rows
 * in an observer's callback, after the browser's layout, instead of each poster and row reading
 * its box as it mounts. P2-POSTERS-2: the detail pages' episode, Up next and other-source
 * thumbnails load at the width their boxes are given.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Episode, VodItem } from '@/api/types';

import { EpisodeList } from '../components/detail/EpisodeList';
import { OtherSourcesList } from '../components/detail/OtherSourcesDialog';
import { UpNextRail } from '../components/detail/UpNext';
import { forgetSpots } from '../hooks/useScrollMemory';
import { SearchPage } from '../pages/SearchPage';
import { actEnvironment, i18n, installDomStubs, makeSource, renderAt, settings } from './harness';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const call = async (cmd: string, args?: unknown) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { handlers, call };
});

vi.mock('@/api/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/transport')>();
  return {
    ...actual,
    rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
    rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  };
});
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);

const film = (i: number): VodItem => ({
  ref: { sourceId: 'src1', contentType: 'movie', itemId: `f${i}` },
  title: `Film ${i}`,
  categoryId: 'c1',
  posterUrl: `http://cdn.example/f${i}.jpg`,
});

type Entry = { target: Element; borderBoxSize: { inlineSize: number; blockSize: number }[] };

/** A ResizeObserver the test reports to, standing in for the browser's layout. */
class FakeRO {
  static all: FakeRO[] = [];
  readonly targets = new Set<Element>();
  constructor(readonly cb: (entries: Entry[]) => void) {
    FakeRO.all.push(this);
  }
  observe(el: Element) {
    this.targets.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
}

/** Reports `heights` for the observed elements, as the browser does after laying them out. */
function report(heights: Map<Element, number>) {
  for (const ro of FakeRO.all) {
    const entries = [...heights].filter(([el]) => ro.targets.has(el)).map(([target, blockSize]) => ({ target, borderBoxSize: [{ inlineSize: 960, blockSize }] }));
    if (entries.length > 0) ro.cb(entries);
  }
}

/** Every layout read: what was read, and whether the grid had cells then. */
let reads: { el: Element; prop: string }[] = [];

beforeAll(installDomStubs);
beforeEach(() => {
  forgetSpots();
  localStorage.clear();
  FakeRO.all = [];
  vi.stubGlobal('ResizeObserver', FakeRO);
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  h['sources.list'] = () => [makeSource('src1', 'xtream', 'Alpha IPTV')];
  h['settings.get'] = () => settings();
  h['stalker.search'] = () => ({ items: [], total: 0, offset: 0, limit: 14 });
  h['watchlist.list'] = () => [];
  h['positions.watchedContains'] = () => [];
  h['catalog.search'] = () => ({ live: [], movies: Array.from({ length: 60 }, (_, i) => film(i)), series: [] });

  reads = [];
  for (const prop of ['clientWidth', 'clientHeight', 'scrollTop'] as const) {
    const get = Object.getOwnPropertyDescriptor(Element.prototype, prop)!.get!;
    vi.spyOn(Element.prototype, prop, 'get').mockImplementation(function (this: Element) {
      reads.push({ el: this, prop });
      return get.call(this) as number;
    });
  }
  for (const prop of ['offsetWidth', 'offsetHeight'] as const) {
    const get = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop)!.get!;
    vi.spyOn(HTMLElement.prototype, prop, 'get').mockImplementation(function (this: HTMLElement) {
      reads.push({ el: this, prop });
      return get.call(this) as number;
    });
  }
  const rect = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    reads.push({ el: this, prop: 'rect' });
    return rect.call(this);
  });
});
afterEach(() => {
  actEnvironment(true);
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sizeOf = (img: HTMLImageElement) => /[?&]w=(\d+)/.exec(img.getAttribute('src') ?? '')?.[1];
const rowsOf = (grid: HTMLElement) => [...grid.querySelectorAll<HTMLElement>(':scope > [data-index]')];
const offsetOf = (row: HTMLElement) => Number(/translateY\(([-\d.]+)px\)/.exec(row.style.transform)?.[1]);

async function openMovies() {
  renderAt('/search?q=film', [{ path: '/search', element: <SearchPage /> }]);
  await screen.findByText('Film 0');
  const grid = screen.getByTestId('vod-search-movies');
  await waitFor(() => expect(grid.querySelectorAll('img').length).toBeGreaterThan(0));
  return grid;
}

// A search page mounts its header, tabs and a window of cards: room for a loaded runner.
describe('P2-POSTERS-1: search tab grids', { timeout: 20_000 }, () => {
  it('loads its posters at the column width and reads no poster or row as they mount', async () => {
    const grid = await openMovies();
    const imgs = [...grid.querySelectorAll('img')];
    // jsdom lays nothing out, so the grid keeps its 960 px guess: five 164 px (medium) columns
    // with 16 px gaps are 179.2 px wide, the cache's 192 px copy, as the measured frame asked for.
    expect(imgs.map(sizeOf)).toEqual(imgs.map(() => '192'));
    // Neither the pictures nor the rows were read (each forced a layout between the cells' DOM
    // writes), and the grid read its own box only before it had cells.
    expect(reads.filter((r) => r.el instanceof HTMLImageElement || r.el.closest('[data-index]'))).toEqual([]);
    expect(reads.filter((r) => r.el === grid).map((r) => r.prop)).toEqual(['rect', 'clientWidth']);
  });

  it("commits a row's measured height in the observer's callback, so the rows below never show at the estimate", async () => {
    const grid = await openMovies();
    const rows = rowsOf(grid);
    // 179.2 px posters at 2:3 and the caption estimate, plus the gap.
    expect(offsetOf(rows[1]!)).toBeCloseTo(348.8);
    reads = [];
    // The callback comes after the browser's layout and before paint: the new offsets are in the
    // DOM when it returns (act off: updates schedule as in the app), not a frame later.
    actEnvironment(false);
    report(new Map([[rows[0]!, 330]]));
    expect(offsetOf(rows[1]!)).toBe(330);
    expect(offsetOf(rows[2]!)).toBeCloseTo(678.8);
    // The reads in the callback come after layout; nothing reads a row or a picture.
    expect(reads.filter((r) => r.el instanceof HTMLImageElement || r.el.closest('[data-index]'))).toEqual([]);
  });

  it('observes a row mounted inside that callback from the next frame, so the browser raises no loop error', async () => {
    const grid = await openMovies();
    const before = rowsOf(grid);
    const ro = FakeRO.all.find((o) => before.every((row) => o.targets.has(row)))!;
    expect(ro).toBeDefined();
    // Short rows: more of them fit in the 720 px window, and they mount in the callback's commit.
    actEnvironment(false);
    report(new Map(before.map((row) => [row, 120])));
    const added = rowsOf(grid).filter((row) => !before.includes(row));
    expect(added.length).toBeGreaterThan(0);
    expect(added.filter((row) => ro.targets.has(row))).toEqual([]);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(added.filter((row) => !ro.targets.has(row))).toEqual([]);
  });
});

const episode = (n: number): Episode => ({
  id: `e${n}`,
  seriesRef: { sourceId: 's1', contentType: 'series', itemId: 'show' },
  season: 1,
  episode: n,
  title: `Episode ${n}`,
  posterUrl: `http://cdn.example/e${n}.jpg`,
});

function Episodes() {
  const scrollRef = useRef<HTMLDivElement>(null);
  // The scroll box's ref attaches after the list's layout effects; one more render lets the virtualizer find it.
  const [, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div ref={scrollRef}>
      <EpisodeList
        episodes={[episode(1), episode(2), episode(3)]}
        positions={new Map()}
        downloads={new Map()}
        onPlay={() => undefined}
        canDownload={false}
        pendingDownload={null}
        onDownload={() => undefined}
        scrollRef={scrollRef}
      />
    </div>
  );
}

const renderIn = (ui: ReactNode) =>
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>{ui}</MemoryRouter>
    </I18nextProvider>,
  );

/** Every picture's cache width, once the pictures are in the page. */
async function widths(): Promise<(string | undefined)[]> {
  await waitFor(() => expect(document.querySelectorAll('img').length).toBeGreaterThan(0));
  return [...document.querySelectorAll('img')].map(sizeOf);
}
const pictureReads = () => reads.filter((r) => r.el instanceof HTMLImageElement);

describe('P2-POSTERS-2: thumbnails with a known box', () => {
  it("loads an episode's thumbnail at its w-28 width below sm, and at w-40 from sm up, without reading it", async () => {
    const view = renderIn(<Episodes />);
    // 105 px at 100 %: the 128 px copy, as the measured frame asked for.
    expect(await widths()).toEqual(['128', '128', '128']);
    view.unmount();

    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) => ({ matches: query === '(min-width: 40rem)', media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList,
    );
    renderIn(<Episodes />);
    // 150 px from sm up: the 192 px copy.
    expect(await widths()).toEqual(['192', '192', '192']);
    expect(pictureReads()).toEqual([]);
  });

  it("loads Up next's thumbnails at their w-28 width without reading them", async () => {
    renderIn(<UpNextRail episodes={[episode(4), episode(5)]} positions={new Map()} onPlay={() => undefined} />);
    expect(await widths()).toEqual(['128', '128']);
    expect(pictureReads()).toEqual([]);
  });

  it("loads the other sources' thumbnails at their w-10 width without reading them", async () => {
    const copy = (sourceId: string): VodItem => ({ ...film(1), ref: { sourceId, contentType: 'movie', itemId: 'f1' } });
    renderIn(
      <OtherSourcesList
        current={copy('src1')}
        currentSourceName="Alpha IPTV"
        others={[copy('src2')]}
        sources={new Map()}
        pin={undefined}
        onPin={() => undefined}
        onPlay={() => undefined}
        onOpen={() => undefined}
      />,
    );
    // 37.5 px at 100 %: the 64 px copy.
    expect(await widths()).toEqual(['64', '64']);
    expect(pictureReads()).toEqual([]);
  });
});
