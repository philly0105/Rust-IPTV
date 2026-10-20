/**
 * PL-ERROR-DEAD-ENDS: the error screen offers the step its copy names as a button, and the
 * browser's copy never sends the user to an external player it cannot hand the stream to.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { itemKey, type ItemRef, type PlayerSource } from '@/api/types';
import en from '@/i18n/en/player.json';

const handlers: Record<string, (args: unknown) => unknown> = {};
vi.mock('@/api/transport', () => ({
  rpc: vi.fn(async (name: string, args: unknown) => {
    const h = handlers[name];
    if (!h) throw new Error(`unmocked rpc ${name}`);
    return h(args);
  }),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('../parentalHook', () => ({ ensurePlaybackAllowed: async () => true }));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined }));

const { rpc } = await import('@/api/transport');
const { usePlayerStore, __resetPlayerForTests } = await import('../store');
const { resetMedia } = await import('../media');
const { useAlternatesStore } = await import('../failover');
const { errorActionIds } = await import('./ErrorActions');
const { InlinePlayer } = await import('./InlinePlayer');
const { Controls } = await import('./Controls');
type Ctx = Parameters<typeof errorActionIds>[0];

const live: ItemRef = { sourceId: 's1', contentType: 'live', itemId: '7' };
const movie: ItemRef = { sourceId: 's1', contentType: 'movie', itemId: '42' };
/** A login link: never handed out in the browser. */
const xtreamUrl = 'http://iptv.example.com:8080/demo/secret/12345.mkv';

const fail = (source: PlayerSource, error: string): void => {
  act(() => usePlayerStore.setState({ source, mode: 'inline', status: 'error', error }));
};

function Where() {
  const loc = useLocation();
  return <span data-testid="where">{`${loc.pathname}${loc.search}`}</span>;
}

beforeEach(() => {
  __resetPlayerForTests();
  resetMedia();
  for (const k of Object.keys(handlers)) delete handlers[k];
  vi.mocked(rpc).mockClear();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  __resetPlayerForTests();
  resetMedia();
  useAlternatesStore.setState({ forKey: undefined, status: 'idle', data: undefined });
});

describe('errorActionIds', () => {
  const base: Ctx = {
    cls: 'generic',
    live: false,
    hasMedia: true,
    external: 'none',
    alternates: false,
    menu: true,
    zappable: false,
    refreshable: false,
    hasSource: false,
    rawTs: false,
    rawTsXtream: false,
    routed: true,
  };

  it('a channel the provider does not have: its other copies, then the next channel, then Retry', () => {
    expect(errorActionIds({ ...base, cls: 'notFound', live: true, alternates: true, zappable: true })).toEqual(['otherSources', 'nextChannel', 'retry']);
    expect(errorActionIds({ ...base, cls: 'notFound', live: true, zappable: true })).toEqual(['nextChannel', 'retry']);
  });

  it('a removed movie: Refresh source leads, unless there is nothing to fetch again', () => {
    expect(errorActionIds({ ...base, cls: 'notFound', refreshable: true, hasSource: true })[0]).toBe('refreshSource');
    expect(errorActionIds({ ...base, cls: 'notFound' })).toEqual(['retry']);
  });

  it('a refused stream opens the source; a full account waits first, with no extra connection', () => {
    expect(errorActionIds({ ...base, cls: 'auth', hasSource: true, external: 'app' })).toEqual(['editSource', 'retry', 'openMpv', 'openVlc']);
    expect(errorActionIds({ ...base, cls: 'connectionLimit', hasSource: true, external: 'app' })).toEqual(['retry', 'editSource']);
  });

  it('a format this player cannot decode: another copy or another player before Retry', () => {
    expect(errorActionIds({ ...base, cls: 'unsupported', external: 'app' })).toEqual(['openMpv', 'openVlc', 'retry']);
    expect(errorActionIds({ ...base, cls: 'unsupported', external: 'link', live: true, alternates: true })).toEqual(['otherSources', 'copyLink', 'retry']);
    expect(errorActionIds({ ...base, cls: 'media', external: 'link' })).toEqual(['retry', 'copyLink']);
  });

  it('parental controls, offline, raw TS on Xtream', () => {
    const message = 'catalog item 666 is locked by parental controls; unlock them to open it';
    expect(errorActionIds({ ...base, cls: 'notFound', message })).toEqual(['parental', 'retry']);
    expect(errorActionIds({ ...base, cls: 'offline', external: 'app' })).toEqual(['retry']);
    expect(errorActionIds({ ...base, cls: 'unsupported', rawTs: true, rawTsXtream: true })).toEqual(['playAsHls', 'playbackSettings']);
  });

  it('outside the app router, no page links', () => {
    expect(errorActionIds({ ...base, cls: 'auth', hasSource: true, routed: false })).toEqual(['retry']);
  });

  it('no Other sources where the bar has no options menu to list them in (the compact bar, the mpv PiP window)', () => {
    const live = { ...base, live: true, alternates: true, menu: false };
    expect(errorActionIds({ ...live, cls: 'notFound', zappable: true })).toEqual(['nextChannel', 'retry']);
    expect(errorActionIds({ ...live, cls: 'notFound' })).toEqual(['retry']);
    expect(errorActionIds({ ...live, cls: 'unsupported', external: 'app' })).toEqual(['openMpv', 'openVlc', 'retry']);
  });
});

describe('the error overlay', () => {
  it('in the browser, a movie whose link cannot be shared reads without MPV, VLC or another source', () => {
    render(<InlinePlayer />);
    fail({ url: xtreamUrl, kind: 'direct', title: 'Movie', isLive: false, isRadio: false }, 'codec not supported');
    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('data-error-class')).toBe('unsupported');
    // Retry and the desktop app: what the screen offers, and nothing else.
    expect(alert.textContent).toContain(en.errorUnsupportedBrowserDesktop);
    expect(alert.textContent).not.toMatch(/MPV|VLC|another source/);
    expect(Array.from(screen.getByTestId('error-actions').querySelectorAll('button')).map((b) => b.dataset['action'])).toEqual(['retry']);
    expect(screen.queryByRole('button', { name: 'Copy stream link' })).toBeNull();
  });

  it('in the browser, a channel with copies elsewhere names another source and offers it', () => {
    const source: PlayerSource = { url: 'http://iptv.example.com:8080/live/demo/secret/7.mp4', kind: 'direct', title: 'News', isLive: true, isRadio: false, ref: live };
    useAlternatesStore.setState({
      forKey: itemKey(live),
      status: 'ready',
      data: {
        key: 'news',
        alternates: [
          {
            channel: { ref: { sourceId: 's2', contentType: 'live', itemId: '9' }, name: 'News HD', categoryId: 'c', categoryName: 'News', isRadio: false },
            sourceName: 'Backup',
            sourceKind: 'm3u',
            matchedBy: 'name',
          },
        ],
      },
    });
    render(<InlinePlayer />);
    fail(source, 'codec not supported');
    expect(screen.getByRole('alert').textContent).toContain(en.errorUnsupportedBrowser);
    expect(Array.from(screen.getByTestId('error-actions').querySelectorAll('button')).map((b) => b.dataset['action'])).toEqual(['otherSources', 'retry']);
  });

  it('a live channel the provider lacks: Other sources opens the options menu at the channel’s copies', () => {
    const source: PlayerSource = { url: 'http://h/live/7.mp4', kind: 'direct', title: 'News', isLive: true, isRadio: false, ref: live };
    useAlternatesStore.setState({
      forKey: itemKey(live),
      status: 'ready',
      data: {
        key: 'news',
        alternates: [
          {
            channel: { ref: { sourceId: 's2', contentType: 'live', itemId: '9' }, name: 'News HD', categoryId: 'c', categoryName: 'News', isRadio: false },
            sourceName: 'Backup',
            sourceKind: 'm3u',
            matchedBy: 'name',
          },
        ],
      },
    });
    render(
      <>
        <InlinePlayer />
        <Controls variant="overlay" visible />
      </>,
    );
    fail(source, 'HTTP 404');
    expect(screen.getByRole('alert').getAttribute('data-error-class')).toBe('notFound');
    const actions = screen.getByTestId('error-actions');
    expect(Array.from(actions.querySelectorAll('button')).map((b) => b.dataset['action'])).toEqual(['otherSources', 'nextChannel', 'retry']);
    fireEvent.click(screen.getByRole('button', { name: 'Other sources' }));
    expect(screen.getByTestId('player-options-menu').getAttribute('data-view')).toBe('sources');
  });

  it('Edit source opens the source’s account in Sources', () => {
    render(
      <MemoryRouter initialEntries={['/s/s1/movie/42']}>
        <InlinePlayer />
        <Where />
      </MemoryRouter>,
    );
    fail({ url: 'http://h/m.mp4', kind: 'direct', title: 'Movie', isLive: false, isRadio: false, ref: movie }, 'HTTP 403');
    fireEvent.click(screen.getByRole('button', { name: 'Edit source' }));
    expect(screen.getByTestId('where').textContent).toBe('/sources?account=s1');
  });

  it('Refresh source imports the source again, then looks the item up anew', async () => {
    handlers['sources.refresh'] = () => ({ id: 's1' });
    handlers['sources.get'] = () => ({ id: 's1', kind: 'm3u' });
    handlers['catalog.item'] = () => ({ ref: movie, name: 'Movie', url: 'http://h/moved.mp4' });
    handlers['positions.get'] = () => null;
    render(<InlinePlayer />);
    fail({ url: 'http://h/m.mp4', kind: 'direct', title: 'Movie', isLive: false, isRadio: false, ref: movie }, 'HTTP 404');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh source' }));
    await waitFor(() => expect(usePlayerStore.getState().source?.url).toBe('http://h/moved.mp4'));
    expect(vi.mocked(rpc).mock.calls.some(([name, args]) => name === 'sources.refresh' && (args as { id: string }).id === 's1')).toBe(true);
  });

  it('raw MPEG-TS the browser cannot play, on Xtream: Play as HLS switches the format and plays the item again', async () => {
    const { DEFAULT_SETTINGS } = await import('@/api/types');
    const { setSettingsCache, sourceKindOf } = await import('../store');
    handlers['sources.get'] = () => ({ id: 's1', kind: 'xtream' });
    await sourceKindOf('s1');
    setSettingsCache({ ...DEFAULT_SETTINGS, streamFormat: 'ts' });
    handlers['settings.update'] = (args) => ({ ...DEFAULT_SETTINGS, ...(args as { patch: object }).patch });
    handlers['xtream.streamUrl'] = () => ({ url: 'http://h/m.m3u8', kind: 'hls', title: 'Movie', isLive: false, isRadio: false });
    handlers['positions.get'] = () => null;
    render(
      <MemoryRouter>
        <InlinePlayer />
      </MemoryRouter>,
    );
    fail({ url: 'http://h/m.ts', kind: 'direct', title: 'Movie', isLive: false, isRadio: false, ref: movie }, 'MEDIA_ERR_SRC_NOT_SUPPORTED');
    expect(screen.getByRole('alert').textContent).toContain(en.errorTsXtream);
    const actions = screen.getByTestId('error-actions');
    expect(Array.from(actions.querySelectorAll('button')).map((b) => b.dataset['action'])).toEqual(['playAsHls', 'playbackSettings']);
    fireEvent.click(screen.getByRole('button', { name: 'Play as HLS' }));
    await waitFor(() => expect(usePlayerStore.getState().source?.url).toBe('http://h/m.m3u8'));
    expect(vi.mocked(rpc).mock.calls.find(([name]) => name === 'settings.update')?.[1]).toEqual({ patch: { streamFormat: 'm3u8' } });
  });

  it('Copy details copies the headline and the engine’s words, with the login taken out', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<InlinePlayer />);
    fail({ url: 'http://h/m.mp4', kind: 'direct', title: 'Movie', isLive: false, isRadio: false }, 'HTTP 404 for http://iptv.example.com:8080/live/demo/secret/1.ts');
    fireEvent.click(screen.getByRole('button', { name: 'Copy details' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(copied).toContain(en.errorNotFoundTitle);
    expect(copied).toContain('HTTP 404');
    expect(copied).not.toContain('secret');
  });

  it('a short player leaves Retry to the bar when something better leads', () => {
    const source: PlayerSource = { url: 'http://h/live/7.mp4', kind: 'direct', title: 'News', isLive: true, isRadio: false, ref: live };
    render(<InlinePlayer short />);
    fail(source, 'HTTP 404');
    const actions = screen.getByTestId('error-actions');
    expect(Array.from(actions.querySelectorAll('button')).map((b) => b.dataset['action'])).toEqual(['nextChannel']);
  });
});

describe('the alternate sources submenu (PL-COPY-I18N)', () => {
  it('says what it is doing while it looks for other sources, not "Loading stream"', async () => {
    const { AlternatesMenu } = await import('./AlternateSources');
    act(() =>
      usePlayerStore.setState({
        source: { url: 'http://h/live/7.mp4', kind: 'direct', title: 'News', isLive: true, isRadio: false, ref: live },
        status: 'playing',
      }),
    );
    useAlternatesStore.setState({ forKey: itemKey(live), status: 'loading' });
    render(<AlternatesMenu onDone={() => undefined} />);
    expect(screen.getByRole('status').textContent).toBe(en.alternateSourcesLoading);
    expect(screen.queryByText(en.loading)).toBeNull();
  });
});
