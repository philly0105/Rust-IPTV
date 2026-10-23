/**
 * P2-POSTERS-2: a My List row loads its artwork at the width its box is given, instead of the
 * picture reading its frame as it mounts (a forced layout per row).
 */

import { cleanup, render } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { MyListRow } from '../components/MyListRow';
import { i18n, installDomStubs } from './harness';

vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpc: async () => undefined,
  rpcRaw: async () => undefined,
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));

/** Pictures whose box was read. */
let pictureReads: Element[] = [];

beforeAll(installDomStubs);
beforeEach(() => {
  pictureReads = [];
  for (const prop of ['clientWidth', 'clientHeight'] as const) {
    const get = Object.getOwnPropertyDescriptor(Element.prototype, prop)!.get!;
    vi.spyOn(Element.prototype, prop, 'get').mockImplementation(function (this: Element) {
      if (this instanceof HTMLImageElement) pictureReads.push(this);
      return get.call(this) as number;
    });
  }
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('P2-POSTERS-2: My List rows', () => {
  it("load their artwork at the box's width without reading it", () => {
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <MyListRow
          entry={{
            ref: { sourceId: 's1', contentType: 'movie', itemId: 'm1' },
            snapshot: { title: 'Heat', contentType: 'movie', posterUrl: 'http://cdn.example.test/heat.jpg' },
            addedAt: '2026-10-01T00:00:00Z',
            watched: false,
          }}
          added="Oct 1"
          addedTitle="Added on October 1"
          busy={false}
          onOpen={() => undefined}
          onRemove={() => undefined}
          onToggleWatched={() => undefined}
        />
      </I18nextProvider>,
    );
    const src = container.querySelector('img')?.getAttribute('src') ?? '';
    // sm:w-14, 52.5 px at 100 % (no matchMedia here, so the wide layout): the 64 px copy.
    expect(new URL(src, 'http://app.test').searchParams.get('w')).toBe('64');
    expect(pictureReads).toEqual([]);
  });
});
