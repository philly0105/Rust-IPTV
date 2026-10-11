import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { eagerRoutes, installDomStubs, makeSource, pending, renderAt, rpcMock } from './harness';

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
const { useGuideProgressStore } = await import('../lib/epgRefresh');

const routes = () => [...sourcesRoutes, { path: 's/:id/live', element: <div>live page</div> }];

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  useGuideProgressStore.setState({ byUrl: {} });
  rpcMock.handlers['sources.add'] = (a) => makeSource('new', { name: (a as { name: string }).name });
});
afterEach(cleanup);

const dialog = () => screen.getByRole('dialog');
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(within(dialog()).getByLabelText(label, { selector: 'input,textarea' }), { target: { value } });

async function openAdd(path = '/sources') {
  rpcMock.handlers['sources.list'] = () => [];
  renderAt(routes(), path);
  await screen.findByTestId('sources-onboarding');
  if (!screen.queryByRole('dialog')) fireEvent.click(screen.getByTestId('onboard-m3u'));
  return dialog();
}

async function submitAndGetArgs() {
  fireEvent.click(screen.getByTestId('add-source-submit'));
  await waitFor(() => expect(rpcMock.callsOf('sources.add')).toHaveLength(1));
  return rpcMock.callsOf('sources.add')[0];
}

describe('Add source flow sends the exact C4 args', () => {
  it('m3u by url', async () => {
    await openAdd();
    type(/^Name/, 'Home');
    type(/^Playlist URL/, 'lists.example.com/tv.m3u');
    expect(await submitAndGetArgs()).toEqual({
      kind: 'm3u',
      name: 'Home',
      autoRefresh: false,
      m3u: { origin: 'url', url: 'http://lists.example.com/tv.m3u' },
    });
  });

  it('m3u pasted text', async () => {
    rpcMock.handlers['m3u.parsePreview'] = () => ({ channelCount: 1, groups: [], epgUrls: [] });
    await openAdd();
    fireEvent.click(within(dialog()).getByRole('tab', { name: 'Paste' }));
    type(/^Name/, 'Pasted');
    type(/^Playlist text/, '#EXTM3U\n#EXTINF:-1,One\nhttp://a.example.com/1');
    expect(await submitAndGetArgs()).toEqual({
      kind: 'm3u',
      name: 'Pasted',
      autoRefresh: false,
      m3u: { origin: 'text', text: '#EXTM3U\n#EXTINF:-1,One\nhttp://a.example.com/1' },
    });
  });

  it('xtream', async () => {
    await openAdd();
    fireEvent.click(within(dialog()).getByRole('tab', { name: 'Xtream Codes' }));
    type(/^Name/, 'XC');
    type(/^Server URL/, 'http://xt.example.com:8080/');
    type(/^Username/, 'alice');
    type(/^Password/, 'pw');
    expect(await submitAndGetArgs()).toEqual({
      kind: 'xtream',
      name: 'XC',
      autoRefresh: false,
      xtream: { serverUrl: 'http://xt.example.com:8080', username: 'alice', password: 'pw' },
    });
  });

  it('stalker, with MAC formatting and full-portal detection', async () => {
    await openAdd();
    fireEvent.click(within(dialog()).getByRole('tab', { name: 'Stalker portal' }));
    type(/^Name/, 'Box');
    type(/^Portal URL/, 'http://portal.example.com/stalker_portal/c/');
    type(/^MAC address/, '001a79aabbcc');
    expect((within(dialog()).getByLabelText(/^MAC address/, { selector: 'input' }) as HTMLInputElement).value).toBe('00:1A:79:AA:BB:CC');
    expect(await submitAndGetArgs()).toEqual({
      kind: 'stalker',
      name: 'Box',
      autoRefresh: false,
      stalker: {
        portalUrl: 'http://portal.example.com/stalker_portal/c/',
        macAddress: '00:1A:79:AA:BB:CC',
        isFullPortal: true,
        headers: {},
      },
    });
  });

  it('opens prefilled from ?add= and blocks invalid input inline', async () => {
    await openAdd('/sources?add=http%3A%2F%2Flists.example.com%2Fdeep.m3u');
    expect((within(dialog()).getByLabelText(/^Playlist URL/, { selector: 'input' }) as HTMLInputElement).value).toBe(
      'http://lists.example.com/deep.m3u',
    );
    type(/^Playlist URL/, 'ftp://nope');
    fireEvent.click(screen.getByTestId('add-source-submit'));
    expect(await within(dialog()).findByText('Only http and https addresses work here.')).toBeTruthy();
    expect(rpcMock.callsOf('sources.add')).toHaveLength(0);
  });

  it('opens an empty form for ?add=1 and non-web schemes', async () => {
    await openAdd('/sources?add=1');
    expect((within(dialog()).getByLabelText(/^Playlist URL/, { selector: 'input' }) as HTMLInputElement).value).toBe('');
    cleanup();
    await openAdd('/sources?add=file%3A%2F%2F%2Fetc%2Fpasswd');
    expect((within(dialog()).getByLabelText(/^Playlist URL/, { selector: 'input' }) as HTMLInputElement).value).toBe('');
  });

  it('shows the server error with a next step', async () => {
    rpcMock.handlers['sources.add'] = () => {
      throw new RpcError('auth', 'Bad credentials');
    };
    await openAdd();
    fireEvent.click(within(dialog()).getByRole('tab', { name: 'Xtream Codes' }));
    type(/^Name/, 'XC');
    type(/^Server URL/, 'http://xt.example.com');
    type(/^Username/, 'a');
    type(/^Password/, 'b');
    fireEvent.click(screen.getByTestId('add-source-submit'));
    const alert = await screen.findByTestId('add-source-error');
    expect(alert.textContent).toContain('Bad credentials');
    expect(alert.textContent).toContain('Check the username, password or MAC.');
  });
});

describe('Sources page states', () => {
  it('loading', () => {
    rpcMock.handlers['sources.list'] = pending;
    renderAt(routes(), '/sources');
    expect(screen.getByTestId('sources-loading')).toBeTruthy();
  });

  it('empty shows onboarding with three ways to add', async () => {
    rpcMock.handlers['sources.list'] = () => [];
    renderAt(routes(), '/sources');
    await screen.findByTestId('sources-onboarding');
    for (const id of ['onboard-m3u', 'onboard-xtream', 'onboard-stalker']) expect(screen.getByTestId(id)).toBeTruthy();
  });

  it('error offers a retry', async () => {
    let fail = true;
    rpcMock.handlers['sources.list'] = () => {
      if (fail) throw new RpcError('network', 'offline');
      return [makeSource('a', { name: 'Back again' })];
    };
    renderAt(routes(), '/sources');
    const alert = await screen.findByRole('alert');
    fail = false;
    fireEvent.click(within(alert).getByRole('button'));
    expect(await screen.findByText('Back again')).toBeTruthy();
  });

  it('lists sources with counts and an error strip', async () => {
    rpcMock.handlers['sources.list'] = () => [
      makeSource('a', { name: 'First', channelCount: 1234 }),
      makeSource('b', { name: 'Second', kind: 'xtream', m3u: undefined, lastError: 'HTTP 401', position: 1 }),
    ];
    renderAt(routes(), '/sources');
    const cards = await screen.findAllByTestId('source-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain('First');
    expect(within(cards[1]!).getByTestId('source-error').textContent).toContain('HTTP 401');
  });

  it('reorders with the keyboard and sends sources.reorder', async () => {
    rpcMock.handlers['sources.list'] = () => [makeSource('a', { name: 'First' }), makeSource('b', { name: 'Second', position: 1 })];
    rpcMock.handlers['sources.reorder'] = () => undefined;
    renderAt(routes(), '/sources');
    const cards = await screen.findAllByTestId('source-card');
    const grip = cards[0]!.querySelector<HTMLElement>('[data-grip]')!;
    grip.focus();
    fireEvent.keyDown(grip, { key: 'ArrowDown' });
    await waitFor(() => expect(rpcMock.callsOf('sources.reorder')).toEqual([{ ids: ['b', 'a'] }]));
    // The focus-restoring frame has run before the test ends (no callback after teardown).
    await waitFor(() => expect(document.activeElement?.closest('[data-source-id]')?.getAttribute('data-source-id')).toBe('a'));
  });

  it('cancels the pending focus frame when the page unmounts mid-move', async () => {
    rpcMock.handlers['sources.list'] = () => [makeSource('a', { name: 'First' }), makeSource('b', { name: 'Second', position: 1 })];
    rpcMock.handlers['sources.reorder'] = () => undefined;
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const caf = vi.spyOn(window, 'cancelAnimationFrame');
    const view = renderAt(routes(), '/sources');
    const cards = await screen.findAllByTestId('source-card');
    fireEvent.keyDown(cards[0]!.querySelector<HTMLElement>('[data-grip]')!, { key: 'ArrowDown' });
    const id = raf.mock.results.at(-1)?.value as number;
    view.unmount();
    expect(caf).toHaveBeenCalledWith(id);
    raf.mockRestore();
    caf.mockRestore();
  });
});

const XMLTV = 'http://xt.example.com:8080/xmltv.php?username=alice&password=pw-secret';

describe('Guide (EPG) loads after add and edit', () => {
  it('after sources.add, calls epg.refresh { url } for every enabled guide URL', async () => {
    rpcMock.handlers['epg.refresh'] = () => undefined;
    rpcMock.handlers['sources.add'] = (a) =>
      makeSource('new', {
        kind: 'xtream',
        name: (a as { name: string }).name,
        m3u: undefined,
        epg: { detectedUrls: [XMLTV, 'http://off.example.com/g.xml'], manualUrls: [], disabledUrls: ['http://off.example.com/g.xml'] },
      });
    await openAdd();
    fireEvent.click(within(dialog()).getByRole('tab', { name: 'Xtream Codes' }));
    type(/^Name/, 'XC');
    type(/^Server URL/, 'http://xt.example.com:8080');
    type(/^Username/, 'alice');
    type(/^Password/, 'pw-secret');
    await submitAndGetArgs();
    await waitFor(() => expect(rpcMock.callsOf('epg.refresh')).toEqual([{ url: XMLTV }]));
    expect(useGuideProgressStore.getState().byUrl[XMLTV]?.phase).toBe('queued');
  });

  it('does not call epg.refresh when the source has no guide URL', async () => {
    await openAdd();
    type(/^Name/, 'Home');
    type(/^Playlist URL/, 'http://lists.example.com/tv.m3u');
    await submitAndGetArgs();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(rpcMock.callsOf('epg.refresh')).toHaveLength(0);
  });

  it('shows guide progress on the source card', async () => {
    useGuideProgressStore.getState().set(XMLTV, { phase: 'parsing', programs: 1234 });
    rpcMock.handlers['sources.list'] = () => [
      makeSource('x', { kind: 'xtream', m3u: undefined, epg: { detectedUrls: [XMLTV], manualUrls: [], disabledUrls: [] } }),
    ];
    renderAt(routes(), '/sources');
    const row = await screen.findByTestId('guide-progress');
    expect(row.textContent).toContain('Loading guide');
    expect(row.textContent).toContain('1,234 programs');
  });

  it('edit: a new manual guide URL is saved and loaded at once', async () => {
    const before = makeSource('a', { name: 'First' });
    const added = 'http://epg.example.com/extra.xml';
    rpcMock.handlers['sources.list'] = () => [before];
    rpcMock.handlers['sources.update'] = (a) => ({
      ...before,
      epg: { ...before.epg, ...(a as { patch: { epg: object } }).patch.epg },
    });
    rpcMock.handlers['epg.refresh'] = () => undefined;
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('source-edit'));
    fireEvent.click(within(dialog()).getByRole('tab', { name: 'Guide' }));
    type(/^Add guide URL/, added);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByTestId('edit-source-save'));
    await waitFor(() => expect(rpcMock.callsOf('sources.update')).toEqual([{ id: 'a', patch: { epg: { manualUrls: [added] } } }]));
    await waitFor(() => expect(rpcMock.callsOf('epg.refresh')).toEqual([{ url: added }]));
  });

  it('edit: a name-only change does not touch the guide', async () => {
    const before = makeSource('a', { name: 'First', epg: { detectedUrls: ['http://g.example.com/a.xml'], manualUrls: [], disabledUrls: [] } });
    rpcMock.handlers['sources.list'] = () => [before];
    rpcMock.handlers['sources.update'] = () => ({ ...before, name: 'Renamed' });
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('source-edit'));
    type(/^Name/, 'Renamed');
    fireEvent.click(screen.getByTestId('edit-source-save'));
    await waitFor(() => expect(rpcMock.callsOf('sources.update')).toHaveLength(1));
    expect(rpcMock.callsOf('epg.refresh')).toHaveLength(0);
  });
});

describe('Xtream guide URL never shows the password', () => {
  it('redacts the detected xmltv.php link in the edit dialog', async () => {
    rpcMock.handlers['sources.list'] = () => [
      makeSource('x', {
        kind: 'xtream',
        m3u: undefined,
        xtream: { serverUrl: 'http://xt.example.com:8080', username: 'alice', password: 'pw-secret' },
        epg: { detectedUrls: [XMLTV], manualUrls: [], disabledUrls: [] },
      }),
    ];
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('source-edit'));
    fireEvent.click(within(dialog()).getByRole('tab', { name: 'Guide' }));
    const shown = within(dialog()).getByTestId('epg-link-url');
    expect(shown.textContent).toBe('http://xt.example.com:8080/xmltv.php?username=alice&password=***');
    expect(shown.getAttribute('title')).not.toContain('pw-secret');
    expect(within(dialog()).getByRole('switch').getAttribute('aria-label') ?? '').not.toContain('pw-secret');
    // Nothing on the page except the password input itself carries the secret.
    const text = dialog().textContent ?? '';
    expect(text).not.toContain('pw-secret');
  });

  it('redacts URLs in a failed connection test and in the last-error strip', async () => {
    rpcMock.handlers['sources.list'] = () => [
      makeSource('x', {
        kind: 'xtream',
        m3u: undefined,
        xtream: { serverUrl: 'http://xt.example.com:8080', username: 'alice', password: 'pw-secret' },
        lastError: `GET ${XMLTV} returned 503`,
      }),
    ];
    renderAt(routes(), '/sources');
    const strip = await screen.findByTestId('source-error');
    expect(strip.textContent).toContain('password=***');
    expect(strip.textContent).not.toContain('pw-secret');

    rpcMock.handlers['xtream.test'] = () => ({ ok: false, message: `Upstream ${XMLTV} refused` });
    fireEvent.click(screen.getByTestId('source-edit'));
    fireEvent.click(within(dialog()).getByRole('button', { name: /Test connection/ }));
    const result = await within(dialog()).findByTestId('connection-test-result');
    expect(result.textContent).toContain('password=***');
    expect(result.textContent).not.toContain('pw-secret');
  });
});
