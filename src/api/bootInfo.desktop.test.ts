/**
 * L2-perf-desktop-10: a desktop launch sends `app.info` once. The image cache
 * base, the loopback proxy base and the query cache all come from that one
 * answer, so the onboarding host, What's new and About never ask again.
 */

import { describe, expect, it, vi } from 'vitest';

const INFO = {
  version: '9.9.9',
  dataDir: 'C:/d',
  platform: 'windows',
  isDesktop: true,
  logFile: 'C:/d/log.txt',
  proxyBase: 'http://127.0.0.1:5555/9f8e7d6c5b4a39281706f5e4d3c2b1a098765432/api/proxy',
  updaterAvailable: false,
};

const invoke = vi.fn(async (_cmd: string, args: { cmd: string }) => (args.cmd === 'app.info' ? INFO : null));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: { cmd: string }) => invoke(cmd, args),
  convertFileSrc: (p: string) => `http://asset.localhost/${encodeURIComponent(p)}`,
}));
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};

const images = await import('./images');
const transport = await import('./transport');
const { queryClient, rpcKey } = await import('./query');

describe('app.info at desktop startup', () => {
  it('is requested once and feeds the image base, the proxy base and the query cache', async () => {
    await images.imageBaseReady(60_000);
    const appInfoCalls = () => invoke.mock.calls.filter(([, a]) => a.cmd === 'app.info').length;
    expect(appInfoCalls()).toBe(1);
    expect(images.imageCacheBase()).toBe('http://127.0.0.1:5555/9f8e7d6c5b4a39281706f5e4d3c2b1a098765432/api/img');
    expect(transport.proxiedUrl({ url: 'http://cdn.example/a.m3u8', kind: 'hls', title: 't', isLive: true, isRadio: false })).toMatch(
      /^http:\/\/127\.0\.0\.1:5555\/9f8e7d6c5b4a39281706f5e4d3c2b1a098765432\/api\/proxy\?/,
    );
    // Seeded before the first render (main.tsx waits on imageBaseReady), so a reader finds it fresh.
    expect(queryClient.getQueryData(rpcKey('app.info'))).toEqual(INFO);
    await queryClient.fetchQuery({ queryKey: rpcKey('app.info'), queryFn: () => transport.rpc('app.info') });
    expect(appInfoCalls()).toBe(1);
  });
});
