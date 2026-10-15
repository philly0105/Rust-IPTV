// What's new (contract C7): the release notes with their icons, closing
// stores the running version (Got it, Escape, the close button), a startup
// open with nothing to list stores it silently, "Take the tour", and the
// loading and empty states.
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.hoisted(() => ({ current: null as null | { call: (cmd: string, args?: unknown) => Promise<unknown> } }));
vi.mock('@/api/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/transport')>();
  const call = async (cmd: string, args?: unknown) => {
    try {
      return await rpcMock.current!.call(cmd, args);
    } catch (e) {
      throw actual.RpcError.from(e);
    }
  };
  return { ...actual, rpc: call, rpcRaw: call };
});
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));

const h = await import('./harness');
let core = h.createCore();
rpcMock.current = { call: (cmd, args) => core.call(cmd, args) };
const { WhatsNewDialog } = await import('../WhatsNewDialog');
const { RELEASE_NOTES } = await import('../notes');
const { closeOverlay, useOnboardingStore } = await import('../store');
const { queryClient, rpcKey } = await import('@/api/query');

const CURRENT = RELEASE_NOTES.find((r) => r.version === h.VERSION)!;

function open(props: { since?: string | null; auto?: boolean } = {}) {
  const onClose = vi.fn();
  h.renderUi(<WhatsNewDialog since={props.since === undefined ? null : props.since} auto={props.auto ?? false} onClose={onClose} />);
  return onClose;
}

const dialog = () => screen.getByTestId('whats-new');

beforeAll(() => h.installDomStubs());
beforeEach(() => {
  h.resetShared();
  core = h.createCore();
  core.state.settings.lastSeenVersion = '0.0.1';
  core.state.settings.tourCompleted = true;
});
afterEach(() => cleanup());

describe("What's new", () => {
  it('lists the release notes, each with its icon, title and text', async () => {
    open();
    const items = await screen.findAllByTestId('whats-new-item');
    expect(items).toHaveLength(CURRENT.items.length);
    expect(screen.getByRole('dialog', { name: "What's new" })).toBeTruthy();
    expect(dialog().textContent).toContain(`Version ${h.VERSION}`);
    const first = items[0]!;
    expect(first.querySelector('svg')).toBeTruthy();
    expect(first.textContent).toContain('Multi-view');
    expect(first.textContent).toContain('Watch up to four live channels at once.');
    // One release: no per-release heading.
    expect(within(dialog()).queryByRole('heading', { level: 3 })).toBeNull();
  });

  it('focuses Got it when it opens', async () => {
    open();
    const close = await screen.findByTestId('whats-new-close');
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect(close.textContent).toContain('Got it');
  });

  it('stores the running version when closed with Got it', async () => {
    const onClose = open({ since: '0.0.1', auto: true });
    // The host opens it only once the version is known; wait for the list like it would.
    await screen.findAllByTestId('whats-new-item');
    fireEvent.click(screen.getByTestId('whats-new-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(core.updates()).toEqual([{ lastSeenVersion: h.VERSION }]));
    expect(core.state.settings.lastSeenVersion).toBe(h.VERSION);
    // The cache moves at once, so the startup decision does not reopen it.
    expect(queryClient.getQueryData<{ lastSeenVersion: string }>(rpcKey('settings.get'))?.lastSeenVersion).toBe(h.VERSION);
  });

  it('stores the running version when closed with Escape', async () => {
    const onClose = open({ since: '0.0.1', auto: true });
    await screen.findAllByTestId('whats-new-item');
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(core.updates()).toEqual([{ lastSeenVersion: h.VERSION }]));
  });

  it('does not write when the version is already stored', async () => {
    core.state.settings.lastSeenVersion = h.VERSION;
    const onClose = open();
    await screen.findAllByTestId('whats-new-item');
    // Wait for settings to load so the dialog knows the stored version.
    await waitFor(() => expect(core.calls.some((c) => c.cmd === 'settings.get')).toBe(true));
    await waitFor(() => expect(queryClient.getQueryData(rpcKey('settings.get'))).toBeTruthy());
    fireEvent.click(screen.getByTestId('whats-new-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(core.updates()).toEqual([]);
  });

  it('closes without an error when the write fails', async () => {
    core.state.failUpdates = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onClose = open({ since: '0.0.1', auto: true });
    await screen.findAllByTestId('whats-new-item');
    fireEvent.click(screen.getByTestId('whats-new-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(warn).toHaveBeenCalled());
  });

  it('a startup open with nothing to list stores the version and shows nothing', async () => {
    const onClose = open({ since: h.VERSION, auto: true });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('whats-new')).toBeNull();
    await waitFor(() => expect(core.updates()).toEqual([{ lastSeenVersion: h.VERSION }]));
  });

  it('a hand-made open with nothing to list says so', async () => {
    core.state.version = '0.0.1';
    open({ since: null, auto: false });
    expect((await screen.findByTestId('whats-new-empty')).textContent).toContain('No release notes for this version yet.');
  });

  it('shows a loading state until the version is known', async () => {
    core.state.holdInfo = true;
    open();
    const loading = await screen.findByTestId('whats-new-loading');
    expect(loading.getAttribute('role')).toBe('status');
    expect(loading.textContent).toContain('Loading');
    expect(screen.queryByTestId('whats-new-item')).toBeNull();
  });

  it('still lists every release when opened by hand and the version cannot be read', async () => {
    core.state.failInfo = true;
    open({ since: null });
    expect(await screen.findAllByTestId('whats-new-item')).toHaveLength(CURRENT.items.length);
  });

  it('offers the tour when a source exists, and opens it after closing', async () => {
    core.addSource();
    useOnboardingStore.setState({ overlay: { kind: 'whatsNew', since: null, auto: false }, pending: null, seq: 1 });
    const onClose = vi.fn(closeOverlay);
    h.renderUi(<WhatsNewDialog since={null} auto={false} onClose={onClose} />);
    const tour = await screen.findByRole('button', { name: 'Take the tour' });
    fireEvent.click(tour);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useOnboardingStore.getState().overlay).toEqual({ kind: 'tour', auto: false });
  });

  it('does not offer the tour without a source', async () => {
    open();
    await screen.findAllByTestId('whats-new-item');
    await waitFor(() => expect(core.calls.some((c) => c.cmd === 'sources.list')).toBe(true));
    expect(screen.queryByRole('button', { name: 'Take the tour' })).toBeNull();
  });
});
