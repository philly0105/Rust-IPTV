/**
 * P2-POSTERS-2: download and favorites/recent rows load their artwork at the width their boxes
 * are given, instead of each picture reading its frame as it mounts (a forced layout per row).
 * P2-POSTERS-3: the card grid (My videos, My List) mounts its cards at the width it read before
 * having any, and hands their posters the column width. P2-POSTERS-4: so does a history row
 * with a saved spot (it was the continue rail).
 */

import { cleanup, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemRef } from '@/api/types';
import { Poster } from '@/ui/Poster';

import { DownloadRow } from '../components/DownloadRow';
import { EntryRow } from '../components/EntryRow';
import { VirtualCardGrid } from '../components/VirtualCardGrid';
import { makeDownload } from './fixtures';
import { i18n, installDomStubs } from './harness';

vi.mock('@/api/transport', () => ({
  rpc: async () => undefined,
  rpcRaw: async () => undefined,
  isDesktop: false,
  RpcError: class RpcError extends Error {},
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/shell', async () => (await import('./harness')).shellModule);
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);

const POSTER = 'http://cdn.example.test/poster.jpg';

/** Pictures whose box was read. */
let pictureReads: Element[] = [];
/** The width jsdom reports for an element (it lays nothing out: 0 unless set here). */
let laidOut: (el: Element) => number | undefined = () => undefined;

beforeAll(installDomStubs);
beforeEach(() => {
  pictureReads = [];
  laidOut = () => undefined;
  const onPicture = (el: Element) => {
    if (el instanceof HTMLImageElement) pictureReads.push(el);
  };
  for (const prop of ['clientWidth', 'clientHeight'] as const) {
    const get = Object.getOwnPropertyDescriptor(Element.prototype, prop)!.get!;
    vi.spyOn(Element.prototype, prop, 'get').mockImplementation(function (this: Element) {
      onPicture(this);
      return (prop === 'clientWidth' ? laidOut(this) : undefined) ?? (get.call(this) as number);
    });
  }
  const rect = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    onPicture(this);
    return rect.call(this);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const widthOf = (container: HTMLElement) => new URL(container.querySelector('img')?.getAttribute('src') ?? '', 'http://app.test').searchParams.get('w');

describe('P2-POSTERS-2: library rows', () => {
  it("a download row loads its artwork at its box's width without reading it", () => {
    const d = makeDownload({ ref: { sourceId: 'portal-c', contentType: 'movie', itemId: 'm9' }, posterUrl: POSTER, status: 'queued' });
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <DownloadRow download={d} source={undefined} actions={[]} busy={false} onAction={() => undefined} />
      </I18nextProvider>,
    );
    // sm:w-12, 45 px at 100 % (no matchMedia here, so the wide layout): the 64 px copy.
    expect(widthOf(container)).toBe('64');
    expect(pictureReads).toEqual([]);
  });

  for (const contentType of ['movie', 'live'] as ItemRef['contentType'][]) {
    it(`a ${contentType} favorites row loads its artwork at its box's width without reading it`, () => {
      const { container } = render(
        <I18nextProvider i18n={i18n}>
          <EntryRow
            entryRef={{ sourceId: 's1', contentType, itemId: 'i1' }}
            snapshot={{ title: 'BBC One', contentType, posterUrl: POSTER }}
            showSource={false}
            time="Today"
            removeLabel="Remove BBC One"
            menuRemoveLabel="Remove from favorites"
            onOpen={() => undefined}
            onRemove={() => undefined}
          />
        </I18nextProvider>,
      );
      // A w-8 poster (30 px) or the 40 px logo tile at 100 %: the 64 px copy.
      expect(widthOf(container)).toBe('64');
      expect(pictureReads).toEqual([]);
    });
  }
});

type Film = { id: string; src: string };
const films = Array.from({ length: 12 }, (_, i): Film => ({ id: `f${i}`, src: `http://cdn.example.test/f${i}.jpg` }));

function Grid() {
  return (
    <VirtualCardGrid<Film>
      items={films}
      itemKey={(f) => f.id}
      label="Films"
      cardLabel={(f) => f.id}
      onActivate={() => undefined}
      render={(f) => <Poster src={f.src} alt="" label={f.id} aspect="poster" />}
      postersFillCells
      testId="cards"
    />
  );
}

const widthsIn = (container: HTMLElement) => [...container.querySelectorAll('img')].map((img) => new URL(img.getAttribute('src') ?? '', 'http://app.test').searchParams.get('w'));

describe('P2-POSTERS-3: the card grid', () => {
  it('loads its posters at the column width without reading them', () => {
    const { container } = render(<Grid />);
    // jsdom lays nothing out, so the grid keeps its 1024 px guess: five 168 px columns with 20 px
    // gaps are 188.8 px wide, the 192 px copy.
    const widths = widthsIn(container);
    expect(widths.length).toBeGreaterThan(0);
    expect(widths).toEqual(widths.map(() => '192'));
    expect(pictureReads).toEqual([]);
  });

  it("takes the list's width inside the scroller's padding", () => {
    // A 1050 px scroller with 7.5 px of padding on each side (My List's px-2): five columns of
    // 191 px, not the 194 px the scroller's width gives, which the cache would serve at 256 px.
    laidOut = (el) => (el.getAttribute('data-testid') === 'cards' ? 1050 : el.getAttribute('role') === 'list' ? 1035 : undefined);
    const { container } = render(<Grid />);
    expect(screen.getByRole('list').querySelectorAll('[role="listitem"]').length).toBeGreaterThan(0);
    const widths = widthsIn(container);
    expect(widths).toEqual(widths.map(() => '192'));
    expect(pictureReads).toEqual([]);
  });

  it('fits its columns inside that padding, so a phone gets the three posters a category grid has', () => {
    // A 390 px phone: the scroller is 374 px, the list inside My List's px-2 359 px. With the phone's
    // 80 px column and the 16 px gap, the scroller's width fitted four 79 px posters a row.
    laidOut = (el) => (el.getAttribute('data-testid') === 'cards' ? 374 : el.getAttribute('role') === 'list' ? 359 : undefined);
    render(
      <VirtualCardGrid<Film>
        items={films}
        itemKey={(f) => f.id}
        label="Films"
        cardLabel={(f) => f.id}
        onActivate={() => undefined}
        render={(f) => <Poster src={f.src} alt="" label={f.id} aspect="poster" />}
        postersFillCells
        minColumnWidth={80}
        gap={16}
        testId="cards"
      />,
    );
    const row = screen.getByRole('list').querySelector<HTMLElement>('[role="listitem"]')!.parentElement!;
    expect(row.style.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))');
  });
});

describe('P2-POSTERS-4: a title stopped part way', () => {
  it("loads its artwork at the row's art width without reading it, as the other history rows do", () => {
    // Recently watched had Continue watching cards with 150 px posters; the title is now one row.
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <EntryRow
          entryRef={{ sourceId: 's1', contentType: 'movie', itemId: 'm1' }}
          snapshot={{ title: 'Heat', contentType: 'movie', posterUrl: POSTER }}
          showSource={false}
          time="Today"
          removeLabel="Remove Heat from history"
          menuRemoveLabel="Remove from history"
          resume={{ fraction: 0.1, minutesLeft: 90, label: 'Continue Heat at 10:00', onDetails: () => undefined, onForget: () => undefined }}
          onOpen={() => undefined}
          onRemove={() => undefined}
        />
      </I18nextProvider>,
    );
    // A w-8 poster (30 px at 100 %): the 64 px copy.
    expect(widthOf(container)).toBe('64');
    expect(pictureReads).toEqual([]);
  });
});
