/**
 * P2-BOOT-1: on a fresh profile (no language in localStorage) whose settings name the language on
 * screen (English, which i18next starts in), the shell settles in the render that has them: from
 * the first render when the boot prefetch already brought them, else in the render that brings
 * them. Neither waits for applyLanguage, which never resolves here, so the language stays
 * unresolved for the whole file. A language that still has to load keeps the hold (F10,
 * languageHold.test.tsx). This file has its own module graph, so the i18n module starts with
 * nothing remembered.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { queryClient, rpcKey } from '@/api/query';

import { installDomStubs, Page, renderRoutes, rpcMock, settings } from './harness';

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
vi.mock('@/i18n', async (orig) => ({
  ...(await orig<typeof import('@/i18n')>()),
  applyLanguage: () => new Promise<void>(() => undefined),
}));

localStorage.clear();
const { ShellLayout } = await import('../ShellLayout');
const i18n = await import('@/i18n');

const routes = () => [{ path: '/', element: <ShellLayout />, children: [{ path: 'favorites', element: <Page>page body</Page> }] }];

const SKELETON = '[data-testid="shell-skeleton"]';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function baseHandlers() {
  rpcMock.reset();
  rpcMock.handlers['settings.update'] = (a) => settings((a as { patch: object }).patch);
  rpcMock.handlers['sources.list'] = () => [];
}

/** The shell at `/favorites` with `settings.get` already answered, as the boot prefetch leaves it. */
function renderWithSettings(language: string) {
  baseHandlers();
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
  queryClient.setQueryData(rpcKey('settings.get'), settings({ language }));
  const router = createMemoryRouter(routes(), { initialEntries: ['/favorites'] });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/**
 * Whether the skeleton was in the DOM at any point since `observer` started, also when a later
 * commit in the same act swapped it out (it then shows up among the removed nodes).
 */
function skeletonCommitted(observer: MutationObserver): boolean {
  return observer
    .takeRecords()
    .some((r) => [...r.addedNodes, ...r.removedNodes].some((n) => n instanceof Element && (n.matches(SKELETON) || !!n.querySelector(SKELETON))));
}

beforeAll(installDomStubs);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('first render on a fresh profile', () => {
  it('holds for a language that still has to load', () => {
    expect(i18n.languageUnresolved()).toBe(true);
    renderWithSettings('de');
    expect(screen.getByTestId('shell-skeleton')).toBeTruthy();
    expect(screen.queryByTestId('shell')).toBeNull();
    expect(i18n.languageActive('de')).toBe(false);
  });

  it('renders the shell at once when the language is already on screen', () => {
    expect(i18n.languageUnresolved()).toBe(true);
    expect(i18n.languageActive('en')).toBe(true);
    const observer = new MutationObserver(() => undefined);
    observer.observe(document.body, { childList: true, subtree: true });
    renderWithSettings('en');
    // The first commit is the shell: no skeleton, not even one swapped out by an effect in the act.
    expect(skeletonCommitted(observer)).toBe(false);
    observer.disconnect();
    expect(screen.getByTestId('shell')).toBeTruthy();
    expect(screen.getByText('Skip to content')).toBeTruthy();
    expect(screen.getByText('page body')).toBeTruthy();
  });

  it('settles in the render that brings settings naming the language on screen', async () => {
    // Fake timers, so the LANGUAGE_HOLD_MAX_MS fallback cannot be what lets the shell through.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = deferred<unknown>();
    baseHandlers();
    rpcMock.handlers['settings.get'] = () => pending.promise;
    renderRoutes(routes(), '/favorites');
    expect(screen.getByTestId('shell-skeleton')).toBeTruthy();

    await act(async () => {
      pending.resolve(settings({ language: 'en' }));
      // Query results reach their observers through a setTimeout(0); far short of the fallback.
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(i18n.languageUnresolved()).toBe(true);
    expect(screen.queryByTestId('shell-skeleton')).toBeNull();
    expect(screen.getByText('Skip to content')).toBeTruthy();
    expect(screen.getByText('page body')).toBeTruthy();
  });
});
