/**
 * P2-POSTERS-2: download and favorites/recent rows load their artwork at the width their boxes
 * are given, instead of each picture reading its frame as it mounts (a forced layout per row).
 */

import { cleanup, render } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemRef } from '@/api/types';

import { DownloadRow } from '../components/DownloadRow';
import { EntryRow } from '../components/EntryRow';
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

beforeAll(installDomStubs);
beforeEach(() => {
  pictureReads = [];
  const onPicture = (el: Element) => {
    if (el instanceof HTMLImageElement) pictureReads.push(el);
  };
  for (const prop of ['clientWidth', 'clientHeight'] as const) {
    const get = Object.getOwnPropertyDescriptor(Element.prototype, prop)!.get!;
    vi.spyOn(Element.prototype, prop, 'get').mockImplementation(function (this: Element) {
      onPicture(this);
      return get.call(this) as number;
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
            onOpen={() => undefined}
            onRemove={() => undefined}
          />
        </I18nextProvider>,
      );
      // w-8 (30 px) or w-11 (41.25 px) at 100 %: the 64 px copy.
      expect(widthOf(container)).toBe('64');
      expect(pictureReads).toEqual([]);
    });
  }
});

