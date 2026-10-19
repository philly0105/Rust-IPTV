/** Run 3 review (wiring F4): library artwork asks the image cache with its source, so the source's network rules apply. */

import { cleanup, render } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DownloadRow } from '../components/DownloadRow';
import { LibraryCard } from '../components/LibraryCard';
import { buildLibrary } from '../lib/myvideos';
import { makeDownload, makeEpisode } from './fixtures';
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

beforeAll(installDomStubs);
afterEach(cleanup);

const POSTER = 'http://cdn.example.test/poster.jpg';

function imageParams(container: HTMLElement): URLSearchParams {
  const src = container.querySelector('img')?.getAttribute('src') ?? '';
  expect(src.startsWith('/api/img?')).toBe(true);
  return new URL(src, 'http://app.test').searchParams;
}

describe('library artwork goes through the image cache with its source', () => {
  it('a movie card and a series card pass the download source', () => {
    const movie = makeDownload({ ref: { sourceId: 'portal-a', contentType: 'movie', itemId: 'm1' }, title: 'Heat', posterUrl: POSTER, status: 'completed' });
    const episode = makeEpisode('s1', 'Dark', 'S01E01', { ref: { sourceId: 'portal-b', contentType: 'series', itemId: 's1' }, posterUrl: POSTER });
    const entries = buildLibrary([movie, episode]);
    const card = (kind: string) => entries.find((e) => e.kind === kind)!;

    const m = render(
      <I18nextProvider i18n={i18n}>
        <LibraryCard entry={card('movie')} />
      </I18nextProvider>,
    );
    expect(imageParams(m.container).get('sourceId')).toBe('portal-a');
    expect(imageParams(m.container).get('url')).toBe(POSTER);
    m.unmount();

    const s = render(
      <I18nextProvider i18n={i18n}>
        <LibraryCard entry={card('series')} />
      </I18nextProvider>,
    );
    expect(imageParams(s.container).get('sourceId')).toBe('portal-b');
  });

  it('a download row passes its source', () => {
    const d = makeDownload({ ref: { sourceId: 'portal-c', contentType: 'movie', itemId: 'm9' }, posterUrl: POSTER, status: 'queued' });
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <DownloadRow download={d} source={undefined} actions={[]} busy={false} onAction={() => undefined} />
      </I18nextProvider>,
    );
    expect(imageParams(container).get('sourceId')).toBe('portal-c');
  });
});
