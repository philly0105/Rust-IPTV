/**
 * P2-POSTERS-4: the top channels and titles load their artwork at the w-10 frame's width instead
 * of each picture reading its frame as it mounts.
 */
import { cleanup, render } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpc: async () => undefined,
  rpcRaw: async () => undefined,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));

const h = await import('./harness');
const { TopChannels, TopTitles } = await import('../components/TopList');

/** Pictures whose box was read. */
let pictureReads: Element[] = [];

beforeAll(h.installDomStubs);
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

const widths = (container: HTMLElement) => [...container.querySelectorAll('img')].map((img) => new URL(img.getAttribute('src') ?? '', 'http://app.test').searchParams.get('w'));

describe('P2-POSTERS-4: top lists', () => {
  it("load their artwork at the frame's width without reading it", () => {
    const { container } = render(
      <I18nextProvider i18n={h.i18n}>
        <MemoryRouter>
          <TopChannels items={[h.topItem(h.ref('live', 'c1'), 'News', 600, { posterUrl: 'http://cdn.example.test/news.png' })]} canPlay={() => false} onPlay={() => undefined} />
          <TopTitles items={[h.topItem(h.ref('movie', 'm1'), 'Heat', 600, { posterUrl: 'http://cdn.example.test/heat.jpg' })]} />
        </MemoryRouter>
      </I18nextProvider>,
    );
    // 37.5 px at 100 %: the 64 px copy.
    expect(widths(container)).toEqual(['64', '64']);
    expect(pictureReads).toEqual([]);
  });
});
