// OnboardingHost (contract C7): runs the startup decision against the core
// and shows the result. Rule A stores the version silently and starts the
// tour once a source exists; rule B marks the tour done and shows What's new;
// rule C shows What's new after the tour; rule D shows nothing. Overlays wait
// for an idle app, never show together, and never reopen in a session.
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
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
const { OnboardingHost, openTour, openWhatsNew } = await import('..');
const { appIsIdle, START_DELAY_MS, IDLE_POLL_MS } = await import('../host');
const { useOnboardingStore } = await import('../store');
const { queryClient, rpcKey } = await import('@/api/query');

/** Long enough for the start delay, a poll and the lazy chunk. */
const SHOW = { timeout: START_DELAY_MS + IDLE_POLL_MS + 1500 };

function seed(s: { lastSeenVersion: string; tourCompleted: boolean; sources: number }) {
  core.state.settings.lastSeenVersion = s.lastSeenVersion;
  core.state.settings.tourCompleted = s.tourCompleted;
  if (s.sources > 0) core.addSource();
}

const sleep = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const mount = () => h.renderUi(<OnboardingHost />);
const tour = () => screen.queryByTestId('tour');
const whatsNew = () => screen.queryByTestId('whats-new');

beforeAll(() => h.installDomStubs());
beforeEach(() => {
  h.resetShared();
  core = h.createCore();
});
afterEach(() => cleanup());

describe('OnboardingHost', () => {
  it('renders nothing while nothing is open', () => {
    const { container } = mount();
    expect(container.innerHTML).toBe('');
  });

  it('rule A: stores the version silently, then starts the tour once a source exists', async () => {
    seed({ lastSeenVersion: '', tourCompleted: false, sources: 0 });
    mount();
    await waitFor(() => expect(core.updates()).toEqual([{ lastSeenVersion: h.VERSION }]));
    await sleep(START_DELAY_MS + 100);
    expect(tour()).toBeNull();
    expect(whatsNew()).toBeNull();

    core.addSource();
    await act(() => queryClient.invalidateQueries({ queryKey: rpcKey('sources.list') }));
    await waitFor(() => expect(tour()).toBeTruthy(), SHOW);
    expect(whatsNew()).toBeNull();
  });

  it('L4-settings-2: a source whose first import failed does not start the tour; once it imports, it does', async () => {
    seed({ lastSeenVersion: h.VERSION, tourCompleted: false, sources: 1 });
    core.state.sources = core.state.sources.map((s) => ({ ...s, lastError: 'connect timeout', lastErrorCode: 'timeout' as const }));
    mount();
    await waitFor(() => expect(core.calls.some((c) => c.cmd === 'sources.list')).toBe(true));
    await sleep(START_DELAY_MS + IDLE_POLL_MS + 300);
    expect(tour()).toBeNull();

    core.addSource();
    await act(() => queryClient.invalidateQueries({ queryKey: rpcKey('sources.list') }));
    await waitFor(() => expect(tour()).toBeTruthy(), SHOW);
  });

  it('rule A: skipping the tour stores tourCompleted and it does not come back', async () => {
    seed({ lastSeenVersion: h.VERSION, tourCompleted: false, sources: 1 });
    mount();
    await waitFor(() => expect(tour()).toBeTruthy(), SHOW);
    fireEvent.keyDown(screen.getByTestId('tour-card'), { key: 'Escape' });
    expect(tour()).toBeNull();
    await waitFor(() => expect(core.updates()).toEqual([{ tourCompleted: true }]));
    expect(core.state.settings.tourCompleted).toBe(true);
    await sleep(START_DELAY_MS + IDLE_POLL_MS);
    expect(tour()).toBeNull();
    expect(whatsNew()).toBeNull();
  });

  it('rule A: finishing the tour stores tourCompleted', async () => {
    seed({ lastSeenVersion: h.VERSION, tourCompleted: false, sources: 1 });
    mount();
    await waitFor(() => expect(tour()).toBeTruthy(), SHOW);
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByTestId('tour-next'));
    expect(tour()).toBeNull();
    await waitFor(() => expect(core.state.settings.tourCompleted).toBe(true));
  });

  it("rule B: marks the tour done and shows What's new for this version, without the tour", async () => {
    seed({ lastSeenVersion: '', tourCompleted: false, sources: 1 });
    mount();
    await waitFor(() => expect(whatsNew()).toBeTruthy(), SHOW);
    expect(tour()).toBeNull();
    expect(core.updates()[0]).toEqual({ tourCompleted: true });
    expect(useOnboardingStore.getState().overlay).toEqual({ kind: 'whatsNew', since: '', auto: true });

    fireEvent.click(await screen.findByTestId('whats-new-close'));
    await waitFor(() => expect(core.state.settings.lastSeenVersion).toBe(h.VERSION));
    expect(whatsNew()).toBeNull();
    await sleep(START_DELAY_MS + IDLE_POLL_MS);
    expect(tour()).toBeNull();
    expect(whatsNew()).toBeNull();
  });

  it("rule C: shows What's new for an older stored version and stores the new one on close", async () => {
    seed({ lastSeenVersion: '0.0.1', tourCompleted: true, sources: 1 });
    mount();
    await waitFor(() => expect(whatsNew()).toBeTruthy(), SHOW);
    expect(useOnboardingStore.getState().overlay).toEqual({ kind: 'whatsNew', since: '0.0.1', auto: true });
    expect((await screen.findAllByTestId('whats-new-item')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId('whats-new-close'));
    await waitFor(() => expect(core.updates()).toEqual([{ lastSeenVersion: h.VERSION }]));
  });

  it("rule C: What's new waits for the tour, then follows it", async () => {
    seed({ lastSeenVersion: '0.0.1', tourCompleted: false, sources: 1 });
    mount();
    await waitFor(() => expect(tour()).toBeTruthy(), SHOW);
    expect(whatsNew()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
    await waitFor(() => expect(whatsNew()).toBeTruthy(), SHOW);
    expect(tour()).toBeNull();
    fireEvent.click(await screen.findByTestId('whats-new-close'));
    await waitFor(() =>
      expect(core.state.settings).toMatchObject({ tourCompleted: true, lastSeenVersion: h.VERSION }),
    );
  });

  it('rule D: shows nothing and writes nothing', async () => {
    seed({ lastSeenVersion: h.VERSION, tourCompleted: true, sources: 1 });
    mount();
    await waitFor(() => expect(core.calls.some((c) => c.cmd === 'sources.list')).toBe(true));
    await sleep(START_DELAY_MS + IDLE_POLL_MS);
    expect(tour()).toBeNull();
    expect(whatsNew()).toBeNull();
    expect(core.updates()).toEqual([]);
  });

  it('waits while another modal dialog is open', async () => {
    seed({ lastSeenVersion: h.VERSION, tourCompleted: false, sources: 1 });
    const other = document.createElement('div');
    other.setAttribute('role', 'dialog');
    other.setAttribute('aria-modal', 'true');
    document.body.append(other);
    expect(appIsIdle()).toBe(false);
    mount();
    await sleep(START_DELAY_MS + 2 * IDLE_POLL_MS);
    expect(tour()).toBeNull();
    other.remove();
    expect(appIsIdle()).toBe(true);
    await waitFor(() => expect(tour()).toBeTruthy(), SHOW);
  });

  it('does not reopen the tour in the same session when storing it failed', async () => {
    seed({ lastSeenVersion: h.VERSION, tourCompleted: false, sources: 1 });
    core.state.failUpdates = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mount();
    await waitFor(() => expect(tour()).toBeTruthy(), SHOW);
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
    await waitFor(() => expect(warn).toHaveBeenCalled());
    // A refetch brings back the stored (unchanged) settings.
    await act(() => queryClient.invalidateQueries({ queryKey: rpcKey('settings.get') }));
    await sleep(START_DELAY_MS + 2 * IDLE_POLL_MS);
    expect(tour()).toBeNull();
  });

  it('openTour starts the tour by hand, even when it was done', async () => {
    seed({ lastSeenVersion: h.VERSION, tourCompleted: true, sources: 1 });
    mount();
    act(() => openTour());
    await waitFor(() => expect(tour()).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
    expect(tour()).toBeNull();
  });

  it("openWhatsNew opens every release by hand, and a tour asked for meanwhile follows it", async () => {
    seed({ lastSeenVersion: h.VERSION, tourCompleted: true, sources: 1 });
    mount();
    act(() => openWhatsNew());
    await waitFor(() => expect(whatsNew()).toBeTruthy());
    act(() => openTour());
    expect(tour()).toBeNull();
    fireEvent.click(await screen.findByTestId('whats-new-close'));
    await waitFor(() => expect(tour()).toBeTruthy());
    expect(whatsNew()).toBeNull();
  });
});
