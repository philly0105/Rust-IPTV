import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountStatus, ScheduleView } from '@/api/rpc';

import { eagerRoutes, installDomStubs, makeSource, renderAt, rpcMock, settings } from './harness';

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
const { queryClient } = await import('@/api/query');
const { AccountAlerts } = await import('@/shell/dashboard/AccountAlerts');
const { SourceRefreshGroup, choicesWith, formatUnit } = await import('@/features/settings/sections/SourceRefreshGroup');
const { DISMISSED_STORAGE_KEY } = await import('../lib/account');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();

const xtream = (id: string, over = {}) =>
  makeSource(id, {
    kind: 'xtream',
    name: `Panel ${id}`,
    m3u: undefined,
    autoRefresh: true,
    xtream: { serverUrl: 'http://xt.example.com:8080', username: 'alice', password: 'pw-secret' },
    ...over,
  });

function account(sourceId: string, over: Partial<AccountStatus> = {}): AccountStatus {
  return { sourceId, kind: 'xtream', status: 'Active', isTrial: false, checkedAt: at(0), ...over };
}

function mockPage(sources = [xtream('a')], statuses: AccountStatus[] = [], schedule: ScheduleView = { intervalHours: 12, sources: [] }) {
  rpcMock.handlers['sources.list'] = () => sources;
  rpcMock.handlers['account.statusAll'] = () => statuses;
  rpcMock.handlers['sources.schedule'] = () => schedule;
  rpcMock.handlers['settings.get'] = () => settings();
}

const card = async (id: string) => {
  const cards = await screen.findAllByTestId('source-card');
  const found = cards.find((c) => c.dataset.sourceId === id);
  if (!found) throw new Error(`no card ${id}`);
  return found;
};

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  localStorage.clear();
});
afterEach(cleanup);

describe('source card account status', () => {
  it('shows expiring, trial and full-connection badges', async () => {
    mockPage([xtream('a')], [account('a', { expDate: at(3 * DAY + HOUR), isTrial: true, activeCons: 2, maxConnections: 2 })]);
    renderAt(sourcesRoutes, '/sources');
    const c = await card('a');
    expect((await within(c).findByTestId('account-badge-expiring')).textContent).toMatch('Expires in 3 days');
    expect(within(c).getByTestId('account-badge-trial').textContent).toMatch('Trial');
    const conns = within(c).getByTestId('account-badge-connections');
    expect(conns.textContent).toMatch('2/2 connections');
    expect(conns.getAttribute('data-full')).toEqual('true');
    expect(conns.getAttribute('title')).toEqual(expect.stringContaining('Every connection is in use'));
  });

  it('shows expired as an error and stays quiet for a healthy unlimited account', async () => {
    mockPage([xtream('a'), xtream('b', { position: 1 })], [account('a', { status: 'Expired', expDate: at(-2 * DAY) }), account('b', { expDate: at(90 * DAY) })]);
    renderAt(sourcesRoutes, '/sources');
    expect((await within(await card('a')).findByTestId('account-badge-expired')).textContent).toMatch('Expired');
    const b = await card('b');
    expect(within(b).queryByTestId(/^account-badge/)).toBeNull();
  });

  it('respects accountExpiryWarnDays', async () => {
    mockPage([xtream('a')], [account('a', { expDate: at(3 * DAY) })]);
    rpcMock.handlers['settings.get'] = () => settings({ accountExpiryWarnDays: 0 });
    renderAt(sourcesRoutes, '/sources');
    const c = await card('a');
    await waitFor(() => expect(rpcMock.callsOf('settings.get').length).toBeGreaterThan(0));
    await waitFor(() => expect(within(c).queryByTestId('account-badge-expiring')).toBeNull());
  });

  it('shows the next scheduled refresh, a retry, and when the last refresh failed', async () => {
    const sources = [
      xtream('a', { lastRefreshAt: at(-3 * HOUR) }),
      xtream('b', { position: 1, lastError: 'connection refused', lastErrorCode: 'network', lastErrorAt: at(-2 * HOUR) }),
      xtream('c', { position: 2 }),
    ];
    const schedule: ScheduleView = {
      intervalHours: 12,
      sources: [
        { sourceId: 'a', nextRefreshAt: at(9 * HOUR + 60_000), retrying: false },
        { sourceId: 'b', nextRefreshAt: at(30 * 60_000 + 30_000), retrying: true },
        { sourceId: 'c', nextRefreshAt: at(-60_000), retrying: false },
      ],
    };
    mockPage(sources, [], schedule);
    renderAt(sourcesRoutes, '/sources');
    const a = await card('a');
    expect(within(a).getByTestId('source-refreshed').textContent).toMatch('Refreshed 3 hours ago');
    expect((await within(a).findByTestId('source-next-refresh')).textContent).toMatch('Next refresh in 9 hours');
    const b = await card('b');
    expect(within(b).getByTestId('source-failed-at').textContent).toMatch('Failed 2 hours ago');
    expect(within(b).getByTestId('source-next-refresh').textContent).toMatch('Retrying in 31 minutes');
    expect(within(await card('c')).getByTestId('source-next-refresh').textContent).toMatch('Refreshing soon');
  });

  it('shows no next refresh for a source without auto refresh', async () => {
    mockPage([xtream('a', { autoRefresh: false })], [], { intervalHours: 12, sources: [{ sourceId: 'a', nextRefreshAt: at(HOUR * 2), retrying: false }] });
    renderAt(sourcesRoutes, '/sources');
    const c = await card('a');
    await waitFor(() => expect(rpcMock.callsOf('sources.schedule').length).toBe(1));
    expect(within(c).queryByTestId('source-next-refresh')).toBeNull();
  });

  it('?account=<id> opens that source on the subscription tab, then drops the parameter', async () => {
    mockPage([xtream('a')]);
    rpcMock.handlers['xtream.accountInfo'] = () => ({ status: 'Active', activeCons: 0, maxConnections: 1, isTrial: false, allowedOutputFormats: [] });
    const { router } = renderAt(sourcesRoutes, '/sources?account=a');
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByRole('tab', { selected: true }).textContent).toMatch(/account|subscription/i));
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });
});

function renderAlerts(sources = [xtream('a')]) {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AccountAlerts sources={sources} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('dashboard expiry alerts', () => {
  it('lists expired then expiring sources with a link to each', async () => {
    rpcMock.handlers['settings.get'] = () => settings();
    rpcMock.handlers['account.statusAll'] = () => [account('a', { expDate: at(2 * DAY) }), account('b', { status: 'Expired' })];
    renderAlerts([xtream('a'), xtream('b')]);
    const alerts = await screen.findAllByTestId('account-alert');
    expect(alerts.map((a) => a.dataset.kind)).toEqual(['expired', 'expiring']);
    expect(alerts[0]?.textContent).toMatch('Panel b has expired');
    expect(alerts[1]?.textContent).toMatch('Panel a expires in 2 days');
    expect(within(alerts[1]!).getByRole('link', { name: 'View subscription' }).getAttribute('href')).toEqual('/sources?account=a');
    expect(screen.getByRole('region', { name: 'Subscription alerts' })).toBeTruthy();
  });

  it('remembers a dismissal for that expiry date', async () => {
    const exp = at(2 * DAY);
    rpcMock.handlers['settings.get'] = () => settings();
    rpcMock.handlers['account.statusAll'] = () => [account('a', { expDate: exp })];
    renderAlerts();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss the alert for Panel a' }));
    expect(screen.queryByTestId('account-alert')).toBeNull();
    expect(JSON.parse(localStorage.getItem(DISMISSED_STORAGE_KEY) ?? '[]')).toEqual([`a|${exp}`]);
    cleanup();
    renderAlerts();
    await waitFor(() => expect(rpcMock.callsOf('account.statusAll').length).toBe(2));
    expect(screen.queryByTestId('account-alert')).toBeNull();
  });

  it('asks nothing for M3U-only setups or when warnings are off', async () => {
    rpcMock.handlers['settings.get'] = () => settings();
    renderAlerts([makeSource('m')]);
    await waitFor(() => expect(rpcMock.callsOf('settings.get').length).toBe(1));
    expect(rpcMock.callsOf('account.statusAll')).toHaveLength(0);
    cleanup();
    rpcMock.handlers['settings.get'] = () => settings({ accountExpiryWarnDays: 0 });
    renderAlerts();
    await waitFor(() => expect(rpcMock.callsOf('settings.get').length).toBe(2));
    expect(rpcMock.callsOf('account.statusAll')).toHaveLength(0);
  });
});

describe('settings rows', () => {
  it('offers the refresh intervals and saves numbers', () => {
    const update = vi.fn(async () => true);
    render(<SourceRefreshGroup settings={settings()} update={update} />);
    const interval = screen.getByTestId('select-sourceRefreshIntervalHours') as HTMLSelectElement;
    expect([...interval.options].map((o) => o.textContent)).toEqual(['Only at startup', 'Every 6 hours', 'Every 12 hours', 'Every 24 hours', 'Every 48 hours']);
    expect(interval.value).toBe('12');
    fireEvent.change(interval, { target: { value: '0' } });
    expect(update).toHaveBeenCalledWith({ sourceRefreshIntervalHours: 0 });
    const warn = screen.getByTestId('select-accountExpiryWarnDays') as HTMLSelectElement;
    expect(warn.value).toBe('7');
    expect(warn.options[0]?.textContent).toBe('Off');
    fireEvent.change(warn, { target: { value: '14' } });
    expect(update).toHaveBeenCalledWith({ accountExpiryWarnDays: 14 });
  });

  it('lists a stored value that is not a preset', () => {
    expect(choicesWith([0, 6, 12], 9)).toEqual([0, 6, 9, 12]);
    expect(choicesWith([0, 6, 12], 6)).toEqual([0, 6, 12]);
    expect(formatUnit(3, 'day', 'en')).toBe('3 days');
    render(<SourceRefreshGroup settings={settings({ sourceRefreshIntervalHours: 72 })} update={vi.fn(async () => true)} />);
    expect((screen.getByTestId('select-sourceRefreshIntervalHours') as HTMLSelectElement).value).toBe('72');
  });
});
