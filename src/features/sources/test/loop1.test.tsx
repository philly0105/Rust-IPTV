/**
 * Loop 1 fixes (2026-10-15): expired Xtream verdict, reopening Add after "Close, keep importing",
 * the source a failed add leaves behind, the waiting line before the first progress, and the
 * default name for stock Stalker portal paths.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { confirmDiscard, eagerRoutes, installDomStubs, makeSource, renderAt, rpcMock } from './harness';

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
const { useToastStore } = await import('@/ui');
const { resetProgressForTests } = await import('../lib/progress');
const { flushPendingRemovals, resetPendingRemovalsForTests } = await import('../lib/pendingRemoval');
const { ImportProgressView } = await import('../components/ImportProgressView');
const { suggestName } = await import('../lib/validate');

const routes = () => [...sourcesRoutes, { path: 's/:id/live', element: <div>live page</div> }];
const dialog = () => screen.getByRole('dialog');
const input = (label: string | RegExp) => within(dialog()).getByLabelText(label, { selector: 'input,textarea' }) as HTMLInputElement;
const type = (label: string | RegExp, value: string) => fireEvent.change(input(label), { target: { value } });
const toasts = () => useToastStore.getState().toasts;

beforeAll(installDomStubs);
beforeEach(() => {
  resetPendingRemovalsForTests();
  rpcMock.reset();
  localStorage.clear();
  useToastStore.getState().clear();
  resetProgressForTests();
});
afterEach(cleanup);

describe('default name (L1-sources-home-6)', () => {
  it('skips stock portal paths and falls back to the host', () => {
    expect(suggestName('http://portal.example.com/stalker/c/')).toBe('portal.example.com');
    expect(suggestName('http://portal.example.com:8080/stalker_portal/c/')).toBe('portal.example.com');
    expect(suggestName('http://portal.example.com/stalker_portal/')).toBe('portal.example.com');
    expect(suggestName('http://portal.example.com/server/load.php')).toBe('portal.example.com');
    expect(suggestName('http://portal.example.com/portal.php')).toBe('portal.example.com');
    expect(suggestName('http://panel.example.com/panel/')).toBe('panel.example.com');
    // A meaningful last part is still used.
    expect(suggestName('http://lists.example.com/sports.m3u')).toBe('sports');
  });
});

describe('connection test verdict for an inactive account (L1-core-7)', () => {
  async function testXtream(result: unknown) {
    rpcMock.handlers['sources.list'] = () => [];
    rpcMock.handlers['xtream.test'] = () => result;
    renderAt(routes(), '/sources?add=1&kind=xtream');
    await screen.findByRole('dialog');
    type(/^Server URL/, 'http://xt.example.com:8080');
    type(/^Username/, 'alice');
    type(/^Password/, 'pw');
    fireEvent.click(within(dialog()).getByRole('button', { name: /Test connection/ }));
    return within(dialog()).findByTestId('connection-test-result');
  }

  it('warns, instead of saying Connected, when the account has expired', async () => {
    const result = await testXtream({ ok: true, name: 'xt.example.com', message: 'Signed in, but the account has expired. Renew it with your provider.' });
    expect(result.textContent).toBe('Signed in to xt.example.com, but the account has expired.');
    expect(result.className).toContain('text-warning');
    expect(screen.getByTestId('connection-test').getAttribute('data-verdict')).toBe('warn');
    expect(screen.getByTestId('connection-test-hint').textContent).toBe("Channels won't play until your provider renews or reactivates the account.");
  });

  it('shows any other account status the provider reports as a warning', async () => {
    const result = await testXtream({ ok: true, name: 'xt.example.com', message: 'Signed in. Account status: Disabled.' });
    expect(result.textContent).toBe('Signed in. Account status: Disabled.');
    expect(screen.getByTestId('connection-test').getAttribute('data-verdict')).toBe('warn');
  });

  it('a core that refuses the expired account gets the same plain words', async () => {
    const result = await testXtream({ ok: false, message: 'Signed in, but the account has expired. Renew it with your provider.' });
    expect(result.textContent).toBe('Signed in, but the account has expired.');
    expect(screen.getByTestId('connection-test').getAttribute('data-verdict')).toBe('fail');
    expect(screen.getByTestId('connection-test-hint').textContent).toContain('renews or reactivates');
  });

  it('an active account still reads Connected', async () => {
    const result = await testXtream({ ok: true, name: 'xt.example.com' });
    expect(result.textContent).toBe('Connected to xt.example.com.');
    expect(screen.getByTestId('connection-test').getAttribute('data-verdict')).toBe('ok');
  });
});

describe('waiting for the first progress (L1-sources-home-10)', () => {
  it('names the server and counts the seconds until data arrives', () => {
    const { rerender } = render(<ImportProgressView entry={undefined} kind="m3u" host="lists.example.com" startedAt={Date.now() - 1_200} />);
    expect(screen.getByTestId('import-progress-phase').textContent).toBe('Connecting to lists.example.com…');
    expect(screen.getByTestId('import-progress-elapsed').textContent).toMatch(/^1\s?s/);
    // Past 2 s it says it is still trying (L3-import-ui-4).
    rerender(<ImportProgressView entry={undefined} kind="m3u" host="lists.example.com" startedAt={Date.now() - 5_200} />);
    expect(screen.getByTestId('import-progress-phase').textContent).toBe('Still trying to reach lists.example.com…');
    expect(screen.getByTestId('import-progress-elapsed').textContent).toMatch(/^5\s?s/);
    // The core's `connecting` event, which opens every run, waits too.
    rerender(<ImportProgressView entry={{ sourceId: 's', phase: 'connecting', done: 0, at: 0 }} kind="m3u" host="lists.example.com" startedAt={Date.now() - 5_200} />);
    expect(screen.getByTestId('import-progress-phase').textContent).toBe('Still trying to reach lists.example.com…');
    // A fetching event with no bytes yet still waits.
    rerender(<ImportProgressView entry={{ sourceId: 's', phase: 'fetching', done: 0, at: 0 }} kind="m3u" host="lists.example.com" startedAt={Date.now() - 5_200} />);
    expect(screen.getByTestId('import-progress').getAttribute('data-waiting')).toBe('true');
    // The first bytes replace it with the download.
    rerender(<ImportProgressView entry={{ sourceId: 's', phase: 'fetching', done: 2048, at: 0 }} kind="m3u" host="lists.example.com" />);
    expect(screen.getByTestId('import-progress-phase').textContent).toBe('Downloading');
    expect(screen.queryByTestId('import-progress-elapsed')).toBeNull();
    expect(screen.getByTestId('import-progress-counts').textContent).toContain('downloaded');
  });

  it('says Starting without a host, and shows no seconds in the first second', () => {
    render(<ImportProgressView entry={undefined} />);
    expect(screen.getByTestId('import-progress-phase').textContent).toBe('Starting…');
    expect(screen.queryByTestId('import-progress-elapsed')).toBeNull();
  });

  it('shows the host in the add dialog while the add waits', async () => {
    rpcMock.handlers['sources.list'] = () => [];
    rpcMock.handlers['sources.add'] = () => new Promise(() => undefined);
    renderAt(routes(), '/sources?add=1&kind=m3u');
    await screen.findByRole('dialog');
    type(/^Name/, 'Slow');
    type(/^Playlist URL/, 'lists.example.com/tv.m3u');
    fireEvent.click(screen.getByTestId('add-source-submit'));
    expect((await within(dialog()).findByTestId('import-progress-phase')).textContent).toBe('Connecting to lists.example.com…');
  });
});

describe('progress on a short window (L1-sources-home-9)', () => {
  it('scrolls the progress into view when the add starts', async () => {
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView');
    try {
      rpcMock.handlers['sources.list'] = () => [];
      rpcMock.handlers['sources.add'] = () => new Promise(() => undefined);
      renderAt(routes(), '/sources?add=1&kind=m3u');
      await screen.findByRole('dialog');
      type(/^Name/, 'Slow');
      type(/^Playlist URL/, 'lists.example.com/tv.m3u');
      fireEvent.click(screen.getByTestId('add-source-submit'));
      await waitFor(() => expect(spy.mock.contexts.some((el) => (el as Element).querySelector?.('[data-testid="import-progress"]'))).toBe(true));
    } finally {
      spy.mockRestore();
    }
  });
});

describe('reopening Add after "Close, keep importing" (L1-sources-home-1)', () => {
  it('opens a fresh, usable form that the background add never closes', async () => {
    let finish!: (s: unknown) => void;
    rpcMock.handlers['sources.list'] = () => [];
    rpcMock.handlers['sources.add'] = (a) => new Promise((r) => (finish = () => r(makeSource('bg', { name: (a as { name: string }).name }))));
    const { router } = renderAt(routes(), '/sources?add=1&kind=m3u');
    await screen.findByRole('dialog');
    type(/^Name/, 'Background');
    type(/^Playlist URL/, 'lists.example.com/tv.m3u');
    fireEvent.click(screen.getByTestId('add-source-submit'));
    await waitFor(() => expect(rpcMock.callsOf('sources.add')).toHaveLength(1));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close, keep importing' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await act(async () => router.navigate('/sources?add=1&kind=m3u'));
    await screen.findByRole('dialog');
    expect(screen.getByTestId('add-source-submit').textContent).toBe('Add source');
    expect(input(/^Playlist URL/).disabled).toBe(false);
    expect(within(dialog()).queryByTestId('import-progress')).toBeNull();
    expect(within(dialog()).getByRole('button', { name: 'Cancel' })).toBeTruthy();

    // The background add ends: it confirms with a toast but leaves the new form alone.
    await act(async () => finish(undefined));
    await waitFor(() => expect(toasts().some((t) => t.title === 'Added Background')).toBe(true));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(router.state.location.search).toBe('?add=1&kind=m3u');
    expect(input(/^Playlist URL/).disabled).toBe(false);
  });
});

describe('closing after a failed add (L1-sources-home-8)', () => {
  function failingAdd() {
    const store: ReturnType<typeof makeSource>[] = [];
    rpcMock.handlers['sources.list'] = () => [...store];
    rpcMock.handlers['sources.add'] = (a) => {
      const s = makeSource('f1', { name: (a as { name: string }).name, channelCount: 0, lastError: 'error sending request' });
      store.push(s);
      throw new RpcError('network', 'error sending request', true, { sourceId: s.id });
    };
    rpcMock.handlers['sources.remove'] = (a) => {
      store.splice(
        store.findIndex((x) => x.id === (a as { id: string }).id),
        1,
      );
      return null;
    };
    return store;
  }

  async function failThenClose() {
    renderAt(routes(), '/sources?add=1&kind=m3u');
    await screen.findByRole('dialog');
    type(/^Name/, 'hang');
    type(/^Playlist URL/, 'http://127.0.0.1:7399/x.m3u');
    fireEvent.click(screen.getByTestId('add-source-submit'));
    const alert = await screen.findByTestId('add-source-error');
    expect(within(alert).getByTestId('add-source-retry-note').textContent).toContain('Closing this window removes "hang"');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    // Typed details: Cancel asks before dropping them (SS-1).
    confirmDiscard();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  }

  it('removes the source the failed add left behind, with Undo', async () => {
    const store = failingAdd();
    await failThenClose();
    const t = toasts().find((x) => x.title === 'Removed hang');
    expect(t?.action?.label).toBe('Undo');
    expect(String(t?.description)).toContain('first import failed');
    await act(async () => flushPendingRemovals());
    expect(rpcMock.callsOf('sources.remove')).toEqual([{ id: 'f1' }]);
    expect(store).toHaveLength(0);
  });

  it('Undo keeps it', async () => {
    const store = failingAdd();
    await failThenClose();
    act(() => toasts().find((x) => x.title === 'Removed hang')!.action!.onClick());
    await act(async () => flushPendingRemovals());
    expect(rpcMock.callsOf('sources.remove')).toEqual([]);
    expect(store.map((s) => s.id)).toEqual(['f1']);
  });
});
