/**
 * Sources, second pass of the SaaS audit: on phones the sort and filters sit behind one button
 * that opens a sheet, the card gives its address a line of its own, provider account statuses
 * are translated (SS-18), and the copy says "source" for the entity (SS-11).
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
const { VIEW_STORAGE_KEY } = await import('../lib/listView');
const { statusKey } = await import('../components/AccountPanel');

const PHONE = '(max-width: 639.98px)';
const realMatchMedia = window.matchMedia;
function phoneWindow(on: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: on && (query === PHONE || query === '(max-width: 767.98px)'),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const four = () => [
  makeSource('a', { name: 'Alpha' }),
  makeSource('b', { name: 'Beta' }),
  makeSource('c', { name: 'Gamma' }),
  makeSource('d', { name: 'Delta' }),
];

beforeAll(installDomStubs);
afterAll(() => {
  window.matchMedia = realMatchMedia;
});
beforeEach(() => {
  rpcMock.reset();
  localStorage.clear();
  phoneWindow(false);
  rpcMock.handlers['settings.get'] = () => settings();
  rpcMock.handlers['sources.list'] = four;
});
afterEach(cleanup);

describe('Sort and filter on phones', () => {
  it('is one button that opens the three selects in a sheet, with the number of active choices', async () => {
    phoneWindow(true);
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({ sort: 'name', kind: 'all', status: 'all' }));
    renderAt(sourcesRoutes, '/sources');
    const button = await screen.findByTestId('sources-view-button');
    expect(screen.queryByTestId('sources-view')).toBeNull();
    expect(screen.queryByTestId('sources-sort')).toBeNull();
    expect(within(button).getByTestId('sources-view-count').textContent).toBe('1');
    fireEvent.click(button);
    const sheet = await screen.findByRole('dialog', { name: 'Sort and filter' });
    // Labelled selects, full width, in the sheet.
    expect(within(sheet).getByLabelText('Sort')).toBe(within(sheet).getByTestId('sources-sort'));
    fireEvent.change(within(sheet).getByLabelText('Type'), { target: { value: 'xtream' } });
    await waitFor(() => expect(within(screen.getByTestId('sources-view-button')).getByTestId('sources-view-count').textContent).toBe('2'));
    fireEvent.click(within(sheet).getByTestId('sources-view-sheet-reset'));
    await waitFor(() => expect(screen.queryByTestId('sources-view-count')).toBeNull());
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Sort and filter' })).getByTestId('sources-view-sheet-done'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sort and filter' })).toBeNull());
  });

  it('keeps the compact inline selects on wider windows', async () => {
    renderAt(sourcesRoutes, '/sources');
    const view = await screen.findByTestId('sources-view');
    expect(within(view).getByTestId('sources-sort').className).toContain('h-9');
    expect(screen.queryByTestId('sources-view-button')).toBeNull();
  });
});

describe('Source card status', () => {
  it('puts the address on its own line and the times after it, without a separator to start a line', async () => {
    rpcMock.handlers['sources.list'] = () => [makeSource('a', { name: 'Alpha', lastRefreshAt: new Date(Date.now() - 3_600_000).toISOString() })];
    renderAt(sourcesRoutes, '/sources');
    const card = await screen.findByTestId('source-card');
    const origin = within(card).getByTestId('source-origin');
    const refreshed = within(card).getByTestId('source-refreshed');
    // The address is not inside the times' line: on a narrow card they stack.
    expect(origin.parentElement!.contains(refreshed)).toBe(true);
    expect(origin.nextElementSibling?.getAttribute('aria-hidden')).toBe('true');
    expect(origin.nextElementSibling?.className).toContain('@3xl:inline');
  });
});

describe('Account statuses (SS-18)', () => {
  it('map the common provider words to translation keys and leave others as sent', () => {
    expect(statusKey('Active')).toBe('accountState_active');
    expect(statusKey(' EXPIRED ')).toBe('accountState_expired');
    expect(statusKey('Banned')).toBe('accountState_banned');
    expect(statusKey('Disabled')).toBe('accountState_disabled');
    expect(statusKey('suspended')).toBe('accountState_suspended');
    expect(statusKey('Trial')).toBe('accountState_trial');
    expect(statusKey('Pending review')).toBeNull();
    expect(statusKey(undefined)).toBeNull();
  });
});

describe('Remove all (SS-11)', () => {
  it('names sources, not playlists, for a list with accounts and portals', async () => {
    renderAt(sourcesRoutes, '/sources');
    await screen.findAllByTestId('source-card');
    fireEvent.click(screen.getByRole('button', { name: 'More source actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Remove all sources…' })).toBeTruthy();
  });
});
