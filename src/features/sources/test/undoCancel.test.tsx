/**
 * B5 run 2026-10-12: undoable remove (C9), cancellable import (C8), error codes first (C10),
 * redaction and the big-file guard. Ledger: audit/B5-sources.md.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { chooseCardAction, confirmDiscard, eagerRoutes, installDomStubs, makeSource, renderAt, rpcMock } from './harness';

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
const { useToastStore, dismissToast } = await import('@/ui');
const { handleImportEvent, resetProgressForTests, useImportProgressStore } = await import('../lib/progress');
const { flushPendingRemovals, resetPendingRemovalsForTests, scheduleRemoval, usePendingRemovals, UNDO_MS } = await import('../lib/pendingRemoval');
const { ImportProgressView } = await import('../components/ImportProgressView');
const { maskMac, sourceOrigin } = await import('../components/SourceCard');
const { classifySourceError, splitErrorText } = await import('../lib/sourceError');
const { importErrorCode, importSummaryKey, isCancelledImportError, nextStepKey, summaryKey } = await import('../lib/errors');
const { displayHost, suggestName } = await import('../lib/validate');
const { decodeText, formatFileSize, MAX_WEB_FILE_BYTES, readFileText } = await import('../lib/files');
const i18n = (await import('@/i18n')).default;
const { invalidate } = await import('@/api/query');

const routes = () => [...sourcesRoutes, { path: 's/:id/live', element: <div>live page</div> }];
const toasts = () => useToastStore.getState().toasts;
const xtream = (id: string, over = {}) =>
  makeSource(id, {
    kind: 'xtream',
    name: `XT ${id}`,
    m3u: undefined,
    xtream: { serverUrl: 'http://xt.example.com:8080', username: 'alice', password: 'pw-secret' },
    ...over,
  });
const cards = () => screen.queryAllByTestId('source-card').map((c) => c.getAttribute('data-source-id'));

beforeAll(installDomStubs);
beforeEach(() => {
  // First: clearing the toasts would otherwise commit the previous test's waiting removal.
  resetPendingRemovalsForTests();
  rpcMock.reset();
  localStorage.clear();
  useToastStore.getState().clear();
  resetProgressForTests();
});
afterEach(cleanup);

describe('remove with undo (C9)', () => {
  async function removeFirst(list = [xtream('a'), xtream('b')]) {
    rpcMock.handlers['sources.list'] = () => list;
    rpcMock.handlers['sources.remove'] = () => null;
    renderAt(routes(), '/sources');
    await waitFor(() => expect(cards()).toEqual(['a', 'b']));
    chooseCardAction('Remove');
    await waitFor(() => expect(cards()).toEqual(['b']));
  }

  it('hides the source at once and offers Undo for 8 s without sending sources.remove', async () => {
    await removeFirst();
    expect(rpcMock.callsOf('sources.remove')).toEqual([]);
    const t = toasts()[0]!;
    expect(t.title).toBe('Removed XT a');
    expect(t.action?.label).toBe('Undo');
    expect(t.duration).toBe(UNDO_MS);
    expect(UNDO_MS).toBe(8000);
    // No confirm dialog any more: Undo replaces it.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Undo puts the source back and never sends sources.remove', async () => {
    await removeFirst();
    act(() => toasts()[0]!.action!.onClick());
    await waitFor(() => expect(cards()).toEqual(['a', 'b']));
    act(() => useToastStore.getState().clear());
    await new Promise((r) => setTimeout(r, 0));
    expect(rpcMock.callsOf('sources.remove')).toEqual([]);
    expect(usePendingRemovals.getState().ids.size).toBe(0);
  });

  it('sends sources.remove once when the undo window passes', async () => {
    await removeFirst();
    // The list refetch after removal no longer has it; the card stays gone.
    rpcMock.handlers['sources.list'] = () => [xtream('b')];
    act(() => {
      void flushPendingRemovals();
    });
    await waitFor(() => expect(rpcMock.callsOf('sources.remove')).toEqual([{ id: 'a' }]));
    await waitFor(() => expect(usePendingRemovals.getState().ids.size).toBe(0));
    expect(cards()).toEqual(['b']);
  });

  it('a refetch while Undo is offered does not bring the card back', async () => {
    await removeFirst();
    const { invalidate } = await import('@/api/query');
    await act(async () => invalidate('sources.'));
    expect(cards()).toEqual(['b']);
  });

  it('sends the removal immediately on pagehide', async () => {
    await removeFirst();
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await waitFor(() => expect(rpcMock.callsOf('sources.remove')).toEqual([{ id: 'a' }]));
    expect(toasts().some((t) => t.action?.label === 'Undo')).toBe(false);
  });

  it('a failed removal brings the source back and explains without leaking the URL', async () => {
    await removeFirst();
    rpcMock.handlers['sources.remove'] = () => {
      throw new RpcError('internal', 'database locked at http://xt.example.com/get.php?username=alice&password=pw-secret');
    };
    act(() => {
      void flushPendingRemovals();
    });
    await waitFor(() => expect(cards()).toEqual(['a', 'b']));
    await waitFor(() => expect(toasts().some((t) => t.variant === 'error')).toBe(true));
    const err = toasts().find((t) => t.variant === 'error')!;
    expect(err.title).toBe("Couldn't remove XT a");
    expect(String(err.description)).not.toContain('pw-secret');
    expect(String(err.description)).toContain('The source is back in your list.');
    expect(err.action?.label).toBe('Try again');
  });

  it('treats not_found on removal as removed (Remove all got there first)', async () => {
    await removeFirst();
    rpcMock.handlers['sources.remove'] = () => {
      throw new RpcError('not_found', 'no such source');
    };
    rpcMock.handlers['sources.list'] = () => [xtream('b')];
    act(() => {
      void flushPendingRemovals();
    });
    await waitFor(() => expect(usePendingRemovals.getState().ids.size).toBe(0));
    expect(toasts().some((t) => t.variant === 'error')).toBe(false);
    expect(cards()).toEqual(['b']);
  });

  it('commits on its own 8 s timer: evicting, dismissing or hovering the toast does not send it early (R1-1)', () => {
    vi.useFakeTimers();
    try {
      const removed: string[] = [];
      for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
        scheduleRemoval({ id, toast: { title: `Removed ${id}` }, undoLabel: 'Undo', remove: async () => void removed.push(id) });
        vi.advanceTimersByTime(250);
      }
      // Six toasts over the cap of five (B7 now keeps action toasts past it); the user closes two.
      dismissToast(toasts().find((t) => t.title === 'Removed a')?.id ?? '');
      dismissToast(toasts().find((t) => t.title === 'Removed b')?.id ?? '');
      expect(toasts().some((t) => t.title === 'Removed a' || t.title === 'Removed b')).toBe(false);
      expect(removed).toEqual([]);
      expect(usePendingRemovals.getState().ids.size).toBe(6);
      // 'a' was scheduled 6 x 250 ms ago: its window ends exactly UNDO_MS after it started.
      vi.advanceTimersByTime(UNDO_MS - 6 * 250 - 1);
      expect(removed).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(removed).toEqual(['a']);
      vi.advanceTimersByTime(UNDO_MS);
      expect(removed).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Undo still works after its toast was evicted, and cancels the timer (R1-1)', () => {
    vi.useFakeTimers();
    try {
      const remove = vi.fn(async () => undefined);
      const undo = scheduleRemoval({ id: 'a', toast: { title: 'Removed a' }, undoLabel: 'Undo', remove });
      useToastStore.getState().clear();
      undo();
      vi.advanceTimersByTime(UNDO_MS * 2);
      expect(remove).not.toHaveBeenCalled();
      expect(usePendingRemovals.getState().ids.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a waiting removal on tray Quit and hands the request to waitUntil (D26)', async () => {
    const { QUIT_FLUSH_EVENT } = await import('@/api/window');
    let answer: () => void = () => undefined;
    rpcMock.handlers['sources.remove'] = () =>
      new Promise<null>((r) => {
        answer = () => r(null);
      });
    await removeFirst();
    const work: Promise<unknown>[] = [];
    act(() => {
      window.dispatchEvent(new CustomEvent(QUIT_FLUSH_EVENT, { detail: { waitUntil: (p: Promise<unknown>) => void work.push(p) } }));
    });
    expect(rpcMock.callsOf('sources.remove')).toEqual([{ id: 'a' }]);
    expect(work).toHaveLength(1);
    // The promise settles only once the core answered, so Quit waits for the delete.
    let settled = false;
    void work[0]!.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await act(async () => {
      answer();
      await work[0];
    });
    expect(settled).toBe(true);
    expect(toasts().some((t) => t.action?.label === 'Undo')).toBe(false);
  });

  it('a tray Quit with nothing waiting adds no work (D26)', async () => {
    const { QUIT_FLUSH_EVENT } = await import('@/api/window');
    const work: Promise<unknown>[] = [];
    window.dispatchEvent(new CustomEvent(QUIT_FLUSH_EVENT, { detail: { waitUntil: (p: Promise<unknown>) => void work.push(p) } }));
    expect(work).toEqual([]);
  });

  it('moves focus to the next card so the keyboard user is not dropped to <body>', async () => {
    await removeFirst();
    await waitFor(() => expect(document.activeElement?.closest('[data-source-id]')?.getAttribute('data-source-id')).toBe('b'));
  });
});

describe('cancel a refresh from the card (C8)', () => {
  async function startRefresh() {
    rpcMock.handlers['sources.list'] = () => [xtream('a')];
    let reject: (e: unknown) => void = () => undefined;
    rpcMock.handlers['sources.refresh'] = () =>
      new Promise((_, rj) => {
        reject = rj;
      });
    rpcMock.handlers['sources.cancelImport'] = () => true;
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('source-refresh'));
    act(() => handleImportEvent({ sourceId: 'a', phase: 'parsing', done: 1200, total: 50000 }));
    return { reject: (e: unknown) => reject(e) };
  }

  it('shows Cancel while the import runs, sends sources.cancelImport, and ends in a calm cancelled state', async () => {
    const run = await startRefresh();
    const cancel = await screen.findByTestId('import-cancel');
    expect(cancel.textContent).toBe('Cancel import');
    fireEvent.click(cancel);
    await waitFor(() => expect(rpcMock.callsOf('sources.cancelImport')).toEqual([{ id: 'a' }]));
    await waitFor(() => expect(screen.getByTestId('import-cancel').textContent).toBe('Cancelling…'));
    expect(screen.getByTestId('import-cancel').getAttribute('aria-disabled')).toBe('true');
    // The core acknowledges, then the refresh call rejects with its cancel error.
    act(() => handleImportEvent({ sourceId: 'a', phase: 'cancelled', done: 1200 }));
    await act(async () => run.reject(new RpcError('conflict', 'the import stopped')));
    const view = await screen.findByTestId('import-progress');
    expect(view.getAttribute('data-phase')).toBe('cancelled');
    expect(within(view).getByTestId('import-progress-phase').textContent).toBe('Import cancelled');
    expect(within(view).getByTestId('import-cancelled-note').textContent).toBe('The channels from the last import are kept.');
    expect(screen.queryByTestId('import-cancel')).toBeNull();
    // A cancel is not a failure: no error toast.
    expect(toasts().filter((t) => t.variant === 'error')).toEqual([]);
    expect(useImportProgressStore.getState().cancelling).toEqual({});
  });

  it('a cancel that arrives after the import finished clears the Cancelling state', async () => {
    await startRefresh();
    rpcMock.handlers['sources.cancelImport'] = () => false;
    fireEvent.click(await screen.findByTestId('import-cancel'));
    await waitFor(() => expect(rpcMock.callsOf('sources.cancelImport')).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('import-cancel').textContent).toBe('Cancel import'));
  });

  it('a failed cancel request says so and leaves the import running', async () => {
    await startRefresh();
    rpcMock.handlers['sources.cancelImport'] = () => {
      throw new RpcError('network', 'backend unreachable');
    };
    fireEvent.click(await screen.findByTestId('import-cancel'));
    await waitFor(() => expect(toasts().some((t) => t.title === "Couldn't cancel the import")).toBe(true));
    expect(screen.getByTestId('import-cancel').textContent).toBe('Cancel import');
  });

  it('a real failure after no cancel still toasts', async () => {
    const run = await startRefresh();
    await act(async () => run.reject(new RpcError('timeout', 'xt.example.com did not respond in time.')));
    await waitFor(() => expect(toasts().some((t) => t.variant === 'error')).toBe(true));
  });
});

describe('Refresh all can be stopped', () => {
  it('Stop cancels the running import and skips the rest', async () => {
    rpcMock.handlers['sources.list'] = () => [xtream('a'), xtream('b'), xtream('c')];
    const rejects: ((e: unknown) => void)[] = [];
    rpcMock.handlers['sources.refresh'] = () => new Promise((_, rj) => rejects.push(rj));
    rpcMock.handlers['sources.cancelImport'] = () => true;
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('sources-refresh-all'));
    const stop = await screen.findByTestId('sources-refresh-all-stop');
    fireEvent.click(stop);
    await waitFor(() => expect(rpcMock.callsOf('sources.cancelImport')).toEqual([{ id: 'a' }]));
    await act(async () => rejects[0]!(new RpcError('conflict', 'the import stopped')));
    await waitFor(() => expect(screen.queryByTestId('sources-refresh-all-stop')).toBeNull());
    expect(rpcMock.callsOf('sources.refresh')).toEqual([{ id: 'a' }]);
    expect(toasts().map((t) => t.title)).toContain('Refresh stopped: 0 of 3 done');
    expect(toasts().some((t) => t.variant === 'error')).toBe(false);
  });
});

describe('cancel while adding a source (C8)', () => {
  it('stops the import, removes the empty source it created, and keeps the form filled', async () => {
    let rejectAdd: (e: unknown) => void = () => undefined;
    rpcMock.handlers['sources.list'] = () => [];
    rpcMock.handlers['sources.add'] = () =>
      new Promise((_, rj) => {
        rejectAdd = rj;
      });
    rpcMock.handlers['sources.cancelImport'] = () => true;
    rpcMock.handlers['sources.remove'] = () => null;
    renderAt(routes(), '/sources?add=1&kind=m3u');
    const dlg = await screen.findByRole('dialog');
    fireEvent.change(within(dlg).getByLabelText(/^Name/, { selector: 'input' }), { target: { value: 'Huge list' } });
    const url = within(dlg).getByLabelText(/^Playlist URL/, { selector: 'input' }) as HTMLInputElement;
    fireEvent.change(url, { target: { value: 'http://lists.example.com/huge.m3u' } });
    fireEvent.click(screen.getByTestId('add-source-submit'));
    await waitFor(() => expect(rpcMock.callsOf('sources.add')).toHaveLength(1));
    act(() => handleImportEvent({ sourceId: 'new1', phase: 'fetching', done: 0 }));
    fireEvent.click(await within(dlg).findByTestId('import-cancel'));
    await waitFor(() => expect(rpcMock.callsOf('sources.cancelImport')).toEqual([{ id: 'new1' }]));
    act(() => handleImportEvent({ sourceId: 'new1', phase: 'cancelled', done: 0 }));
    await act(async () => rejectAdd(new RpcError('conflict', 'the import stopped', false, { sourceId: 'new1' })));
    const note = await screen.findByTestId('add-source-cancelled');
    expect(note.textContent).toContain('Import cancelled');
    expect(note.textContent).toContain('Nothing was added.');
    expect(rpcMock.callsOf('sources.remove')).toEqual([{ id: 'new1' }]);
    expect(screen.queryByTestId('add-source-error')).toBeNull();
    expect(url.value).toBe('http://lists.example.com/huge.m3u');
    // The button is back to a plain add (no failed source on file).
    expect(screen.getByTestId('add-source-submit').textContent).toBe('Add source');
  });

  it('Escape still closes the dialog after a cancel: focus stays inside it (D18)', async () => {
    let rejectAdd: (e: unknown) => void = () => undefined;
    rpcMock.handlers['sources.list'] = () => [];
    rpcMock.handlers['sources.add'] = () =>
      new Promise((_, rj) => {
        rejectAdd = rj;
      });
    rpcMock.handlers['sources.cancelImport'] = () => true;
    rpcMock.handlers['sources.remove'] = () => null;
    renderAt(routes(), '/sources?add=1&kind=m3u');
    const dlg = await screen.findByRole('dialog');
    fireEvent.change(within(dlg).getByLabelText(/^Name/, { selector: 'input' }), { target: { value: 'Huge list' } });
    fireEvent.change(within(dlg).getByLabelText(/^Playlist URL/, { selector: 'input' }), { target: { value: 'http://lists.example.com/huge.m3u' } });
    fireEvent.click(screen.getByTestId('add-source-submit'));
    await waitFor(() => expect(rpcMock.callsOf('sources.add')).toHaveLength(1));
    act(() => handleImportEvent({ sourceId: 'new1', phase: 'fetching', done: 0 }));
    const cancel = await within(dlg).findByTestId('import-cancel');
    cancel.focus();
    fireEvent.click(cancel);
    // While the cancel is out the button keeps focus (no native disabled, which drops it to <body>).
    await waitFor(() => expect(cancel.getAttribute('aria-disabled')).toBe('true'));
    expect(dlg.contains(document.activeElement)).toBe(true);
    act(() => handleImportEvent({ sourceId: 'new1', phase: 'cancelled', done: 0 }));
    await act(async () => rejectAdd(new RpcError('conflict', 'the import stopped', false, { sourceId: 'new1' })));
    await screen.findByTestId('add-source-cancelled');
    // The cancel button is gone; focus moved to the notice inside the dialog, not <body>.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('add-source-cancelled')));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    // Escape reached the dialog: with the typed details still there, it asks before dropping them (SS-1).
    await screen.findByTestId('discard-prompt');
    confirmDiscard();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('after a failed add, focus lands inside the dialog so Escape closes it (D18)', async () => {
    let rejectAdd: (e: unknown) => void = () => undefined;
    rpcMock.handlers['sources.list'] = () => [];
    rpcMock.handlers['sources.add'] = () =>
      new Promise((_, rj) => {
        rejectAdd = rj;
      });
    renderAt(routes(), '/sources?add=1&kind=m3u');
    const dlg = await screen.findByRole('dialog');
    fireEvent.change(within(dlg).getByLabelText(/^Name/, { selector: 'input' }), { target: { value: 'Huge list' } });
    fireEvent.change(within(dlg).getByLabelText(/^Playlist URL/, { selector: 'input' }), { target: { value: 'http://lists.example.com/huge.m3u' } });
    fireEvent.click(screen.getByTestId('add-source-submit'));
    await waitFor(() => expect(rpcMock.callsOf('sources.add')).toHaveLength(1));
    act(() => handleImportEvent({ sourceId: 'new1', phase: 'parsing', done: 5 }));
    (await within(dlg).findByTestId('import-cancel')).focus();
    await act(async () => rejectAdd(new RpcError('internal', 'disk full')));
    await screen.findByTestId('add-source-error');
    await waitFor(() => expect(dlg.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await screen.findByTestId('discard-prompt');
    confirmDiscard();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps progress and Cancel when the source list refetches mid-import (D15)', async () => {
    let listed: ReturnType<typeof makeSource>[] = [];
    rpcMock.handlers['sources.list'] = () => listed;
    rpcMock.handlers['sources.add'] = () => new Promise(() => undefined);
    renderAt(routes(), '/sources?add=1&kind=m3u');
    const dlg = await screen.findByRole('dialog');
    fireEvent.change(within(dlg).getByLabelText(/^Name/, { selector: 'input' }), { target: { value: 'Huge list' } });
    fireEvent.change(within(dlg).getByLabelText(/^Playlist URL/, { selector: 'input' }), { target: { value: 'http://lists.example.com/huge.m3u' } });
    fireEvent.click(screen.getByTestId('add-source-submit'));
    await waitFor(() => expect(rpcMock.callsOf('sources.add')).toHaveLength(1));
    act(() => handleImportEvent({ sourceId: 'new1', phase: 'parsing', done: 1200 }));
    await within(dlg).findByTestId('import-cancel');
    // The core already lists the new source; a refetch must not make the dialog forget its run.
    listed = [makeSource('new1')];
    await act(async () => {
      await invalidate('sources.');
    });
    await waitFor(() => expect(rpcMock.callsOf('sources.list').length).toBeGreaterThan(1));
    expect(within(dlg).getByTestId('import-cancel')).toBeTruthy();
    expect(within(dlg).getByTestId('import-progress').textContent).toContain('1,200');
  });
});

describe('ImportProgressView', () => {
  it('names every phase, cancelled included', () => {
    render(<ImportProgressView entry={{ sourceId: 's', phase: 'cancelled', done: 0, at: 0 }} />);
    expect(screen.getByTestId('import-progress-phase').textContent).toBe('Import cancelled');
    // No bar for a run that is over and incomplete.
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('summarizes an error by its code (C10) and redacts the raw text', () => {
    render(
      <ImportProgressView
        entry={{ sourceId: 's', phase: 'error', done: 0, at: 0, code: 'auth', message: 'http://h/get.php?username=u&password=hunter2 says no' }}
      />,
    );
    const view = screen.getByTestId('import-progress');
    expect(view.textContent).toContain("The server didn't accept the login.");
    expect(view.textContent).not.toContain('hunter2');
  });

  it('hides Cancel when no handler is given or the run is over', () => {
    const { rerender } = render(<ImportProgressView entry={{ sourceId: 's', phase: 'saving', done: 1, at: 0 }} />);
    expect(screen.queryByTestId('import-cancel')).toBeNull();
    rerender(<ImportProgressView entry={{ sourceId: 's', phase: 'done', done: 1, at: 0 }} onCancel={() => undefined} />);
    expect(screen.queryByTestId('import-cancel')).toBeNull();
  });

  it('shows an M3U download in bytes, other counts in items (D16)', () => {
    const { rerender } = render(<ImportProgressView kind="m3u" entry={{ sourceId: 's', phase: 'fetching', done: 3_150_411, at: 0 }} />);
    const text = () => screen.getByTestId('import-progress').textContent ?? '';
    expect(text()).toContain('3 MB downloaded');
    expect(text()).not.toContain('items');
    rerender(<ImportProgressView kind="m3u" entry={{ sourceId: 's', phase: 'parsing', done: 1200, at: 0 }} />);
    expect(text()).toContain('1,200 items');
    // A Stalker portal counts channels while it fetches.
    rerender(<ImportProgressView kind="stalker" entry={{ sourceId: 's', phase: 'fetching', done: 300, at: 0 }} />);
    expect(text()).toContain('300 items');
  });
});

describe('error codes first (C10)', () => {
  it('classifies a source error by lastErrorCode before its text', () => {
    expect(classifySourceError('something odd happened', 'auth').kind).toBe('auth');
    expect(classifySourceError('something odd happened', 'timeout').kind).toBe('timeout');
    expect(classifySourceError('Could not reach h.example.com. connection refused', 'network')).toEqual({ kind: 'refused', host: 'h.example.com' });
    // `invalid` alone reads as a plain "couldn't read" (R1-5); with the wrong-URL wording it names the cause.
    expect(classifySourceError('bad header', 'invalid').kind).toBe('invalid');
    expect(classifySourceError('h.example.com answered with a web page instead of', 'invalid').kind).toBe('wrongUrl');
    // Without a code the text still decides (older cores).
    expect(classifySourceError('HTTP 401 Unauthorized').kind).toBe('auth');
  });

  it('import events and connection tests use the code when present', () => {
    expect(importErrorCode('totally unrecognised', 'not_found')).toBe('not_found');
    expect(importErrorCode('HTTP 401', 'internal')).toBe('auth');
    expect(importErrorCode('HTTP 401')).toBe('auth');
    expect(importSummaryKey(undefined, 'timeout')).toBe('errorSummaryTimeout');
  });

  it('the source card shows the coded category, not the raw text', async () => {
    rpcMock.handlers['sources.list'] = () => [xtream('a', { lastError: 'weird provider text', lastErrorCode: 'auth' })];
    renderAt(routes(), '/sources');
    const msg = await screen.findByTestId('source-error-message');
    expect(msg.getAttribute('data-kind')).toBe('auth');
  });

  it('recognises the core cancel error', () => {
    expect(isCancelledImportError({ code: 'conflict', message: 'the import stopped because the source was removed' })).toBe(true);
    expect(isCancelledImportError({ code: 'conflict', message: 'a source with this name already exists' })).toBe(false);
    expect(isCancelledImportError({ code: 'network', message: 'cancelled by peer' })).toBe(false);
    // details.cancelled (C8) wins regardless of the wording (D17).
    expect(isCancelledImportError(new RpcError('conflict', 'source settings changed', false, { sourceId: 's', cancelled: true }))).toBe(true);
    expect(isCancelledImportError(new RpcError('conflict', 'source settings changed', false, { sourceId: 's' }))).toBe(false);
  });
});

describe('credentials and hostile input', () => {
  it('masks a Stalker MAC on the card', () => {
    expect(maskMac('00:1A:79:AB:CD:56')).toBe('00:1A:79:••:••:56');
    expect(maskMac('legacy-mac-value')).toBe('le••••ue');
    expect(maskMac('ab')).toBe('••••');
    const s = makeSource('s', {
      kind: 'stalker',
      m3u: undefined,
      stalker: { portalUrl: 'http://portal.example.com/c/', macAddress: '00:1A:79:12:34:56', isFullPortal: false, headers: {} },
    });
    const text = sourceOrigin(s, i18n.getFixedT('en', 'sources'));
    expect(text).not.toContain('12:34');
    expect(text).toContain('portal.example.com');
  });

  it('displayHost never shows credentials from text that is not a URL', () => {
    expect(displayHost('alice:pw-secret@host.example.com/get.php')).not.toContain('pw-secret');
    expect(displayHost('host/get.php?username=alice&password=pw-secret')).not.toContain('pw-secret');
    expect(displayHost('http://alice:pw@host.example.com:8080/x')).toBe('host.example.com:8080');
  });

  it('suggestName survives a broken percent escape', () => {
    expect(() => suggestName('http://h.example.com/%E0%A4%A.m3u')).not.toThrow();
    expect(suggestName('http://h.example.com/%E0%A4%A.m3u')).toBe('%E0%A4%A');
  });

  it('refuses a web file too large to read in the tab, with its size', async () => {
    expect(formatFileSize(300 * 1024 * 1024, 'en')).toBe('300 MB');
    expect(formatFileSize(1.5 * 1024 ** 3, 'en')).toBe('1.5 GB');
    rpcMock.handlers['sources.list'] = () => [];
    renderAt(routes(), '/sources?add=1&kind=m3u');
    const dlg = await screen.findByRole('dialog');
    fireEvent.click(within(dlg).getByRole('tab', { name: 'File' }));
    const file = new File(['#EXTM3U'], 'huge.m3u');
    Object.defineProperty(file, 'size', { value: MAX_WEB_FILE_BYTES + 1 });
    const read = vi.spyOn(FileReader.prototype, 'readAsArrayBuffer');
    fireEvent.change(screen.getByTestId('m3u-file-input'), { target: { files: [file] } });
    const alert = await within(dlg).findByRole('alert');
    expect(alert.textContent).toContain('too large to open here');
    expect(alert.textContent).toContain('200 MB');
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  });
});

describe('review round 1', () => {
  it('a 5xx reads as server trouble, not unreachable, with or without the server code (R1-3)', () => {
    expect(classifySourceError('lists.example.com answered the playlist download: HTTP 503 Service Unavailable', 'network')).toEqual({
      kind: 'server',
      host: 'lists.example.com',
    });
    expect(classifySourceError('xt.example.com sent HTTP 500 Internal Server Error').kind).toBe('server');
    expect(classifySourceError('upstream failed', 'server').kind).toBe('server');
    // A gateway timeout stays a timeout; a plain network failure stays network.
    expect(classifySourceError('h.example.com sent HTTP 504 Gateway Timeout').kind).toBe('timeout');
    expect(classifySourceError('Could not reach h.example.com. error sending request', 'network').kind).toBe('network');
    expect(importSummaryKey('HTTP 502 Bad Gateway from upstream')).toBe('errorSummaryServer');
  });

  it('shows the error code in Technical details, and parser text only there (R1-2, R1-5)', async () => {
    const raw = 'unreadable response (EOF while parsing a value at line 1 column 25)';
    rpcMock.handlers['sources.list'] = () => [xtream('a', { lastError: raw, lastErrorCode: 'invalid' })];
    renderAt(routes(), '/sources');
    const msg = await screen.findByTestId('source-error-message');
    expect(msg.getAttribute('data-kind')).toBe('invalid');
    expect(msg.textContent).toBe("xt.example.com:8080 sent something the app couldn't read. Try again; if it keeps happening, check the address with your provider.");
    expect(msg.textContent).not.toContain('EOF');
    expect(screen.getByTestId('source-error-detail').textContent).toBe(raw);
    expect(screen.getByTestId('source-error-code').textContent).toBe('Error code: invalid');
  });

  it('keeps the code visible for an error the app does not recognise (R1-2)', async () => {
    rpcMock.handlers['sources.list'] = () => [xtream('a', { lastError: 'disk is full', lastErrorCode: 'io' })];
    renderAt(routes(), '/sources');
    expect((await screen.findByTestId('source-error-code')).textContent).toBe('Error code: io');
  });

  it('gives sign-in advice per kind: MAC only for Stalker (R1-4)', async () => {
    const stb = makeSource('s', {
      kind: 'stalker',
      name: 'STB',
      m3u: undefined,
      stalker: { portalUrl: 'http://stb.example.com/c/', macAddress: '00:1A:79:12:34:56', isFullPortal: false, headers: {} },
      lastError: 'refused the handshake',
      lastErrorCode: 'auth',
    });
    const m3u = makeSource('m', { name: 'List', lastError: 'HTTP 401 Unauthorized', lastErrorCode: 'auth' });
    rpcMock.handlers['sources.list'] = () => [xtream('a', { lastError: 'rejected the username or password', lastErrorCode: 'auth' }), stb, m3u];
    renderAt(routes(), '/sources');
    await waitFor(() => expect(screen.getAllByTestId('source-error-message')).toHaveLength(3));
    const [xt, st, pl] = screen.getAllByTestId('source-error-message').map((e) => e.textContent ?? '');
    expect(xt).toContain('username and password');
    expect(xt).not.toContain('MAC');
    expect(st).toContain('MAC address');
    expect(pl).toContain('playlist URL');
    expect(pl).not.toContain('MAC');
  });

  it('lines stats and actions up across cards, and drops "Not refreshed yet" beside a failure (R1-6)', async () => {
    rpcMock.handlers['sources.list'] = () => [
      makeSource('m', { name: 'Plain list', lastError: 'Could not reach h.example.com. error sending request', lastRefreshAt: undefined }),
      xtream('a', { lastRefreshAt: new Date().toISOString() }),
    ];
    renderAt(routes(), '/sources');
    await waitFor(() => expect(cards()).toEqual(['m', 'a']));
    const [m, a] = screen.getAllByTestId('source-card');
    // The list's columns on every card, right-aligned against the actions, so each column holds one
    // kind of count (review round 2); only the columns some card uses (no radio here, SS-10). The
    // playlist has no movies or series: a dash there.
    const columns = (card: HTMLElement) => within(card).getAllByTestId('source-stat').map((e) => e.dataset['stat']);
    expect(columns(m!)).toEqual(['channels', 'movies', 'series']);
    expect(columns(a!)).toEqual(['channels', 'movies', 'series']);
    const empty = (card: HTMLElement) => within(card).getAllByTestId('source-stat').filter((e) => e.dataset['empty'] === '').map((e) => e.dataset['stat']);
    expect(empty(m!)).toEqual(['movies', 'series']);
    expect(empty(a!)).toEqual([]);
    for (const slot of [...within(m!).getAllByTestId('source-stat'), ...within(a!).getAllByTestId('source-stat')]) expect(slot.className).toContain('w-14');
    // The same three action places on every card (Refresh, Edit, More), so they line up down the list.
    expect(within(m!).getByTestId('source-actions').children).toHaveLength(3);
    expect(within(a!).getByTestId('source-actions').children).toHaveLength(3);
    expect(within(m!).queryByTestId('source-refreshed')).toBeNull();
    expect(within(m!).queryByText('Not refreshed yet')).toBeNull();
    expect(within(a!).getByTestId('source-refreshed')).toBeTruthy();
    // Mixed-direction names and hosts get their own direction (Arabic UI, Latin name).
    expect(within(m!).getByTestId('source-name').getAttribute('dir')).toBe('auto');
  });

  it('locks the other kind tabs while an import runs (R1-7)', async () => {
    rpcMock.handlers['sources.list'] = () => [];
    rpcMock.handlers['sources.add'] = () => new Promise(() => undefined);
    renderAt(routes(), '/sources?add=1&kind=m3u');
    const dlg = await screen.findByRole('dialog');
    fireEvent.change(within(dlg).getByLabelText(/^Name/, { selector: 'input' }), { target: { value: 'Huge list' } });
    fireEvent.change(within(dlg).getByLabelText(/^Playlist URL/, { selector: 'input' }), { target: { value: 'http://lists.example.com/huge.m3u' } });
    const tab = (name: RegExp) => within(dlg).getByRole('tab', { name }) as HTMLButtonElement;
    expect(tab(/Xtream/).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('add-source-submit'));
    await waitFor(() => expect(rpcMock.callsOf('sources.add')).toHaveLength(1));
    expect(tab(/Xtream/).disabled).toBe(true);
    expect(tab(/Stalker/).disabled).toBe(true);
    expect(tab(/M3U/).getAttribute('aria-selected')).toBe('true');
  });
});

describe('B8 core messages', () => {
  const UNREADABLE =
    'The server sent a reply the app could not read. Check the server URL.\n\nTechnical detail: Xtream get_live_streams: EOF while parsing a value at line 1 column 25';

  it('splits the plain message from its technical detail', () => {
    expect(splitErrorText(UNREADABLE)).toEqual({
      plain: 'The server sent a reply the app could not read. Check the server URL.',
      detail: 'Xtream get_live_streams: EOF while parsing a value at line 1 column 25',
    });
    expect(splitErrorText('server: h.example.com answered the playlist download: HTTP 503')).toEqual({
      plain: 'h.example.com answered the playlist download: HTTP 503',
    });
  });

  it('the card shows the unreadable advice, with the serde text only in Technical details', async () => {
    rpcMock.handlers['sources.list'] = () => [xtream('a', { lastError: UNREADABLE, lastErrorCode: 'invalid' })];
    renderAt(routes(), '/sources');
    const msg = await screen.findByTestId('source-error-message');
    expect(msg.getAttribute('data-kind')).toBe('unreadable');
    expect(msg.textContent).toBe("xt.example.com:8080 sent a reply the app couldn't read. Check the server URL.");
    expect(msg.textContent).not.toContain('EOF');
    expect(screen.getByTestId('source-error-detail').textContent).toBe('Xtream get_live_streams: EOF while parsing a value at line 1 column 25');
    // Without a code (older core) the text alone still picks it.
    expect(classifySourceError(UNREADABLE).kind).toBe('unreadable');
  });

  it('an unrecognised error with a detail keeps only its plain part in view', async () => {
    rpcMock.handlers['sources.list'] = () => [xtream('a', { lastError: 'Something odd.\n\nTechnical detail: stack frames here' })];
    renderAt(routes(), '/sources');
    expect((await screen.findByTestId('source-error-plain')).textContent).toBe('Something odd.');
    expect(screen.getByTestId('source-error-detail').textContent).toBe('stack frames here');
  });

  it('host patterns still match with "The download failed after N tries." appended and a "server: " prefix', () => {
    const tries = ' The download failed after 3 tries.';
    expect(classifySourceError(`Could not reach lists.example.com. error sending request${tries}`, 'network')).toEqual({
      kind: 'network',
      host: 'lists.example.com',
    });
    expect(classifySourceError(`lists.example.com did not respond in time.${tries}`, 'timeout')).toEqual({ kind: 'timeout', host: 'lists.example.com' });
    expect(classifySourceError(`server: lists.example.com answered the playlist download: HTTP 503 Service Unavailable.${tries}`, 'server')).toEqual({
      kind: 'server',
      host: 'lists.example.com',
    });
    // No code at all: the prefixed 5xx text still reads as server trouble.
    expect(classifySourceError(`server: lists.example.com answered the playlist download: HTTP 502 Bad Gateway.${tries}`)).toEqual({
      kind: 'server',
      host: 'lists.example.com',
    });
  });

  it('shows a localized retry line, kept while the retried download reports bytes', () => {
    act(() => handleImportEvent({ sourceId: 's', phase: 'fetching', done: 0, message: 'Retrying the download (try 2 of 3)', attempt: 2, attempts: 3 } as never));
    const entry = () => useImportProgressStore.getState().bySource['s'];
    expect(entry()).toMatchObject({ attempt: 2, attempts: 3 });
    const { rerender } = render(<ImportProgressView kind="m3u" entry={entry()} />);
    expect(screen.getByTestId('import-retry').textContent).toBe('Retrying the download (try 2 of 3)');
    act(() => handleImportEvent({ sourceId: 's', phase: 'fetching', done: 2_000_000 }));
    rerender(<ImportProgressView kind="m3u" entry={entry()} />);
    expect(screen.getByTestId('import-retry').textContent).toBe('Retrying the download (try 2 of 3)');
    act(() => handleImportEvent({ sourceId: 's', phase: 'parsing', done: 10 }));
    rerender(<ImportProgressView kind="m3u" entry={entry()} />);
    expect(screen.queryByTestId('import-retry')).toBeNull();
    // Nonsense fields are ignored.
    act(() => handleImportEvent({ sourceId: 't', phase: 'fetching', done: 0, attempt: 'x', attempts: 3 } as never));
    expect(useImportProgressStore.getState().bySource['t']?.attempt).toBeUndefined();
  });

  it('localizes the retry line', async () => {
    const { loadLanguage } = await import('@/i18n');
    await loadLanguage('de');
    await i18n.changeLanguage('de');
    try {
      render(<ImportProgressView entry={{ sourceId: 's', phase: 'fetching', done: 0, at: 0, attempt: 3, attempts: 3 }} />);
      expect(screen.getByTestId('import-retry').textContent).toBe('Download wird wiederholt (Versuch 3 von 3)');
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('the error line drops the technical detail after the separator', () => {
    render(<ImportProgressView entry={{ sourceId: 's', phase: 'error', done: 0, at: 0, code: 'invalid', message: UNREADABLE }} />);
    const view = screen.getByTestId('import-progress').textContent ?? '';
    expect(view).toContain('The server sent a reply the app could not read.');
    expect(view).not.toContain('EOF');
  });
});

describe('review round 2', () => {
  const bytes = (...b: number[]) => new Uint8Array(b);

  it('decodes a picked playlist by BOM, then strict UTF-8, then Windows-1252 (R2-1)', async () => {
    // "#EÜ" in each encoding.
    expect(decodeText(bytes(0xff, 0xfe, 0x23, 0x00, 0x45, 0x00, 0xdc, 0x00))).toBe('#EÜ');
    expect(decodeText(bytes(0xfe, 0xff, 0x00, 0x23, 0x00, 0x45, 0x00, 0xdc))).toBe('#EÜ');
    expect(decodeText(bytes(0xef, 0xbb, 0xbf, 0x23, 0x45, 0xc3, 0x9c))).toBe('#EÜ');
    expect(decodeText(bytes(0x23, 0x45, 0xc3, 0x9c))).toBe('#EÜ');
    // Not valid UTF-8: Windows-1252, where 0xDC is Ü and 0x80 is the euro sign.
    expect(decodeText(bytes(0x23, 0x45, 0xdc, 0x20, 0x80))).toBe('#EÜ €');
    // Through a real File, the way M3uForm reads it.
    const utf16 = new File([bytes(0xff, 0xfe, 0x23, 0x00, 0x45, 0x00, 0x58, 0x00, 0x54, 0x00)], 'list.m3u');
    expect(await readFileText(utf16)).toBe('#EXT');
    const cp1252 = new File([bytes(0x43, 0x61, 0x66, 0xe9)], 'list.m3u');
    expect(await readFileText(cp1252)).toBe('Café');
  });

  it('decodes like the core: BOM-less UTF-16 and per-line, per-run Windows-1252 (R3-F2)', () => {
    const utf16 = (s: string, le: boolean) =>
      Uint8Array.from([...s].flatMap((c) => {
        const u = c.charCodeAt(0);
        return le ? [u & 0xff, u >> 8] : [u >> 8, u & 0xff];
      }));
    const latin1 = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
    const utf8 = (s: string) => new TextEncoder().encode(s);
    const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
    const playlist = '#EXTM3U\r\n#EXTINF:-1 group-title="Nachrichten",Café Zürich\r\nhttp://h/a.ts\r\n';
    // No byte-order mark: "#\0" is UTF-16LE, "\0#" UTF-16BE (parser.rs utf16_start).
    expect(decodeText(utf16(playlist, true))).toBe(playlist);
    expect(decodeText(utf16(playlist, false))).toBe(playlist);
    // A trailing odd byte is ignored, as in the core.
    expect(decodeText(concat(utf16('#EXTM3U', true), bytes(0x41)))).toBe('#EXTM3U');
    // Mixed file: a UTF-8 line and a cp1252 line each keep their text.
    const mixed = decodeText(concat(utf8('#EXTM3U\n#EXTINF:-1,Café UTF8\nhttp://h/a.ts\n'), latin1('#EXTINF:-1,Caf\xe9 1252\nhttp://h/b.ts\n')));
    expect(mixed).toContain(',Café UTF8\n');
    expect(mixed).toContain(',Café 1252\n');
    // Within one line, only the invalid byte is cp1252; the UTF-8 run stays UTF-8.
    expect(decodeText(concat(utf8('Zürich '), latin1('Caf\xe9')))).toBe('Zürich Café');
    // Bytes cp1252 leaves undefined are U+FFFD, as the core's table (not WHATWG's C1 controls).
    expect(decodeText(bytes(0x41, 0x81, 0x9d))).toBe('A��');
    // A truncated sequence ending the file is cp1252 over all its bytes (core: whole line, not truncated).
    expect(decodeText(bytes(0x41, 0xe2, 0x82))).toBe('Aâ‚');
    // B8's examples for parser.rs line_text.
    expect(decodeText(concat(utf8('Café '), latin1('\xe9t\xe9')))).toBe('Café été');
    expect(decodeText(latin1('T\xe9l\xe9 \x80 \x96'))).toBe('Télé € –');
    expect(decodeText(latin1('x\x81y'))).toBe('x�y');
    expect(decodeText(latin1('Caf\xc3'))).toBe('CafÃ');
    expect(decodeText(latin1('\xe2\x82 x'))).toBe('â‚ x');
  });

  it('reads BOM-less UTF-16 subtitle files by where the NULs fall (wiring-r1 F5)', async () => {
    const utf16 = (s: string, le: boolean) =>
      Uint8Array.from([...s].flatMap((c) => {
        const u = c.charCodeAt(0);
        return le ? [u & 0xff, u >> 8] : [u >> 8, u & 0xff];
      }));
    const srt = '1\r\n00:00:01,000 --> 00:00:02,500\r\nGrüß Gott\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nこんにちは\r\n';
    expect(decodeText(utf16(srt, true))).toBe(srt);
    expect(decodeText(utf16(srt, false))).toBe(srt);
    expect(await readFileText(new File([utf16(srt, true)], 'movie.srt'))).toBe(srt);
    // Mostly non-ASCII lines still have ASCII timecodes and arrows to go on.
    const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.000\n日本語の字幕です。日本語の字幕です。\n';
    expect(decodeText(utf16(vtt, true))).toBe(vtt);
    // Text without NULs is untouched: UTF-8 and cp1252 decode as before.
    expect(decodeText(new TextEncoder().encode(srt))).toBe(srt);
    expect(decodeText(bytes(0x31, 0x0d, 0x0a, 0x43, 0x61, 0x66, 0xe9))).toBe('1\r\nCafé');
    // A stray NUL or two in 8-bit text is not enough to switch to UTF-16.
    expect(decodeText(bytes(0x41, 0x00, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49))).toBe('A\0BCDEFGHI');
  });

  it('sign-in advice in dialogs and toasts names what each kind signs in with (R2-2)', async () => {
    const auth = { code: 'auth' as const, message: 'rejected the username or password' };
    expect(nextStepKey(auth, 'stalker')).toBe('sourceErrorAuth_stalker');
    expect(nextStepKey(auth, 'xtream')).toBe('sourceErrorAuth_xtream');
    expect(nextStepKey(auth, 'm3u')).toBe('sourceErrorAuth_m3u');
    expect(nextStepKey(auth)).toBe('hintAuth');
    rpcMock.handlers['sources.list'] = () => [xtream('a')];
    rpcMock.handlers['sources.refresh'] = () => {
      throw new RpcError('auth', 'rejected the username or password');
    };
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('source-refresh'));
    await waitFor(() => expect(toasts().some((t) => t.variant === 'error')).toBe(true));
    const description = String(toasts().find((t) => t.variant === 'error')!.description);
    expect(description).toContain('username and password');
    expect(description).not.toContain('MAC');
  });

  it('a Stalker refresh rejected at sign-in points at the MAC address (R2-2)', async () => {
    rpcMock.handlers['sources.list'] = () => [
      makeSource('s', {
        kind: 'stalker',
        name: 'STB',
        m3u: undefined,
        stalker: { portalUrl: 'http://stb.example.com/c/', macAddress: '00:1A:79:12:34:56', isFullPortal: false, headers: {} },
      }),
    ];
    rpcMock.handlers['sources.refresh'] = () => {
      throw new RpcError('auth', 'refused the handshake');
    };
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('source-refresh'));
    await waitFor(() => expect(toasts().some((t) => t.variant === 'error')).toBe(true));
    expect(String(toasts().find((t) => t.variant === 'error')!.description)).toContain('MAC address registered');
  });

  it('server and 429 errors reach the dialog and toast texts (R2-3)', () => {
    const fromCore = RpcError.from({ code: 'server', message: 'h.example.com answered the playlist download: HTTP 503', retryable: true });
    expect(fromCore.code).toBe('server');
    expect(summaryKey(fromCore)).toBe('errorSummaryServer');
    expect(nextStepKey(fromCore)).toBe('hintServer');
    expect(summaryKey(RpcError.from({ code: 'server', message: 'HTTP 429 Too Many Requests', retryable: true }))).toBe('errorSummaryServer');
    // An older core's 429 as network text.
    expect(summaryKey({ code: 'network', message: 'h.example.com answered the playlist download: HTTP 429 Too Many Requests' })).toBe('errorSummaryServer');
    expect(classifySourceError('h.example.com answered the playlist download: HTTP 429 Too Many Requests', 'network').kind).toBe('server');
    expect(i18n.t('sources:errorSummaryServer')).toBe('The server is busy or having trouble.');
  });
});
