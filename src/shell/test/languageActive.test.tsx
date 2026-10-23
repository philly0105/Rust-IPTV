/**
 * P2-BOOT-1: on a fresh profile (no language in localStorage) whose settings, already in from the
 * boot prefetch, name the language on screen (English, which i18next starts in), the shell's
 * first render is the shell: no skeleton commit while applyLanguage runs. A language that still
 * has to load keeps the hold (F10, languageHold.test.tsx). This file has its own module graph, so
 * the i18n module starts with nothing remembered; German never finishes loading here, so the
 * language stays unresolved until the English test applies it.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { queryClient, rpcKey } from '@/api/query';

import { installDomStubs, Page, rpcMock, settings } from './harness';

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
vi.mock('@/i18n/lazyLocales', () => ({ languageLoaders: { './de/index.ts': () => new Promise(() => undefined) } }));

localStorage.clear();
const { ShellLayout } = await import('../ShellLayout');
const i18n = await import('@/i18n');

/** The shell at `/favorites` with `settings.get` already answered, as the boot prefetch leaves it. */
function renderWithSettings(language: string) {
  rpcMock.reset();
  rpcMock.handlers['settings.update'] = (a) => settings((a as { patch: object }).patch);
  rpcMock.handlers['sources.list'] = () => [];
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
  queryClient.setQueryData(rpcKey('settings.get'), settings({ language }));
  const router = createMemoryRouter([{ path: '/', element: <ShellLayout />, children: [{ path: 'favorites', element: <Page>page body</Page> }] }], {
    initialEntries: ['/favorites'],
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeAll(installDomStubs);
afterEach(cleanup);

describe('first render on a fresh profile with settings in', () => {
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
    renderWithSettings('en');
    // Right after the first commit, before applyLanguage has resolved: no skeleton in between.
    expect(screen.getByTestId('shell')).toBeTruthy();
    expect(screen.queryByTestId('shell-skeleton')).toBeNull();
    expect(screen.getByText('Skip to content')).toBeTruthy();
    expect(screen.getByText('page body')).toBeTruthy();
  });
});
