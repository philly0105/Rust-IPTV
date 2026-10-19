import { act, cleanup, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { queryClient } from '@/api/query';

import { makeSource, rpcMock, settings } from './harness';

// L2-shell-4: main.tsx asks for settings and sources before the router mounts, into the
// cache entries the shell's own queries read, so they join it instead of asking again.
const gate = vi.hoisted(() => {
  let open!: () => void;
  const ready = new Promise<void>((r) => (open = r));
  return { ready, open };
});

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
// The language load holds the first render, like a slow locale fetch would.
vi.mock('@/i18n', () => ({ initI18n: () => gate.ready }));
vi.mock('@/api/images', () => ({ imageBaseReady: async () => undefined }));
vi.mock('@/api/window', () => ({ bindWindowFullscreen: () => undefined }));
vi.mock('@/App', async () => {
  const { useSettings } = await import('@/shell/useSettings');
  const { useVisibleSources } = await import('@/shell/useVisibleSources');
  function Reader() {
    const s = useSettings();
    const src = useVisibleSources();
    return <div>{s.data && src.data ? `ready ${src.data.length}` : 'waiting'}</div>;
  }
  return {
    App: () => (
      <QueryClientProvider client={queryClient}>
        <Reader />
      </QueryClientProvider>
    ),
  };
});

beforeAll(() => {
  rpcMock.reset();
  rpcMock.handlers['settings.get'] = () => settings();
  rpcMock.handlers['sources.list'] = () => [makeSource('s1')];
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
});
afterAll(() => {
  cleanup();
  document.getElementById('root')?.remove();
});

describe('L2-shell-4: startup data is asked for before the first render', () => {
  it('sends settings.get and sources.list at once, and the shell reads them without a second request', async () => {
    await import('@/main');
    // Before i18n settles and anything renders.
    expect(
      rpcMock.calls
        .map((c) => c.cmd)
        .slice(0, 2)
        .sort(),
    ).toEqual(['settings.get', 'sources.list']);
    await act(async () => {
      gate.open();
      await gate.ready;
    });
    expect(await screen.findByText('ready 1')).toBeTruthy();
    expect(rpcMock.calls.filter((c) => c.cmd === 'settings.get')).toHaveLength(1);
    expect(rpcMock.calls.filter((c) => c.cmd === 'sources.list')).toHaveLength(1);
    // Once both answered, `/` opens Home, whose rail queries started too (performance audit SH-3).
    expect(rpcMock.calls.map((c) => c.cmd)).toContain('positions.continueWatching');
  });
});
