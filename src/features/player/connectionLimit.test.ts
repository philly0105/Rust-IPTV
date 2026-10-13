import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import en from '@/i18n/en/player.json';

const rpcMock = vi.fn();
vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock(cmd, args),
}));

const { classifyStreamError, errorCopyKeys } = await import('./errors');
const { countsFromStatus, resetOwnStreams, shouldCheckConnections, useConnectionCounts } = await import('./connectionLimit');
const { usePlayerStore } = await import('./store');

const full = { active: 2, max: 2 };

describe('connection limit classification', () => {
  it('a full account turns a bare 403 or 5xx into connectionLimit', () => {
    expect(classifyStreamError({ message: 'HTTP 403', connections: full })).toBe('connectionLimit');
    expect(classifyStreamError({ message: 'HTTP 503', connections: full })).toBe('connectionLimit');
    expect(classifyStreamError({ message: 'manifest load failed', kind: 'network', connections: full })).toBe('connectionLimit');
  });

  it('keeps the existing class when the account has room or no limit', () => {
    expect(classifyStreamError({ message: 'HTTP 403', connections: { active: 1, max: 2 } })).toBe('auth');
    expect(classifyStreamError({ message: 'HTTP 403', connections: { active: 3, max: 0 } })).toBe('auth');
    expect(classifyStreamError({ message: 'HTTP 403', connections: null })).toBe('auth');
  });

  it('never hides offline, a missing player, a missing stream or a codec problem', () => {
    expect(classifyStreamError({ message: 'HTTP 403', online: false, connections: full })).toBe('offline');
    expect(classifyStreamError({ message: 'HTTP 404', connections: full })).toBe('notFound');
    expect(classifyStreamError({ message: 'codec not supported', connections: full })).toBe('unsupported');
    expect(classifyStreamError({ code: 'engine_missing', connections: full })).toBe('engineMissing');
  });

  it('reads provider wording and the 458/509 statuses without an account check', () => {
    expect(classifyStreamError({ message: 'HTTP 403: Max connections reached' })).toBe('connectionLimit');
    expect(classifyStreamError({ message: 'Too many connections' })).toBe('connectionLimit');
    expect(classifyStreamError({ message: 'HTTP 458' })).toBe('connectionLimit');
    expect(classifyStreamError({ message: 'HTTP 509' })).toBe('connectionLimit');
    expect(classifyStreamError({ message: 'HTTP 403 Forbidden' })).toBe('auth');
  });

  it("subtracts the app's own connections before calling the account full", () => {
    // 1-connection plan, our own stream just dropped: nobody else is watching.
    const ownOnly = { active: 1, max: 1, own: 1 };
    expect(classifyStreamError({ message: 'HTTP 503', connections: ownOnly })).toBe('server');
    expect(classifyStreamError({ message: 'timed out', connections: ownOnly })).toBe('timeout');
    // A refused stream may still be the limit: hedge the wording.
    expect(classifyStreamError({ message: 'HTTP 403', connections: ownOnly })).toBe('connectionLimit');
    expect(errorCopyKeys('connectionLimit', { connections: ownOnly, message: 'HTTP 403' })).toEqual({
      title: 'errorConnLimitMaybeTitle',
      hint: 'errorConnLimitMaybe',
      params: { active: 1, max: 1 },
    });
    // Someone else fills the limit even without us.
    const others = { active: 3, max: 2, own: 1 };
    expect(classifyStreamError({ message: 'HTTP 503', connections: others })).toBe('connectionLimit');
    expect(errorCopyKeys('connectionLimit', { connections: others }).title).toBe('errorConnLimitTitleCount');
    // The provider's own words are certain whatever the counts.
    expect(errorCopyKeys('connectionLimit', { connections: ownOnly, message: 'Max connections reached' }).title).toBe('errorConnLimitTitleCount');
    const strings: Record<string, string> = en;
    expect(strings.errorConnLimitMaybeTitle).toContain('may be');
  });

  it('copy names the counts when known', () => {
    const strings: Record<string, string> = en;
    const counted = errorCopyKeys('connectionLimit', { connections: full });
    expect(counted).toEqual({ title: 'errorConnLimitTitleCount', hint: 'errorConnLimit', params: { active: 2, max: 2 } });
    expect(strings[counted.title]).toContain('{{active}} of {{max}}');
    const plain = errorCopyKeys('connectionLimit');
    expect(strings[plain.title]).toBe('Connection limit reached');
    expect(strings[plain.hint]).toBeTruthy();
  });
});

describe('useConnectionCounts', () => {
  afterEach(() => rpcMock.mockReset());

  it('a failed or old check is no evidence', () => {
    const at = Date.parse('2026-10-12T12:00:00Z');
    const ok = { sourceId: 's', kind: 'xtream' as const, isTrial: false, checkedAt: '2026-10-12T12:00:00Z', activeCons: 1, maxConnections: 1 };
    expect(countsFromStatus(ok, at, 0)).toEqual({ active: 1, max: 1, own: 0 });
    expect(countsFromStatus({ ...ok, error: 'panel down' }, at, 0)).toBeNull();
    expect(countsFromStatus({ ...ok, checkedAt: '2026-10-12T11:00:00Z' }, at, 0)).toBeNull();
    expect(countsFromStatus({ ...ok, checkedAt: '' }, at, 0)).toBeNull();
    expect(countsFromStatus({ ...ok, maxConnections: 0 }, at, 0)).toBeNull();
  });

  it('only checks failures a full account could explain', () => {
    expect(shouldCheckConnections({ message: 'HTTP 403' }, 'src')).toBe(true);
    expect(shouldCheckConnections({ message: 'HTTP 403' }, undefined)).toBe(false);
    expect(shouldCheckConnections({ message: 'HTTP 404' }, 'src')).toBe(false);
    expect(shouldCheckConnections({ message: undefined }, 'src')).toBe(false);
  });

  it('asks account.status once per failure and returns the counts', async () => {
    rpcMock.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'recordings.list' ? [] : { sourceId: 'src', kind: 'xtream', isTrial: false, checkedAt: new Date().toISOString(), activeCons: 2, maxConnections: 2 }),
    );
    const { result, rerender } = renderHook(({ message }) => useConnectionCounts({ message }, 'src'), { initialProps: { message: 'HTTP 403' } });
    await waitFor(() => expect(result.current).toEqual({ active: 2, max: 2, own: 0 }));
    rerender({ message: 'HTTP 403' });
    expect(rpcMock.mock.calls.filter(([cmd]) => cmd === 'account.status')).toHaveLength(1);
    expect(rpcMock).toHaveBeenCalledWith('account.status', { sourceId: 'src', refresh: true });
    expect(classifyStreamError({ message: 'HTTP 403', connections: result.current })).toBe('connectionLimit');
  });

  it('a failed or unlimited check reads as unknown', async () => {
    rpcMock.mockImplementation((cmd: string) => (cmd === 'recordings.list' ? Promise.resolve([]) : Promise.reject(new Error('offline'))));
    const failed = renderHook(() => useConnectionCounts({ message: 'HTTP 403' }, 'a'));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('account.status', { sourceId: 'a', refresh: true }));
    expect(failed.result.current).toBeNull();
    rpcMock.mockImplementation(() => Promise.resolve(null));
    const m3u = renderHook(() => useConnectionCounts({ message: 'HTTP 500' }, 'b'));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('account.status', { sourceId: 'b', refresh: true }));
    expect(m3u.result.current).toBeNull();
  });

  it('a check that failed upstream never yields counts, even with stale full ones', async () => {
    let settled = false;
    rpcMock.mockImplementation((cmd: string) => {
      if (cmd === 'recordings.list') return Promise.resolve([]);
      settled = true;
      return Promise.resolve({ sourceId: 'c', kind: 'xtream', isTrial: false, checkedAt: new Date().toISOString(), activeCons: 1, maxConnections: 1, error: 'panel down' });
    });
    const { result } = renderHook(() => useConnectionCounts({ message: 'HTTP 503' }, 'c'));
    await waitFor(() => expect(settled).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current).toBeNull();
    expect(classifyStreamError({ message: 'HTTP 503', connections: result.current })).toBe('server');
  });

  it("counts the stream that just played and running recordings as the app's own", async () => {
    resetOwnStreams();
    usePlayerStore.setState({ source: { url: 'http://x/1', kind: 'hls', title: 'One', isLive: true, isRadio: false, ref: { sourceId: 'd', contentType: 'live', itemId: '1' } }, status: 'playing' });
    usePlayerStore.setState({ status: 'error', error: 'HTTP 503' });
    rpcMock.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === 'recordings.list'
          ? [
              { status: 'recording', ref: { sourceId: 'd', contentType: 'live', itemId: '2' } },
              { status: 'scheduled', ref: { sourceId: 'd', contentType: 'live', itemId: '3' } },
              { status: 'recording', ref: { sourceId: 'other', contentType: 'live', itemId: '4' } },
            ]
          : { sourceId: 'd', kind: 'xtream', isTrial: false, checkedAt: new Date().toISOString(), activeCons: 2, maxConnections: 2 },
      ),
    );
    const { result } = renderHook(() => useConnectionCounts({ message: 'HTTP 503' }, 'd'));
    await waitFor(() => expect(result.current).toEqual({ active: 2, max: 2, own: 2 }));
    expect(classifyStreamError({ message: 'HTTP 503', connections: result.current })).toBe('server');
    usePlayerStore.setState({ source: undefined, status: 'idle', error: undefined });
  });

  it('asks nothing while there is no error', () => {
    renderHook(() => useConnectionCounts({ message: undefined }, 'src'));
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
