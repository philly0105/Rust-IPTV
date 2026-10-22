import { afterEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.fn((_cmd: string, _args?: unknown) => Promise.resolve(undefined));
vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock(cmd, args),
}));

const { bindPlaybackReport, playingSource, RENEW_MS } = await import('./playbackReport');
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
});
