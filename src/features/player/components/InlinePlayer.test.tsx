import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

vi.mock('@/api/transport', () => ({
  rpc: vi.fn(() => Promise.reject(new Error('offline'))),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));
// The parental gate has its own tests (parentalHook.test.ts); here everything may play.
vi.mock('../parentalHook', () => ({ ensurePlaybackAllowed: async () => true }));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined }));

const { usePlayerStore, __resetPlayerForTests } = await import('../store');
const { useMediaStore, resetMedia } = await import('../media');
const { InlinePlayer } = await import('./InlinePlayer');

/** No media URL: the overlay is under test, not an engine. */
const placeholder = { url: '', kind: 'direct' as const, title: 'Movie', isLive: false, isRadio: false };

const fail = (error: string): void => {
  act(() => usePlayerStore.setState({ source: placeholder, mode: 'inline', status: 'error', error }));
};

let online = true;

beforeEach(() => {
  __resetPlayerForTests();
  resetMedia();
  online = true;
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  __resetPlayerForTests();
  resetMedia();
});

describe('stream error overlay', () => {
  it('says the provider refused the stream for a 403, with Retry', () => {
    render(<InlinePlayer />);
    fail('HTTP 403');
    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('data-error-class')).toBe('auth');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('The provider refused this stream');
    expect(alert.textContent).toContain('HTTP 403');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('uses the RPC error code when the message says nothing useful', () => {
    render(<InlinePlayer />);
    act(() => useMediaStore.setState({ errorCode: 'timeout' }));
    fail('request failed');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('The stream timed out');
  });

  it('without a stream URL there is no link to copy or hand to another player', () => {
    render(<InlinePlayer />);
    fail('HTTP 404');
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull();
  });

  it.each([
    ['an Xtream login link', 'http://iptv.example.com:8080/demo/secret/12345.mkv', false],
    ['a link with a password parameter', 'http://h/movie.mp4?%70assword=secret', false],
    ['a plain link', 'http://cdn.example.com/movies/clip.mp4', true],
  ])('Copy stream link shows for %s only when the link is shareable', (_name, url, shown) => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    render(<InlinePlayer />);
    act(() =>
      usePlayerStore.setState({
        source: { ...placeholder, url },
        mode: 'inline',
        status: 'error',
        error: 'HTTP 404',
      }),
    );
    expect(!!screen.queryByRole('button', { name: 'Copy stream link' })).toBe(shown);
  });

  it('the mini player shows the headline and Retry only', () => {
    render(<InlinePlayer compact />);
    fail('HTTP 404');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('This stream no longer exists');
    expect(alert.textContent).not.toContain('Refresh the source');
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('offline: says so, and retries by itself when the connection is back', () => {
    online = false;
    render(<InlinePlayer />);
    fail('fragLoadError');
    expect(screen.getByRole('alert').getAttribute('data-error-class')).toBe('offline');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('You are offline');

    online = true;
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(usePlayerStore.getState().status).toBe('loading');
  });

  it('Retry after a failed stream lookup looks the stream up again', async () => {
    const { playItem } = await import('../store');
    render(<InlinePlayer />);
    await act(async () => {
      await playItem({ ref: { sourceId: 's1', contentType: 'movie', itemId: '1' }, title: 'Movie', isLive: false, sourceKind: 'xtream' }).catch(
        () => undefined,
      );
    });
    expect(usePlayerStore.getState().status).toBe('error');
    const { rpc } = await import('@/api/transport');
    const before = vi.mocked(rpc).mock.calls.filter((c) => c[0] === 'xtream.streamUrl').length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(vi.mocked(rpc).mock.calls.filter((c) => c[0] === 'xtream.streamUrl').length).toBe(before + 1);
  });
});
