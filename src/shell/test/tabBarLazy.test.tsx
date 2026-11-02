/**
 * F1-7: the phone tab bar is its own chunk. A window from 640 px up never loads it; below that
 * its skeleton holds the bar's place until the chunk is in.
 */

import { act, cleanup, configure, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { installDomStubs, makeSource, Page, renderRoutes, rpcMock, settings } from './harness';

configure({ asyncUtilTimeout: 4000 });

const seen = vi.hoisted(() => ({ loads: 0, release: (() => undefined) as () => void }));

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
vi.mock('@/features/player', () => ({ playItem: async () => undefined, restorePlayback: async () => false }));
vi.mock('@/features/player/dock', () => ({ restorePlayback: async () => false, PlayerDock: () => null, ExternalPlaybackFooter: () => null }));
// A stand-in whose chunk "arrives" when the test releases it.
vi.mock('../TabBar', async () => {
  seen.loads += 1;
  await new Promise<void>((resolve) => {
    seen.release = resolve;
  });
  return { TabBar: () => <nav data-testid="tab-bar" /> };
});

const { ShellLayout } = await import('../ShellLayout');
const { PHONE_QUERY } = await import('../navigation');

const routes = [{ path: '/', element: <ShellLayout />, children: [{ path: 'favorites', element: <Page>favorites page</Page> }] }];

function width(phone: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: phone && (query === PHONE_QUERY || query === '(max-width: 1023px)'),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  const h = rpcMock.handlers;
  h['settings.get'] = () => settings();
  h['settings.update'] = (a) => settings((a as { patch: object }).patch);
  h['sources.list'] = () => [makeSource('s1')];
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
});
afterEach(() => {
  cleanup();
  installDomStubs();
});

describe('phone tab bar chunk (F1-7)', () => {
  it('stays unloaded from 640 px up, and shows its skeleton on a phone until the chunk is in', async () => {
    width(false);
    renderRoutes(routes, '/favorites');
    await screen.findByText('favorites page');
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(seen.loads).toBe(0);
    cleanup();

    width(true);
    renderRoutes(routes, '/favorites');
    await screen.findByText('favorites page');
    expect(seen.loads).toBe(1);
    expect(screen.queryByTestId('tab-bar')).toBeNull();
    // The skeleton bar sits where the bar goes: the shell's last row, under the outlet.
    const shell = screen.getByTestId('shell');
    expect(shell.querySelector('[aria-hidden="true"].grid-cols-5')).not.toBeNull();
    act(() => seen.release());
    await screen.findByTestId('tab-bar');
    expect(shell.querySelector('[aria-hidden="true"].grid-cols-5')).toBeNull();
  });
});
