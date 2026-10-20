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
    renderAt(sourcesRoutes, '/sources', { headerActions: true });
    const button = await screen.findByTestId('sources-view-button');
    // In the header, with Add and More (no full-width Add bar and no toolbar above the cards).
    expect(screen.getByTestId('test-header-actions').contains(button)).toBe(true);
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

  it('puts them behind one small View button on wider windows, which names the sort and opens the labelled selects', async () => {
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({ sort: 'name', kind: 'all', status: 'all' }));
    renderAt(sourcesRoutes, '/sources');
    const trigger = await screen.findByTestId('sources-view-trigger');
    // No three bordered selects across the toolbar: one sm button at the scale of the ones beside it.
    expect(screen.queryByTestId('sources-sort')).toBeNull();
    expect(screen.queryByTestId('sources-view-button')).toBeNull();
    expect(trigger.className).toContain('h-8');
    expect(trigger.textContent).toContain('Name');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(within(trigger).getByTestId('sources-view-count').textContent).toBe('1');
    expect(screen.getByTestId('sources-add').className).toContain('h-8');
    expect(screen.getByTestId('sources-refresh-all').className).toContain('h-8');

    fireEvent.click(trigger);
    const panel = screen.getByRole('dialog', { name: 'Sort and filter' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(panel.id);
    // The panel is not modal; its first choice takes focus.
    expect(panel.getAttribute('aria-modal')).toBeNull();
    expect(within(panel).getByLabelText('Sort')).toBe(document.activeElement);
    fireEvent.change(within(panel).getByLabelText('Type'), { target: { value: 'xtream' } });
    await waitFor(() => expect(within(trigger).getByTestId('sources-view-count').textContent).toBe('2'));
    fireEvent.change(within(panel).getByLabelText('Sort'), { target: { value: 'manual' } });
    await waitFor(() => expect(trigger.textContent).toContain('Your order'));
  });

  it('closes the View panel on Escape, giving focus back to its button, and on a press outside', async () => {
    renderAt(sourcesRoutes, '/sources');
    const trigger = await screen.findByTestId('sources-view-trigger');
    fireEvent.click(trigger);
    const sort = within(screen.getByTestId('sources-view-panel')).getByLabelText('Sort');
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    let reachedWindow = false;
    const onWindow = () => (reachedWindow = true);
    window.addEventListener('keydown', onWindow);
    sort.dispatchEvent(escape);
    window.removeEventListener('keydown', onWindow);
    await waitFor(() => expect(screen.queryByTestId('sources-view-panel')).toBeNull());
    expect(document.activeElement).toBe(trigger);
    // The page's shortcuts never saw it.
    expect(reachedWindow).toBe(false);

    fireEvent.click(trigger);
    expect(screen.getByTestId('sources-view-panel')).toBeTruthy();
    fireEvent.mouseDown(screen.getAllByTestId('source-card')[0]!);
    await waitFor(() => expect(screen.queryByTestId('sources-view-panel')).toBeNull());

    // Focus moving past the panel closes it too.
    fireEvent.click(trigger);
    const panel = screen.getByTestId('sources-view-panel');
    fireEvent.blur(within(panel).getByLabelText('Status'), { relatedTarget: screen.getByTestId('sources-add') });
    await waitFor(() => expect(screen.queryByTestId('sources-view-panel')).toBeNull());
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

  it('joins the times on one line that wraps as a MetaLine, across the card, beside a smaller monogram', async () => {
    rpcMock.handlers['sources.list'] = () => [
      makeSource('a', { name: 'Alpha', autoRefresh: true, lastRefreshAt: new Date(Date.now() - 3_600_000).toISOString() }),
    ];
    rpcMock.handlers['sources.schedule'] = () => ({ sources: [{ sourceId: 'a', nextRefreshAt: new Date(Date.now() + 5 * 3_600_000).toISOString(), retrying: false }] });
    renderAt(sourcesRoutes, '/sources');
    const card = await screen.findByTestId('source-card');
    const next = await within(card).findByTestId('source-next-refresh');
    const refreshed = within(card).getByTestId('source-refreshed');
    // One MetaLine holds both: its separator travels with "Next refresh", so a wrap never leaves it
    // at the start of a line, and narrow cards no longer stack the times one per line.
    const line = refreshed.closest('span.flex-wrap')!;
    expect(line.contains(next)).toBe(true);
    expect(line.className).not.toMatch(/flex-col/);
    // The status row takes the card's width (so a phone fits both times on one line), and the
    // monogram above it is smaller on a narrow card, so its edge and the name's sit close.
    const status = within(card).getByTestId('source-origin').parentElement!;
    expect(status.className).toContain('col-span-full');
    const mark = within(card).getByTestId('source-monogram');
    expect(mark.className).toContain('size-9');
    expect(mark.className).toContain('@3xl:size-11');
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
