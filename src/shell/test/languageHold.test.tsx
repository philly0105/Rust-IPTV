/**
 * F10: on a fresh profile (no language in localStorage) the shell must not
 * paint English while the server's settings.language is still loading. This
 * file has its own module graph, so the i18n module starts with nothing
 * remembered. Tests run in order: the language stays unresolved until one of
 * them applies a language.
 */
import { act, cleanup, screen, waitFor, configure } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { installDomStubs, Page, renderRoutes, rpcMock, settings } from './harness';

// Under CPU load (a cargo build alongside) the 1 s findBy/waitFor default and the 5 s test default
// time out before the mocked queries settle; these waits only ever succeed, so give them room.
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
  onConnectionState: () => () => undefined,
}));
vi.mock('@/features/player', () => ({
  playItem: async () => {},
  restorePlayback: async () => false,
  PlayerDock: () => null,
  ExternalPlaybackFooter: () => null,
}));

localStorage.clear();
const { ShellLayout } = await import('../ShellLayout');
const { LANGUAGE_HOLD_MAX_MS } = await import('../effects');
const i18n = await import('@/i18n');

const routes = () => [{ path: '/', element: <ShellLayout />, children: [{ path: 'favorites', element: <Page>page body</Page> }] }];

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function baseHandlers(settingsGet: () => unknown) {
  rpcMock.reset();
  rpcMock.handlers['settings.get'] = settingsGet;
  rpcMock.handlers['settings.update'] = (a) => settings((a as { patch: object }).patch);
  rpcMock.handlers['sources.list'] = () => [];
}

/** True when nothing readable (visible text or accessible names) is on screen. */
function textFree(): boolean {
  const named = document.body.querySelectorAll('[aria-label], [title], [placeholder]');
  return (document.body.textContent ?? '').trim() === '' && named.length === 0;
}

beforeAll(installDomStubs);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('first render on a fresh profile', () => {
  it('starts unresolved when localStorage holds no language', () => {
    expect(i18n.languageUnresolved()).toBe(true);
  });

  it('shows a text-free skeleton, then English, when settings fail', async () => {
    const pending = deferred<unknown>();
    baseHandlers(() => pending.promise);
    renderRoutes(routes(), '/favorites');
    expect(screen.getByTestId('shell-skeleton')).toBeTruthy();
    expect(screen.queryByTestId('shell')).toBeNull();
    expect(textFree()).toBe(true);

    await act(async () => pending.reject({ code: 'network', message: 'down' }));
    expect(await screen.findByText('page body')).toBeTruthy();
    expect(screen.getByText('Skip to content')).toBeTruthy();
    expect(i18n.languageUnresolved()).toBe(true);
  });

  it('gives up waiting after LANGUAGE_HOLD_MAX_MS when settings hang', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    baseHandlers(() => new Promise(() => undefined));
    renderRoutes(routes(), '/favorites');
    expect(screen.getByTestId('shell-skeleton')).toBeTruthy();
    await act(async () => vi.advanceTimersByTime(LANGUAGE_HOLD_MAX_MS - 100));
    expect(screen.getByTestId('shell-skeleton')).toBeTruthy();
    await act(async () => vi.advanceTimersByTime(200));
    expect(screen.queryByTestId('shell-skeleton')).toBeNull();
    expect(screen.getByText('page body')).toBeTruthy();
  });

  it('holds until the server language is active, so the first text is German', async () => {
    const pending = deferred<unknown>();
    baseHandlers(() => pending.promise);
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      const skip = document.querySelector('a[href="#main"]');
      if (skip?.textContent) seen.push(skip.textContent);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    renderRoutes(routes(), '/favorites');
    expect(textFree()).toBe(true);
    await act(async () => pending.resolve(settings({ language: 'de' })));

    await waitFor(() => expect(screen.queryByTestId('shell')).toBeTruthy());
    observer.disconnect();
    expect(screen.getByText('Zum Inhalt springen')).toBeTruthy();
    expect(screen.queryByText('Skip to content')).toBeNull();
    // Never an English frame on the way.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((t) => t === 'Zum Inhalt springen')).toBe(true);
    expect(i18n.languageUnresolved()).toBe(false);
    expect(localStorage.getItem('tsrust.language')).toBe('de');
  });

  it('does not hold again once the language is known', () => {
    baseHandlers(() => new Promise(() => undefined));
    renderRoutes(routes(), '/favorites');
    expect(screen.queryByTestId('shell-skeleton')).toBeNull();
    expect(screen.getByText('page body')).toBeTruthy();
    void i18n.applyLanguage('en');
  });
});
