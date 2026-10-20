/**
 * The Sources page renders exactly one h1 in every state, and its text equals
 * the title the page puts in the shell header (C16).
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { eagerRoutes, installDomStubs, makeSource, pending, renderAt, rpcMock } from './harness';

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

const sourcesRoutes = await eagerRoutes((await import('../routes')).sourcesRoutes);
const { RpcError } = await import('@/api/transport');
const { useShellStore } = await import('@/shell');

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  useShellStore.setState({ header: null });
});
afterEach(cleanup);

/** Exactly one h1, and it reads the same as the header title. */
async function expectSingleH1() {
  await waitFor(() => expect(useShellStore.getState().header?.title).toBe('Sources'));
  const h1s = screen.getAllByRole('heading', { level: 1 });
  expect(h1s).toHaveLength(1);
  expect(h1s[0]!.textContent).toBe(useShellStore.getState().header?.title);
}

describe('/sources has one h1', () => {
  it('with sources', async () => {
    rpcMock.handlers['sources.list'] = () => [makeSource('a'), makeSource('b')];
    renderAt(sourcesRoutes, '/sources');
    await screen.findByTestId('sources-list');
    await expectSingleH1();
  });

  it('while loading', async () => {
    rpcMock.handlers['sources.list'] = pending;
    renderAt(sourcesRoutes, '/sources');
    await screen.findByTestId('sources-loading');
    await expectSingleH1();
  });

  it('on first run (onboarding)', async () => {
    rpcMock.handlers['sources.list'] = () => [];
    renderAt(sourcesRoutes, '/sources');
    await screen.findByTestId('sources-onboarding');
    await expectSingleH1();
  });

  it('on error', async () => {
    rpcMock.handlers['sources.list'] = () => {
      throw new RpcError('io', 'database locked');
    };
    renderAt(sourcesRoutes, '/sources');
    await screen.findByRole('button', { name: /try again/i });
    await expectSingleH1();
  });

  it('with the add dialog open from a deep link', async () => {
    rpcMock.handlers['sources.list'] = () => [];
    renderAt(sourcesRoutes, '/sources?add=1&kind=m3u');
    await screen.findByRole('dialog');
    await expectSingleH1();
  });
});
