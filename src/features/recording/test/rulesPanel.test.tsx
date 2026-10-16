/**
 * The Scheduled page's series rules panel (Run 2 C5): rules listed enabled first, the pause
 * switch (optimistic, put back on failure), Remove with and without cancelling what the rule
 * already scheduled, and the loading, empty and error states.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '@/api/query';
import { createRpcMock, installDomStubs, renderGuide, router, rule } from '@/features/live/guide/test/harness';
import { useToastStore } from '@/ui';

import { RecordingRulesPanel } from '../components/RulesPanel';

const rpcMock = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import('@/features/live/guide/test/harness')['createRpcMock']> }));
vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<object>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  isDesktop: true,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/shell', async () => await import('../../live/test/fakes'));
vi.mock('@/features/player', async () => await import('../../live/test/fakes'));
vi.mock('@/features/player/remote', async () => await import('../../live/test/fakes'));

rpcMock.current = createRpcMock();
const rpc = rpcMock.current;

const HOUR = 3_600_000;
const RULES = [
  rule({ id: 'paused', title: 'Old Show', enabled: false, upcoming: 0, nextStart: undefined }),
  rule({ id: 'late', title: 'Late Film Club', nextStart: new Date(Date.now() + 30 * HOUR).toISOString(), upcoming: 1 }),
  rule({ id: 'soon', title: 'Evening News', nextStart: new Date(Date.now() + 2 * HOUR).toISOString(), upcoming: 3 }),
  rule({ id: 'none', title: 'Arts Hour', nextStart: undefined, upcoming: 0 }),
];

beforeAll(installDomStubs);
beforeEach(() => {
  // The actions invalidate through the app's client, so the tests render with it.
  queryClient.clear();
  rpc.reset();
  useToastStore.setState({ toasts: [] });
  rpc.handlers['recordings.rules'] = () => RULES;
  rpc.handlers['recordings.setRuleEnabled'] = () => null;
  rpc.handlers['recordings.removeRule'] = () => null;
});
afterEach(cleanup);

const render = () =>
  renderGuide({
    path: '/scheduled',
    routes: [
      { path: '/scheduled', element: <RecordingRulesPanel /> },
      { path: '/epg', element: <p>guide page</p> },
    ],
  }, queryClient);
const rows = () => screen.getAllByTestId('rule-row');
const row = (id: string) => rows().find((r) => r.getAttribute('data-rule-id') === id)!;
const toastTitles = () => useToastStore.getState().toasts.map((t) => t.title);

describe('RecordingRulesPanel', () => {
  it('lists enabled rules by next airing, then paused ones, with their state', async () => {
    render();
    await screen.findAllByTestId('rule-row');
    const panel = screen.getByTestId('recording-rules');
    expect(within(panel).getByRole('heading', { name: 'Series' })).toBeTruthy();
    expect(rows().map((r) => r.getAttribute('data-rule-id'))).toEqual(['soon', 'late', 'none', 'paused']);
    expect(row('soon').textContent).toContain('Next:');
    expect(row('soon').textContent).toContain('Upcoming: 3');
    expect(row('none').textContent).toContain('Nothing scheduled');
    expect(row('paused').textContent).toContain('Paused');
    expect(row('paused').hasAttribute('data-enabled')).toBe(false);
    expect(within(row('paused')).getByRole('switch', { name: 'Record “Old Show”' }).getAttribute('aria-checked')).toBe('false');
    expect(within(row('soon')).getByRole('switch', { name: 'Record “Evening News”' }).getAttribute('aria-checked')).toBe('true');
  });

  it('the switch pauses a rule at once and refreshes the list', async () => {
    let release!: () => void;
    rpc.handlers['recordings.setRuleEnabled'] = () => new Promise<null>((r) => (release = () => r(null)));
    render();
    await screen.findAllByTestId('rule-row');
    const before = rpc.of('recordings.rules').length;
    fireEvent.click(within(row('soon')).getByRole('switch'));
    expect(row('soon').hasAttribute('data-enabled')).toBe(false);
    expect(within(row('soon')).getByRole('switch').getAttribute('aria-checked')).toBe('false');
    expect(rpc.of('recordings.setRuleEnabled')).toEqual([{ id: 'soon', enabled: false }]);
    release();
    await waitFor(() => expect(rpc.of('recordings.rules').length).toBeGreaterThan(before));
  });

  it('a failed switch is put back and says why', async () => {
    rpc.handlers['recordings.setRuleEnabled'] = () => {
      throw new Error('database is locked');
    };
    render();
    await screen.findAllByTestId('rule-row');
    fireEvent.click(within(row('paused')).getByRole('switch'));
    await waitFor(() => expect(toastTitles()).toContain('Could not update the series'));
    expect(rpc.of('recordings.setRuleEnabled')).toEqual([{ id: 'paused', enabled: true }]);
    await waitFor(() => expect(within(row('paused')).getByRole('switch').getAttribute('aria-checked')).toBe('false'));
  });

  it('Remove cancels the scheduled recordings by default', async () => {
    render();
    await screen.findAllByTestId('rule-row');
    fireEvent.click(within(row('soon')).getByRole('button', { name: 'Remove series “Evening News”' }));
    const dialog = await screen.findByTestId('rule-remove-confirm');
    expect(dialog.textContent).toContain('“Evening News” on Channel 1 will no longer be recorded.');
    const box = within(dialog).getByRole('checkbox', { name: 'Also cancel its scheduled recordings (3)' }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(within(dialog).getByTestId('rule-remove-ok'));
    await waitFor(() => expect(rpc.of('recordings.removeRule')).toEqual([{ id: 'soon', keepScheduled: false }]));
    await waitFor(() => expect(screen.queryByTestId('rule-remove-confirm')).toBeNull());
    expect(toastTitles()).toContain('Removed series “Evening News”');
  });

  it('unchecking the box keeps the scheduled recordings', async () => {
    render();
    await screen.findAllByTestId('rule-row');
    fireEvent.click(within(row('late')).getByTestId('rule-remove'));
    const dialog = await screen.findByTestId('rule-remove-confirm');
    fireEvent.click(within(dialog).getByTestId('rule-remove-cancel-scheduled'));
    fireEvent.click(within(dialog).getByTestId('rule-remove-ok'));
    await waitFor(() => expect(rpc.of('recordings.removeRule')).toEqual([{ id: 'late', keepScheduled: true }]));
  });

  it('a rule with nothing scheduled asks no question about it', async () => {
    render();
    await screen.findAllByTestId('rule-row');
    fireEvent.click(within(row('none')).getByTestId('rule-remove'));
    const dialog = await screen.findByTestId('rule-remove-confirm');
    expect(within(dialog).queryByTestId('rule-remove-cancel-scheduled')).toBeNull();
    fireEvent.click(within(dialog).getByTestId('rule-remove-ok'));
    await waitFor(() => expect(rpc.of('recordings.removeRule')).toEqual([{ id: 'none', keepScheduled: true }]));
  });

  it('Cancel removes nothing; the box resets for the next rule', async () => {
    render();
    await screen.findAllByTestId('rule-row');
    fireEvent.click(within(row('soon')).getByTestId('rule-remove'));
    let dialog = await screen.findByTestId('rule-remove-confirm');
    fireEvent.click(within(dialog).getByTestId('rule-remove-cancel-scheduled'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('rule-remove-confirm')).toBeNull());
    fireEvent.click(within(row('late')).getByTestId('rule-remove'));
    dialog = await screen.findByTestId('rule-remove-confirm');
    expect((within(dialog).getByTestId('rule-remove-cancel-scheduled') as HTMLInputElement).checked).toBe(true);
    expect(rpc.of('recordings.removeRule')).toEqual([]);
  });

  it('with no rules it points to the guide', async () => {
    rpc.handlers['recordings.rules'] = () => [];
    render();
    expect(await screen.findByText('No series yet')).toBeTruthy();
    expect(screen.getByText('Pick a programme in the guide and choose Record series.')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Open guide' });
    fireEvent.click(link);
    await waitFor(() => expect(router.location?.pathname).toBe('/epg'));
  });

  it('shows a skeleton while loading, then the error with a retry that works', async () => {
    let fail = true;
    rpc.handlers['recordings.rules'] = () => {
      if (fail) throw new Error('core unavailable');
      return RULES;
    };
    render();
    expect(screen.queryAllByTestId('rule-row')).toEqual([]);
    expect(await screen.findByText(/core unavailable/)).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(rows()).toHaveLength(4));
  });
});
