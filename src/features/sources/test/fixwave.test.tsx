import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { eagerRoutes, installDomStubs, makeSource, pending, renderAt, rpcMock } from './harness';
import { serverTimeText } from '../components/AccountPanel';
import { absoluteTime } from '../lib/format';

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
const { VIEW_STORAGE_KEY } = await import('../lib/listView');

const routes = () => [...sourcesRoutes, { path: 's/:id/live', element: <div>live page</div> }];
const dialog = () => screen.getByRole('dialog');
const input = (label: string | RegExp) => within(dialog()).getByLabelText(label, { selector: 'input,textarea' }) as HTMLInputElement;
const type = (label: string | RegExp, value: string) => fireEvent.change(input(label), { target: { value } });

const xtream = (id: string, over = {}) =>
  makeSource(id, {
    kind: 'xtream',
    m3u: undefined,
    xtream: { serverUrl: 'http://xt.example.com:8080', username: 'alice', password: 'pw' },
    ...over,
  });
const stalker = (id: string) =>
  makeSource(id, {
    kind: 'stalker',
    m3u: undefined,
    stalker: { portalUrl: 'http://portal.example.com/c/', macAddress: '00:1A:79:00:00:01', isFullPortal: false, headers: {} },
  });

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  localStorage.clear();
});
afterEach(cleanup);

describe('Edit dialog for a pasted M3U playlist', () => {
  it('keeps the request headers editable and saves them', async () => {
    const before = makeSource('t', { name: 'Pasted', m3u: { origin: 'text', headers: {} } });
    rpcMock.handlers['sources.list'] = () => [before];
    rpcMock.handlers['sources.update'] = (a) => ({ ...before, m3u: (a as { patch: { m3u: object } }).patch.m3u });
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('source-edit'));
    expect(within(dialog()).getByTestId('m3u-text-origin-note')).toBeTruthy();
    // No address or playlist text to edit.
    expect(within(dialog()).queryByLabelText(/^Playlist URL/)).toBeNull();
    expect(within(dialog()).queryByLabelText(/^Playlist text/)).toBeNull();
    type(/^User-Agent/, 'MyBox/1.0');
    type(/^Referer|^Referrer/, 'http://ref.example.com/');
    fireEvent.click(screen.getByTestId('edit-source-save'));
    await waitFor(() =>
      expect(rpcMock.callsOf('sources.update')).toEqual([
        { id: 't', patch: { m3u: { origin: 'text', headers: { userAgent: 'MyBox/1.0', referrer: 'http://ref.example.com/' } } } },
      ]),
    );
  });
});

describe('Name suggestion never overwrites typed text', () => {
  async function openXtream() {
    rpcMock.handlers['sources.list'] = () => [];
    rpcMock.handlers['sources.add'] = (a) => makeSource('new', { name: (a as { name: string }).name });
    renderAt(routes(), '/sources?add=1&kind=xtream');
    await screen.findByRole('dialog');
  }

  it('shows the suggestion as the placeholder and keeps what the user types', async () => {
    await openXtream();
    type(/^Server URL/, 'http://xtream.example.com:8080');
    fireEvent.blur(input(/^Server URL/));
    const name = input(/^Name/);
    expect(name.value).toBe('');
    expect(name.placeholder).toBe('xtream.example.com');
    fireEvent.focus(name);
    type(/^Name/, 'Named Second');
    // A second blur on the URL (user goes back and forth) must not touch the typed name.
    fireEvent.blur(input(/^Server URL/));
    expect(input(/^Name/).value).toBe('Named Second');
    type(/^Username/, 'u');
    type(/^Password/, 'p');
    fireEvent.click(screen.getByTestId('add-source-submit'));
    await waitFor(() => expect(rpcMock.callsOf('sources.add')).toHaveLength(1));
    expect((rpcMock.callsOf('sources.add')[0] as { name: string }).name).toBe('Named Second');
  });

  it('uses the suggestion when the name is left empty', async () => {
    await openXtream();
    type(/^Server URL/, 'http://xtream.example.com:8080');
    fireEvent.blur(input(/^Server URL/));
    type(/^Username/, 'u');
    type(/^Password/, 'p');
    fireEvent.click(screen.getByTestId('add-source-submit'));
    await waitFor(() => expect(rpcMock.callsOf('sources.add')).toHaveLength(1));
    expect((rpcMock.callsOf('sources.add')[0] as { name: string }).name).toBe('xtream.example.com');
  });
});

describe('Source card stats', () => {
  it('shows radio as its own stat next to live channels', async () => {
    rpcMock.handlers['sources.list'] = () => [
      makeSource('a', { channelCount: 48_500, radioCount: 1_000 }),
      makeSource('b', { channelCount: 120 }),
    ];
    renderAt(routes(), '/sources');
    const [withRadio, plain] = await screen.findAllByTestId('source-card');
    expect(withRadio!.textContent).toContain('48,500');
    expect(withRadio!.textContent).toContain('1,000');
    expect(withRadio!.textContent).toMatch(/radio/);
    expect(plain!.textContent).not.toMatch(/radio/);
  });
});

describe('Account panel', () => {
  it('shows Xtream account details from the card button', async () => {
    rpcMock.handlers['sources.list'] = () => [xtream('x')];
    rpcMock.handlers['xtream.accountInfo'] = () => ({
      status: 'Active',
      expDate: '2099-06-15T12:00:00Z',
      activeCons: 1,
      maxConnections: 2,
      isTrial: false,
      createdAt: '2024-05-01T00:00:00Z',
      allowedOutputFormats: ['m3u8', 'ts'],
    });
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('source-account'));
    const panel = await within(dialog()).findByTestId('account-panel');
    expect(rpcMock.callsOf('xtream.accountInfo')).toEqual([{ sourceId: 'x' }]);
    expect(within(panel).getByTestId('account-status').textContent).toContain('Active');
    expect(within(panel).getByTestId('account-connections').textContent).toContain('1 of 2 in use');
    expect(within(panel).getByTestId('account-trial').textContent).toContain('No');
    expect(within(panel).getByTestId('account-formats').textContent).toContain('m3u8');
    expect(within(panel).getByTestId('account-expires').textContent).toContain('2099');
    expect(within(dialog()).getByRole('tab', { name: 'Account' }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows a loading skeleton, then an error with retry', async () => {
    rpcMock.handlers['sources.list'] = () => [xtream('x')];
    rpcMock.handlers['xtream.accountInfo'] = pending;
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('source-account'));
    expect(within(dialog()).getByTestId('account-loading')).toBeTruthy();
    cleanup();

    let fail = true;
    rpcMock.handlers['xtream.accountInfo'] = () => {
      if (fail) throw new RpcError('auth', 'Bad credentials');
      return { status: 'Expired', activeCons: 0, maxConnections: 0, isTrial: true };
    };
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('source-account'));
    const alert = await within(dialog()).findByRole('alert');
    expect(alert.textContent).toContain('Could not load the account details');
    fail = false;
    fireEvent.click(within(alert).getByRole('button'));
    const status = await within(dialog()).findByTestId('account-status');
    expect(status.textContent).toContain('Expired');
    expect(within(dialog()).getByTestId('account-connections').textContent).toContain('no limit');
    expect(within(dialog()).getByTestId('account-expires').textContent).toContain('No expiry date');
  });

  it('shows Stalker account details with the extra portal fields, secrets dropped', async () => {
    rpcMock.handlers['sources.list'] = () => [stalker('s')];
    rpcMock.handlers['stalker.accountInfo'] = () => ({
      mac: '00:1A:79:00:00:01',
      status: 'active',
      tariff: 'Gold',
      raw: { phone: '555', account_balance: 12, token: 'tok-secret', nested: { password: 'pw-secret', city: 'Oslo' } },
    });
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('source-account'));
    const panel = await within(dialog()).findByTestId('account-panel');
    expect(rpcMock.callsOf('stalker.accountInfo')).toEqual([{ sourceId: 's' }]);
    expect(panel.textContent).toContain('Gold');
    const raw = within(panel).getByTestId('account-raw');
    expect(raw.textContent).toContain('account_balance');
    expect(raw.textContent).toContain('nested.city');
    expect(raw.textContent).not.toContain('tok-secret');
    expect(raw.textContent).not.toContain('pw-secret');
  });

  it('formats the server time in the server zone, or viewer-local without a label (R2-r2 F5)', async () => {
    const at = '2026-10-11T15:14:00Z';
    const berlin = serverTimeText(at, 'Europe/Berlin', 'en')!;
    expect(berlin).toMatch(/5:14\s?PM, Europe\/Berlin$/);
    expect(serverTimeText(at, 'America/New_York', 'en')).toMatch(/11:14\s?AM, America\/New_York$/);
    // Not an IANA zone: the viewer's local time, with no misleading label.
    const local = serverTimeText(at, 'GMT+2 (server)', 'en')!;
    expect(local).toBe(absoluteTime(at, 'en'));
    expect(local).not.toContain('GMT+2');
    expect(serverTimeText(undefined, 'Europe/Berlin', 'en')).toBe('Europe/Berlin');
    expect(serverTimeText('yesterday', 'Europe/Berlin', 'en')).toBe('yesterday, Europe/Berlin');
    expect(serverTimeText(undefined, undefined, 'en')).toBeUndefined();

    rpcMock.handlers['sources.list'] = () => [xtream('x')];
    rpcMock.handlers['xtream.accountInfo'] = () => ({ status: 'Active', activeCons: 0, maxConnections: 1, isTrial: false, serverTime: at, timezone: 'Europe/Berlin' });
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('source-account'));
    const time = await within(dialog()).findByTestId('account-server-time');
    expect(time.textContent).toBe(berlin);
  });

  it('has no account button or tab for M3U sources', async () => {
    rpcMock.handlers['sources.list'] = () => [makeSource('m')];
    renderAt(routes(), '/sources');
    await screen.findByTestId('source-card');
    expect(screen.queryByTestId('source-account')).toBeNull();
    fireEvent.click(screen.getByTestId('source-edit'));
    expect(within(dialog()).queryByRole('tab', { name: 'Account' })).toBeNull();
  });
});

describe('Sort, filter and remove all', () => {
  const list = () => [
    makeSource('a', { name: 'Zulu', createdAt: '2026-01-01T00:00:00Z' }),
    xtream('b', { name: 'alpha', position: 1, createdAt: '2026-03-01T00:00:00Z', lastError: 'HTTP 401' }),
    stalker('c'),
  ];
  const names = () => screen.getAllByTestId('source-name').map((n) => n.textContent);

  it('sorts by name, hides reorder grips, and persists the view', async () => {
    rpcMock.handlers['sources.list'] = list;
    renderAt(routes(), '/sources');
    await screen.findAllByTestId('source-card');
    expect(names()).toEqual(['Zulu', 'alpha', 'Source c']);
    expect(document.querySelectorAll('[data-grip]')).toHaveLength(3);
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'name' } });
    expect(names()).toEqual(['alpha', 'Source c', 'Zulu']);
    expect(document.querySelectorAll('[data-grip]')).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem(VIEW_STORAGE_KEY)!)).toMatchObject({ sort: 'name' });

    cleanup();
    renderAt(routes(), '/sources');
    await screen.findAllByTestId('source-card');
    expect(names()).toEqual(['alpha', 'Source c', 'Zulu']);
    fireEvent.click(screen.getByTestId('sources-view-reset'));
    expect(names()).toEqual(['Zulu', 'alpha', 'Source c']);
  });

  it('filters by kind and status, with an empty state that clears filters', async () => {
    rpcMock.handlers['sources.list'] = list;
    renderAt(routes(), '/sources');
    await screen.findAllByTestId('source-card');
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'error' } });
    expect(names()).toEqual(['alpha']);
    expect(screen.getByTestId('sources-view-hint').textContent).toContain('Showing 1 of 3');
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'stalker' } });
    expect(screen.queryAllByTestId('source-card')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(names()).toHaveLength(3);
  });

  it('removes all playlists only after typing the word', async () => {
    let sources = list();
    rpcMock.handlers['sources.list'] = () => sources;
    rpcMock.handlers['sources.removeAll'] = () => {
      sources = [];
      return null;
    };
    renderAt(routes(), '/sources');
    await screen.findAllByTestId('source-card');
    fireEvent.click(screen.getByRole('button', { name: 'More source actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Remove all playlists/ }));
    const confirm = screen.getByTestId('sources-remove-all-confirm') as HTMLButtonElement;
    expect(within(dialog()).getByRole('heading').textContent).toContain('Remove all 3 playlists?');
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('sources-remove-all-input'), { target: { value: 'nope' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('sources-remove-all-input'), { target: { value: 'Remove' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(rpcMock.callsOf('sources.removeAll')).toHaveLength(1));
    expect(await screen.findByTestId('sources-onboarding')).toBeTruthy();
  });
});

describe('Retrying a failed add reuses the source it created', () => {
  /** A fake core: `sources.add` persists the source, then fails its import (as the core does). */
  function failingCore(opts: { refreshFails?: boolean; transport?: boolean } = {}) {
    const store: ReturnType<typeof makeSource>[] = [];
    let n = 0;
    rpcMock.handlers['sources.list'] = () => [...store];
    rpcMock.handlers['sources.add'] = (a) => {
      const args = a as { name: string; kind: 'm3u' | 'xtream'; m3u?: { origin: 'url'; url: string } };
      const s = makeSource(`f${++n}`, {
        name: args.name,
        kind: args.kind,
        channelCount: 0,
        m3u: args.m3u ? { ...args.m3u, headers: {} } : undefined,
        xtream: args.kind === 'xtream' ? { serverUrl: 'http://xt.example.com', username: 'a', password: 'b' } : undefined,
        lastError: 'error sending request',
      });
      store.push(s);
      // A reverse proxy timing out a long import: the row exists, the error names nothing.
      if (opts.transport) throw new RpcError('timeout', 'HTTP 504 Gateway Timeout');
      throw new RpcError('network', 'error sending request', true, { sourceId: s.id });
    };
    rpcMock.handlers['sources.get'] = (a) => {
      const s = store.find((x) => x.id === (a as { id: string }).id);
      if (!s) throw new RpcError('not_found', 'source not found');
      return s;
    };
    rpcMock.handlers['sources.update'] = (a) => {
      const { id, patch } = a as { id: string; patch: Record<string, unknown> };
      const i = store.findIndex((x) => x.id === id);
      store[i] = { ...store[i]!, ...patch };
      return store[i];
    };
    rpcMock.handlers['sources.refresh'] = (a) => {
      const s = store.find((x) => x.id === (a as { id: string }).id)!;
      if (opts.refreshFails) throw new RpcError('timeout', 'operation timed out');
      return { ...s, channelCount: 42, lastError: undefined };
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

  async function failFirstAdd() {
    renderAt(routes(), '/sources?add=1');
    await screen.findByRole('dialog');
    type(/^Name/, 'retrytest');
    type(/^Playlist URL/, 'http://127.0.0.1:7399/x.m3u');
    fireEvent.click(screen.getByTestId('add-source-submit'));
    return screen.findByTestId('add-source-error');
  }

  it('shows a translated summary, keeps the raw transport text as detail, and offers a retry', async () => {
    failingCore();
    const alert = await failFirstAdd();
    expect(alert.textContent).toContain("Couldn't reach the server.");
    expect(alert.textContent).toContain('Check the address and your connection, then try again.');
    // The raw text is only inside the collapsed technical details.
    const details = alert.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('error sending request');
    expect(within(alert).getByTestId('add-source-retry-note').textContent).toContain('retrytest');
    expect(screen.getByTestId('add-source-submit').textContent).toBe('Try again');
  });

  it('claims the failed import while open, so the shell does not toast it a second time', async () => {
    const { importErrorClaimed } = await import('../lib/errors');
    failingCore();
    expect(importErrorClaimed('f1')).toBe(false);
    await failFirstAdd();
    expect(importErrorClaimed('f1')).toBe(true);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(importErrorClaimed('f1')).toBe(false);
  });

  it('re-imports the same source on retry and never adds a second one', async () => {
    const store = failingCore();
    await failFirstAdd();
    type(/^Playlist URL/, 'http://lists.example.com/fixed.m3u');
    fireEvent.click(screen.getByTestId('add-source-submit'));
    await waitFor(() => expect(rpcMock.callsOf('sources.refresh')).toEqual([{ id: 'f1' }]));
    expect(rpcMock.callsOf('sources.add')).toHaveLength(1);
    expect(rpcMock.callsOf('sources.update')).toEqual([
      { id: 'f1', patch: { m3u: { origin: 'url', url: 'http://lists.example.com/fixed.m3u', headers: {} } } },
    ]);
    expect(store.map((s) => s.id)).toEqual(['f1']);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a retry that fails again stays on the same source', async () => {
    const store = failingCore({ refreshFails: true });
    await failFirstAdd();
    fireEvent.click(screen.getByTestId('add-source-submit'));
    await waitFor(() => expect(rpcMock.callsOf('sources.refresh')).toHaveLength(1));
    const alert = await screen.findByTestId('add-source-error');
    await waitFor(() => expect(alert.textContent).toContain("The server didn't answer in time."));
    fireEvent.click(screen.getByTestId('add-source-submit'));
    await waitFor(() => expect(rpcMock.callsOf('sources.refresh')).toHaveLength(2));
    expect(rpcMock.callsOf('sources.add')).toHaveLength(1);
    // Nothing changed, so nothing is patched.
    expect(rpcMock.callsOf('sources.update')).toHaveLength(0);
    expect(store).toHaveLength(1);
  });

  it('replaces the failed source when the kind changes', async () => {
    const store = failingCore();
    await failFirstAdd();
    fireEvent.click(within(dialog()).getByRole('tab', { name: 'Xtream Codes' }));
    type(/^Server URL/, 'http://xt.example.com');
    type(/^Username/, 'a');
    type(/^Password/, 'b');
    fireEvent.click(screen.getByTestId('add-source-submit'));
    await waitFor(() => expect(rpcMock.callsOf('sources.add')).toHaveLength(2));
    expect(rpcMock.callsOf('sources.remove')).toEqual([{ id: 'f1' }]);
    expect(store.map((s) => s.id)).toEqual(['f2']);
  });

  it('adopts the source the core created when the add failed at the transport level', async () => {
    const store = failingCore({ transport: true });
    await failFirstAdd();
    await waitFor(() => expect(rpcMock.callsOf('sources.list').length).toBeGreaterThan(1));
    await waitFor(() => expect(screen.getByTestId('add-source-submit').textContent).toBe('Try again'));
    fireEvent.click(screen.getByTestId('add-source-submit'));
    await waitFor(() => expect(rpcMock.callsOf('sources.refresh')).toEqual([{ id: 'f1' }]));
    expect(rpcMock.callsOf('sources.add')).toHaveLength(1);
    expect(store.map((s) => s.id)).toEqual(['f1']);
  });

  it('adds again after a transport failure that created nothing', async () => {
    const store = failingCore({ transport: true });
    rpcMock.handlers['sources.add'] = () => {
      throw new RpcError('network', 'Failed to fetch');
    };
    await failFirstAdd();
    rpcMock.handlers['sources.add'] = (a) => {
      const s = makeSource('ok', { name: (a as { name: string }).name });
      store.push(s);
      return s;
    };
    fireEvent.click(screen.getByTestId('add-source-submit'));
    await waitFor(() => expect(rpcMock.callsOf('sources.add')).toHaveLength(2));
    expect(rpcMock.callsOf('sources.refresh')).toHaveLength(0);
  });

  it('adds again when the failed source was removed meanwhile', async () => {
    const store = failingCore();
    await failFirstAdd();
    store.length = 0;
    fireEvent.click(screen.getByTestId('add-source-submit'));
    await waitFor(() => expect(rpcMock.callsOf('sources.add')).toHaveLength(2));
    expect(rpcMock.callsOf('sources.remove')).toHaveLength(0);
    expect(store.map((s) => s.id)).toEqual(['f2']);
  });
});
