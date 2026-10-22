import { afterEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.fn((_cmd: string, _args?: unknown) => Promise.resolve(undefined));
vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock(cmd, args),
}));

const { bindPlaybackReport, playingSource, reportAnswered, RENEW_MS, REPORT_WAIT_MS } = await import('./playbackReport');
const { usePlayerStore } = await import('./store');

const ref = (sourceId: string) => ({ sourceId, contentType: 'live' as const, itemId: '1' });
const live = (sourceId: string) => ({ url: `http://x/${sourceId}`, kind: 'hls' as const, title: 'One', isLive: true, isRadio: false, ref: ref(sourceId) });
const reports = () => rpcMock.mock.calls.filter(([cmd]) => cmd === 'downloads.playback').map(([, args]) => (args as { sourceIds: string[] }).sourceIds);

describe('playback report', () => {
  afterEach(() => {
    vi.useRealTimers();
    rpcMock.mockClear();
    usePlayerStore.setState({ source: undefined, status: 'idle', error: undefined });
  });

  it('names the source a stream holds a connection to', () => {
    expect(playingSource({ source: live('a'), status: 'loading' })).toBe('a');
    expect(playingSource({ source: live('a'), status: 'paused' })).toBe('a');
    // A zap placeholder (no URL yet) keeps its source.
    expect(playingSource({ source: { ...live('a'), url: '' }, status: 'loading' })).toBe('a');
    expect(playingSource({ source: live('a'), status: 'error' })).toBeUndefined();
    expect(playingSource({ source: live('a'), status: 'idle' })).toBeUndefined();
    expect(playingSource({ source: { ...live('a'), kind: 'file' }, status: 'playing' })).toBeUndefined();
    expect(playingSource({ source: { ...live('a'), ref: undefined }, status: 'playing' })).toBeUndefined();
  });

  it('reports a change of source, renews while playing, and clears on stop', () => {
    vi.useFakeTimers();
    const unbind = bindPlaybackReport();
    expect(reports()).toEqual([]);
    usePlayerStore.setState({ source: live('a'), status: 'loading' });
    usePlayerStore.setState({ status: 'playing' });
    expect(reports()).toEqual([['a']]);
    vi.advanceTimersByTime(RENEW_MS);
    expect(reports()).toEqual([['a'], ['a']]);
    usePlayerStore.setState({ source: live('b'), status: 'loading' });
    expect(reports()).toEqual([['a'], ['a'], ['b']]);
    usePlayerStore.setState({ source: undefined, status: 'idle' });
    expect(reports()).toEqual([['a'], ['a'], ['b'], []]);
    vi.advanceTimersByTime(RENEW_MS * 3);
    expect(reports()).toHaveLength(4);
    usePlayerStore.setState({ source: live('c'), status: 'playing' });
    unbind();
    expect(reports().at(-1)).toEqual([]);
  });

  it('lets a player that connects to the provider itself wait for the answer to its report', async () => {
    vi.useFakeTimers();
    let answer: () => void = () => undefined;
    rpcMock.mockImplementation((cmd: string) =>
      cmd === 'downloads.playback' ? new Promise((resolve) => (answer = () => resolve(undefined))) : Promise.resolve(undefined),
    );
    const unbind = bindPlaybackReport();
    try {
      expect(reportAnswered(live('a'))).toBeNull();
      usePlayerStore.setState({ source: live('a'), status: 'loading' });
      const waiting = reportAnswered(live('a'));
      expect(waiting).not.toBeNull();
      // Another source, or a local file, has nothing to wait for.
      expect(reportAnswered(live('b'))).toBeNull();
      expect(reportAnswered({ ...live('a'), kind: 'file' })).toBeNull();
      let done = false;
      void waiting!.then(() => (done = true));
      await vi.advanceTimersByTimeAsync(100);
      expect(done).toBe(false);
      answer();
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(true);
      expect(reportAnswered(live('a'))).toBeNull();
      // A core that never answers holds a player back for REPORT_WAIT_MS at most.
      usePlayerStore.setState({ source: live('b'), status: 'loading' });
      let late = false;
      void reportAnswered(live('b'))!.then(() => (late = true));
      await vi.advanceTimersByTimeAsync(REPORT_WAIT_MS - 1);
      expect(late).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(late).toBe(true);
    } finally {
      unbind();
      rpcMock.mockImplementation(() => Promise.resolve(undefined));
    }
  });
});
