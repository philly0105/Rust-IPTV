import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { rpcMock } from './harness';

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined }));
vi.mock('@/api/query', () => ({ invalidate: () => Promise.resolve() }));

const { RpcError } = await import('@/api/transport');
const { enabledEpgUrls, handleGuideEvent, newlyEnabledEpgUrls, refreshGuides, summarizeGuide, useGuideProgressStore } = await import(
  '../lib/epgRefresh'
);

const links = (detected: string[], manual: string[] = [], disabled: string[] = []) => ({
  detectedUrls: detected,
  manualUrls: manual,
  disabledUrls: disabled,
});

beforeEach(() => {
  rpcMock.reset();
  useGuideProgressStore.setState({ byUrl: {} });
});
afterEach(() => vi.useRealTimers());

describe('enabledEpgUrls / newlyEnabledEpgUrls', () => {
  it('unions detected and manual, drops disabled and duplicates', () => {
    expect(enabledEpgUrls(links(['a', 'b'], ['b', 'c'], ['a']))).toEqual(['b', 'c']);
    expect(enabledEpgUrls(undefined)).toEqual([]);
  });

  it('finds added, re-enabled, and changed detected links', () => {
    const before = links(['http://h/xmltv.php?username=u&password=old'], ['m1'], ['m1']);
    const after = links(['http://h/xmltv.php?username=u&password=new'], ['m1', 'm2'], []);
    expect(newlyEnabledEpgUrls(before, after)).toEqual(['http://h/xmltv.php?username=u&password=new', 'm1', 'm2']);
    expect(newlyEnabledEpgUrls(after, after)).toEqual([]);
  });
});

describe('refreshGuides', () => {
  it('calls epg.refresh { url } once per url and marks each queued', async () => {
    rpcMock.handlers['epg.refresh'] = () => undefined;
    const r = await refreshGuides(['u1', 'u2']);
    expect(rpcMock.callsOf('epg.refresh')).toEqual([{ url: 'u1' }, { url: 'u2' }]);
    expect(r.started).toEqual(['u1', 'u2']);
    expect(useGuideProgressStore.getState().byUrl.u1?.phase).toBe('queued');
  });

  it('treats conflict as already running and reports other failures without throwing', async () => {
    rpcMock.handlers['epg.refresh'] = (a) => {
      const url = (a as { url: string }).url;
      if (url === 'busy') throw new RpcError('conflict', 'already refreshing');
      if (url === 'bad') throw new RpcError('not_found', 'not configured');
      return undefined;
    };
    const r = await refreshGuides(['busy', 'bad', 'ok']);
    expect(r.started).toEqual(['busy', 'ok']);
    expect(r.failed.map((f) => f.url)).toEqual(['bad']);
    expect(useGuideProgressStore.getState().byUrl.bad?.phase).toBe('error');
  });
});

describe('guide progress', () => {
  it('follows epg.progress and summarizes per source', () => {
    handleGuideEvent({ url: 'a', phase: 'fetching', programs: 0 });
    handleGuideEvent({ url: 'b', phase: 'parsing', programs: 1500 });
    let s = summarizeGuide(useGuideProgressStore.getState().byUrl, ['a', 'b', 'c']);
    expect(s).toMatchObject({ active: true, programs: 1500, phase: 'fetching', done: false });

    handleGuideEvent({ url: 'a', phase: 'done', programs: 200 });
    handleGuideEvent({ url: 'b', phase: 'done', programs: 3000 });
    s = summarizeGuide(useGuideProgressStore.getState().byUrl, ['a', 'b']);
    expect(s).toMatchObject({ active: false, done: true, programs: 3200, phase: 'done' });

    expect(summarizeGuide(useGuideProgressStore.getState().byUrl, ['zzz'])).toBeUndefined();
  });

  it('reports a failure when nothing loaded', () => {
    handleGuideEvent({ url: 'a', phase: 'error', programs: 0, message: 'HTTP 404' });
    expect(summarizeGuide(useGuideProgressStore.getState().byUrl, ['a'])).toMatchObject({ active: false, done: false, error: 'HTTP 404' });
  });

  it('drops finished entries after a short linger', () => {
    vi.useFakeTimers();
    handleGuideEvent({ url: 'a', phase: 'done', programs: 1 });
    expect(useGuideProgressStore.getState().byUrl.a).toBeDefined();
    vi.advanceTimersByTime(5000);
    expect(useGuideProgressStore.getState().byUrl.a).toBeUndefined();
  });
});
