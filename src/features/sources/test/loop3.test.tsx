/**
 * Loop 3 fixes (2026-10-16): a failed add's source goes on reload (L3-app-5), a refused duplicate
 * names the source it duplicates (L3-app-7), a failed save focuses the field once it has rendered
 * (L3-app-9), the two long saving steps are named (L3-import-ui-3), and a slow connection says it
 * is still trying, with a way to stop waiting (L3-import-ui-4). A removal still in its undo window
 * goes out with keepalive when the page unloads or the app quits (L3-app-pages-x2).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { chooseCardAction, confirmDiscard, eagerRoutes, installDomStubs, makeSource, renderAt, rpcMock } from './harness';

/** Every rpcRaw call with its options, to see which went out with keepalive. */
const raw = vi.hoisted(() => [] as { cmd: string; args: unknown; opts: unknown }[]);

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown, opts?: unknown) => {
    raw.push({ cmd, args, opts });
    return rpcMock.call(cmd, args);
  },
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
const { flushPendingRemovals, isRemovalPending, resetPendingRemovalsForTests, scheduleRemoval } = await import('../lib/pendingRemoval');
const { QUIT_FLUSH_EVENT } = await import('@/api/window');
const { duplicateSourceName } = await import('../lib/errors');
const { ImportProgressView } = await import('../components/ImportProgressView');
const { ConnectionTest } = await import('../components/ConnectionTest');

const routes = () => [...sourcesRoutes, { path: 's/:id/live', element: <div>live page</div> }];
const dialog = () => screen.getByRole('dialog');
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(within(dialog()).getByLabelText(label, { selector: 'input,textarea' }), { target: { value } });
const input = (label: RegExp) => within(dialog()).getByLabelText(label, { selector: 'input' });

beforeAll(installDomStubs);
beforeEach(() => {
  resetPendingRemovalsForTests();
  rpcMock.reset();
  raw.length = 0;
  localStorage.clear();
  useToastStore.getState().clear();
  resetProgressForTests();
});
afterEach(cleanup);

describe('a failed add does not outlive a reload (L3-app-5)', () => {
  async function failAdd() {
    rpcMock.handlers['sources.list'] = () => [];
    rpcMock.handlers['sources.add'] = () => {
      throw new RpcError('not_found', 'HTTP 404 Not Found', false, { sourceId: 'new1' });
    };
    rpcMock.handlers['sources.remove'] = () => null;
    const view = renderAt(routes(), '/sources?add=1&kind=m3u');
    await screen.findByRole('dialog');
    type(/^Name/, '404');
    type(/^Playlist URL/, 'lists.example.com/missing.m3u');
    fireEvent.click(screen.getByTestId('add-source-submit'));
    await screen.findByTestId('add-source-retry-note');
    return view;
  }

  it('removes the source the failed add left behind when the page unloads while the error shows', async () => {
    await failAdd();
    expect(rpcMock.callsOf('sources.remove')).toEqual([]);
    act(() => {
      window.dispatchEvent(new Event('beforeunload'));
      window.dispatchEvent(new Event('pagehide'));
    });
    // Once, although both unload events came, and with keepalive.
    await waitFor(() => expect(rpcMock.callsOf('sources.remove')).toEqual([{ id: 'new1' }]));
    expect(raw.filter((c) => c.cmd === 'sources.remove')).toEqual([{ cmd: 'sources.remove', args: { id: 'new1' }, opts: { keepalive: true } }]);
  });

  it('leaves it to the dialog once it closed (Cancel schedules an undoable removal instead)', async () => {
    await failAdd();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    // Typed details: Cancel asks before dropping them (SS-1).
    confirmDiscard();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    resetPendingRemovalsForTests();
    act(() => {
      window.dispatchEvent(new Event('beforeunload'));
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(rpcMock.callsOf('sources.remove')).toEqual([]);
  });

  it('does not touch a source whose add succeeded', async () => {
    rpcMock.handlers['sources.list'] = () => [];
    rpcMock.handlers['sources.add'] = () => makeSource('ok', { name: 'Fine' });
    renderAt(routes(), '/sources?add=1&kind=m3u');
    await screen.findByRole('dialog');
    type(/^Name/, 'Fine');
    type(/^Playlist URL/, 'lists.example.com/tv.m3u');
    fireEvent.click(screen.getByTestId('add-source-submit'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    act(() => {
      window.dispatchEvent(new Event('beforeunload'));
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(rpcMock.callsOf('sources.remove')).toEqual([]);
  });
});

describe('a refused duplicate names the source (L3-app-7)', () => {
  it('reads the name from the core text when the list does not have it', () => {
    expect(duplicateSourceName({ message: 'this source already exists: "Mock M3U" uses the same playlist URL' })).toBe('Mock M3U');
    expect(duplicateSourceName({ message: 'A source with this address already exists.' })).toBeNull();
  });

  it('falls back to that name when the existing source is not in the list yet', async () => {
    rpcMock.handlers['sources.list'] = () => [];
    rpcMock.handlers['sources.add'] = () => {
      throw new RpcError('conflict', 'this source already exists: "Living room" uses the same playlist URL', false, { existingSourceId: 'old' });
    };
    renderAt(routes(), '/sources?add=1&kind=m3u');
    await screen.findByRole('dialog');
    type(/^Name/, 'Living room again');
    type(/^Playlist URL/, 'lists.example.com/tv.m3u');
    fireEvent.click(screen.getByTestId('add-source-submit'));
    const alert = await screen.findByTestId('add-source-error');
    expect(alert.textContent).toContain('Already added as "Living room"');
    expect(within(alert).getByTestId('add-source-open-existing')).toBeTruthy();
  });
});

describe('focus after a failed save clicked with the mouse (L3-app-9)', () => {
  // Frame callbacks that run at once: the old focus call then ran before React committed the error.
  let raf: typeof window.requestAnimationFrame;
  beforeEach(() => {
    raf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => {
      cb(performance.now());
      return 1;
    };
  });
  afterEach(() => {
    window.requestAnimationFrame = raf;
  });

  const xtream = makeSource('x', {
    kind: 'xtream',
    name: 'Big provider',
    m3u: undefined,
    xtream: { serverUrl: 'http://xt.example.com:8080', username: 'alice', password: 'pw-secret' },
  });

  it('Edit: lands on the password the check refused, not on Save', async () => {
    rpcMock.handlers['sources.list'] = () => [xtream];
    rpcMock.handlers['xtream.test'] = () => ({ ok: false, message: 'HTTP 401 Unauthorized' });
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('source-edit'));
    type(/^Password/, 'wrong');
    const save = screen.getByTestId('edit-source-save');
    save.focus();
    fireEvent.click(save);
    await screen.findByTestId('edit-source-check-failed');
    const pw = input(/^Password/);
    expect(pw.getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(pw));
  });

  it('Add: lands on the password the server refused', async () => {
    rpcMock.handlers['sources.list'] = () => [];
    rpcMock.handlers['sources.add'] = () => {
      throw new RpcError('auth', 'xt.example.com answered HTTP 401');
    };
    renderAt(routes(), '/sources?add=1&kind=m3u');
    await screen.findByRole('dialog');
    fireEvent.click(within(dialog()).getByRole('tab', { name: 'Xtream Codes' }));
    type(/^Name/, 'Big provider');
    type(/^Server URL/, 'http://xt.example.com:8080');
    type(/^Username/, 'alice');
    type(/^Password/, 'wrong');
    const submit = screen.getByTestId('add-source-submit');
    submit.focus();
    fireEvent.click(submit);
    await screen.findByTestId('add-source-error');
    await waitFor(() => expect(document.activeElement).toBe(input(/^Password/)));
  });
});

describe('the long saving steps are named (L3-import-ui-3)', () => {
  const bar = () => screen.getByRole('progressbar');

  it('replacing the old catalog: its own label and an indeterminate bar', () => {
    render(<ImportProgressView entry={{ sourceId: 's', phase: 'saving', step: 'replacing', done: 0, at: 0 }} />);
    expect(screen.getByTestId('import-progress-phase').textContent).toBe('Replacing the old catalog');
    expect(screen.queryByTestId('import-progress-counts')).toBeNull();
    expect(bar().getAttribute('aria-valuenow')).toBeNull();
  });

  it('building the index: no "88,000 of 88,000" for a minute', () => {
    render(<ImportProgressView entry={{ sourceId: 's', phase: 'saving', step: 'indexing', done: 88_000, total: 88_000, at: 0 }} />);
    expect(screen.getByTestId('import-progress-phase').textContent).toBe('Building the search index');
    expect(screen.queryByTestId('import-progress-counts')).toBeNull();
    expect(bar().getAttribute('aria-valuenow')).toBeNull();
  });

  it('a core without steps still shows Saving with its counts', () => {
    render(<ImportProgressView entry={{ sourceId: 's', phase: 'saving', done: 4_000, total: 8_000, at: 0 }} />);
    expect(screen.getByTestId('import-progress-phase').textContent).toBe('Saving');
    expect(screen.getByTestId('import-progress-counts').textContent).toBe('4,000 of 8,000');
    expect(bar().getAttribute('aria-valuenow')).toBe('50');
  });
});

describe('a slow connection test says it is still trying (L3-import-ui-4)', () => {
  it('after 2 s offers to stop waiting, and drops the late answer', async () => {
    let answer!: (r: { ok: boolean; name?: string }) => void;
    const run = () => new Promise<{ ok: boolean; name?: string }>((r) => (answer = r));
    render(<ConnectionTest run={run} kind="xtream" host="xt.example.com:8080" />);
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(screen.queryByTestId('connection-test-still-trying')).toBeNull();
    const line = await screen.findByTestId('connection-test-still-trying', {}, { timeout: 3_000 });
    expect(line.textContent).toContain('Still trying to reach xt.example.com:8080…');
    fireEvent.click(within(line).getByTestId('connection-test-cancel'));
    expect(screen.getByTestId('connection-test').getAttribute('data-status')).toBe('idle');
    expect(document.activeElement?.textContent).toBe('Test connection');
    act(() => answer({ ok: true, name: 'late' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('connection-test-result')).toBeNull();
  });
});

describe('a removal in its undo window survives a reload or quit (L3-app-pages-x2)', () => {
  const schedule = (id: string) => {
    const remove = vi.fn(async (_call?: unknown) => undefined);
    scheduleRemoval({ id, toast: { title: `Removed ${id}` }, undoLabel: 'Undo', remove });
    return remove;
  };

  it('is sent once, with keepalive, as the page unloads', async () => {
    const remove = schedule('a');
    act(() => {
      window.dispatchEvent(new Event('beforeunload'));
      window.dispatchEvent(new Event('pagehide'));
    });
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(remove).toHaveBeenCalledWith({ keepalive: true });
    expect(isRemovalPending('a')).toBe(false);
  });

  it('is sent with keepalive on the desktop quit flush, which waits for it', async () => {
    const remove = schedule('b');
    const work: Promise<unknown>[] = [];
    act(() => {
      window.dispatchEvent(new CustomEvent(QUIT_FLUSH_EVENT, { detail: { waitUntil: (p: Promise<unknown>) => void work.push(p) } }));
    });
    expect(remove).toHaveBeenCalledWith({ keepalive: true });
    expect(work).toHaveLength(1);
    await work[0];
  });

  it('an in-app flush (an add that needs the source gone) sends it as a plain call', async () => {
    const remove = schedule('c');
    await act(async () => flushPendingRemovals());
    expect(remove).toHaveBeenCalledWith(undefined);
  });

  it('Sources page: a source removed just before a reload is removed with keepalive', async () => {
    const xt = (id: string) => makeSource(id, { kind: 'xtream', name: `XT ${id}`, m3u: undefined, xtream: { serverUrl: 'http://xt.example.com:8080', username: 'alice', password: 'pw-secret' } });
    rpcMock.handlers['sources.list'] = () => [xt('a'), xt('b')];
    rpcMock.handlers['sources.remove'] = () => null;
    renderAt(routes(), '/sources');
    await waitFor(() => expect(screen.queryAllByTestId('source-card')).toHaveLength(2));
    chooseCardAction('Remove');
    await waitFor(() => expect(screen.queryAllByTestId('source-card')).toHaveLength(1));
    expect(rpcMock.callsOf('sources.remove')).toEqual([]);
    act(() => {
      window.dispatchEvent(new Event('beforeunload'));
      window.dispatchEvent(new Event('pagehide'));
    });
    await waitFor(() => expect(rpcMock.callsOf('sources.remove')).toEqual([{ id: 'a' }]));
    expect(raw.filter((c) => c.cmd === 'sources.remove')).toEqual([{ cmd: 'sources.remove', args: { id: 'a' }, opts: { keepalive: true } }]);
  });
});
