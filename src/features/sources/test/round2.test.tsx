/**
 * Sources, review round 2 (2026-10-20): the header's count as a number and none for an empty
 * list, the empty state at the headline size, a phone's actions in the header (no Add bar above
 * the cards), Refresh all's progress still on the page there, the toolbar's More in the cards'
 * More column, and the shared count columns.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
const { useShellStore } = await import('@/shell/store');
const { statColumnsOf } = await import('../components/SourceCard');

const PHONE = '(max-width: 639.98px)';
const realMatchMedia = window.matchMedia;
function phoneWindow(on: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: on && query === PHONE,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const three = () => [
  makeSource('a', { kind: 'xtream', name: 'Alpha', m3u: undefined, xtream: { serverUrl: 'http://xt.example.com', username: 'u', password: 'p' }, movieCount: 60, seriesCount: 25 }),
  makeSource('b', { name: 'Bravo', position: 1, radioCount: 8 }),
  makeSource('c', { name: 'Charlie', position: 2 }),
];

beforeAll(installDomStubs);
afterAll(() => {
  window.matchMedia = realMatchMedia;
});
beforeEach(() => {
  rpcMock.reset();
  localStorage.clear();
  phoneWindow(false);
  useShellStore.setState({ header: null });
  rpcMock.handlers['settings.get'] = () => settings();
  rpcMock.handlers['sources.list'] = three;
});
afterEach(cleanup);

describe('the header', () => {
  it('shows the count as a bare number, not "3 sources" after "Sources"', async () => {
    renderAt(sourcesRoutes, '/sources');
    await screen.findAllByTestId('source-card');
    await waitFor(() => expect(useShellStore.getState().header?.subtitle).toBe('3'));
    expect(useShellStore.getState().header?.title).toBe('Sources');
  });

  it('has no count while the list is empty', async () => {
    rpcMock.handlers['sources.list'] = () => [];
    renderAt(sourcesRoutes, '/sources');
    await screen.findByTestId('sources-onboarding');
    expect(useShellStore.getState().header?.title).toBe('Sources');
    expect(useShellStore.getState().header?.subtitle).toBeUndefined();
  });
});

describe('the empty state', () => {
  it('takes the headline size; display is for hero and detail titles', async () => {
    rpcMock.handlers['sources.list'] = () => [];
    renderAt(sourcesRoutes, '/sources');
    const heading = await screen.findByRole('heading', { name: 'Add your first source' });
    expect(heading.className).toContain('text-headline');
    expect(heading.className).not.toMatch(/text-display/);
  });
});

describe('on a phone', () => {
  it('puts Add, the sort and filters, and More in the header, with nothing above the cards', async () => {
    phoneWindow(true);
    renderAt(sourcesRoutes, '/sources', { headerActions: true });
    await screen.findAllByTestId('source-card');
    const actions = await screen.findByTestId('test-header-actions');
    // Add is a header icon button, not a full-width amber bar over the list.
    const add = within(actions).getByRole('button', { name: 'Add a source' });
    expect(add.dataset['testid']).toBe('sources-add');
    expect(add.className).not.toMatch(/bg-accent-solid/);
    expect(within(actions).getByTestId('sources-view-button').className).not.toMatch(/bg-surface-2/);
    expect(within(actions).getByRole('button', { name: 'More source actions' })).toBeTruthy();
    expect(screen.getAllByTestId('sources-add')).toHaveLength(1);
    expect(screen.queryByTestId('sources-toolbar-actions')).toBeNull();
    // Refresh all waits in More.
    fireEvent.click(within(actions).getByRole('button', { name: 'More source actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Refresh all' })).toBeTruthy();
  });

  it('opens the Add dialog from the header', async () => {
    phoneWindow(true);
    const { router } = renderAt(sourcesRoutes, '/sources', { headerActions: true });
    await screen.findAllByTestId('source-card');
    fireEvent.click(within(await screen.findByTestId('test-header-actions')).getByTestId('sources-add'));
    await screen.findByTestId('add-source-dialog');
    expect(router.state.location.search).toBe('?add=');
  });

  it('brings a running Refresh all onto the page, with its progress and Stop', async () => {
    phoneWindow(true);
    let release!: () => void;
    rpcMock.handlers['sources.refresh'] = (a) =>
      new Promise((resolve) => {
        release = () => resolve(three().find((s) => s.id === (a as { id: string }).id));
      });
    renderAt(sourcesRoutes, '/sources', { headerActions: true });
    await screen.findAllByTestId('source-card');
    fireEvent.click(within(await screen.findByTestId('test-header-actions')).getByRole('button', { name: 'More source actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Refresh all' }));
    const progress = await screen.findByTestId('sources-refresh-all');
    expect(progress.textContent).toContain('1 of 3');
    expect(screen.getByTestId('sources-refresh-all-stop')).toBeTruthy();
    // Stop ends the run; the page settles back to the cards alone.
    rpcMock.handlers['sources.cancelImport'] = () => null;
    fireEvent.click(screen.getByTestId('sources-refresh-all-stop'));
    await act(async () => release());
    await waitFor(() => expect(screen.queryByTestId('sources-refresh-all')).toBeNull());
  });
});

describe('the toolbar on a wider window', () => {
  it("puts its More in the cards' More column", async () => {
    renderAt(sourcesRoutes, '/sources');
    await screen.findAllByTestId('source-card');
    // The cards' actions sit inside their padding (p-3, p-4 from @2xl) less -me-1.
    const group = screen.getByTestId('sources-toolbar-actions');
    expect(group.className).toContain('pe-2');
    expect(group.className).toContain('@2xl:pe-3');
    expect(within(group).getByRole('button', { name: 'More source actions' })).toBeTruthy();
  });
});

describe('count columns', () => {
  it('are every count any card has, in one order, so a column holds one kind of count', () => {
    expect(statColumnsOf(three())).toEqual(['channels', 'radio', 'movies', 'series']);
    expect(statColumnsOf([three()[2]!])).toEqual(['channels']);
    expect(statColumnsOf([])).toEqual([]);
  });

  it('give every card the same slots, with a dash where a source has none', async () => {
    renderAt(sourcesRoutes, '/sources');
    const cards = await screen.findAllByTestId('source-card');
    for (const card of cards) {
      expect(within(card).getAllByTestId('source-stat').map((e) => e.dataset['stat'])).toEqual(['channels', 'radio', 'movies', 'series']);
    }
    const alpha = cards.find((c) => c.dataset['sourceId'] === 'a')!;
    const radio = within(alpha).getAllByTestId('source-stat').find((e) => e.dataset['stat'] === 'radio')!;
    expect(radio.dataset['empty']).toBe('');
    // The dash is for the eye; a screen reader hears the number.
    expect(radio.querySelector('dd [aria-hidden]')?.textContent).toBe('–');
    expect(radio.querySelector('dd .sr-only')?.textContent).toBe('0');
    expect(radio.querySelector('dd')?.className).toContain('text-fg-subtle');
  });
});
