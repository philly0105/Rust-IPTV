import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { eagerRoutes, installDomStubs, makeSource, renderAt, rpcMock } from './harness';
import { blurError, clearChangedErrors, emptyDraft, withFieldError } from '../lib/draft';

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
const { useToastStore } = await import('@/ui');

const routes = () => [...sourcesRoutes, { path: 's/:id/live', element: <div>live page</div> }];
const dialog = () => screen.getByRole('dialog');
const input = (label: string | RegExp) => within(dialog()).getByLabelText(label, { selector: 'input,textarea' }) as HTMLInputElement;
const type = (label: string | RegExp, value: string) => fireEvent.change(input(label), { target: { value } });

const xtream = (id: string, over = {}) =>
  makeSource(id, {
    kind: 'xtream',
    m3u: undefined,
    xtream: { serverUrl: 'http://xt.example.com:8080', username: 'alice', password: 'pw-secret' },
    ...over,
  });

async function openAdd(kindTab?: string) {
  rpcMock.handlers['sources.list'] = () => [];
  renderAt(routes(), '/sources?add=1');
  await screen.findByRole('dialog');
  if (kindTab) fireEvent.click(within(dialog()).getByRole('tab', { name: kindTab }));
}

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  localStorage.clear();
  useToastStore.getState().clear();
});
afterEach(cleanup);

describe('field error helpers', () => {
  it('clears only the errors whose field changed', () => {
    const prev = emptyDraft('xtream');
    const next = { ...prev, xtream: { ...prev.xtream, serverUrl: 'http://x' } };
    const errors = { 'xtream.serverUrl': 'errorUrlInvalid', 'xtream.username': 'errorRequired', name: 'errorRequired' };
    expect(clearChangedErrors(prev, next, errors)).toEqual({ 'xtream.username': 'errorRequired', name: 'errorRequired' });
    // Nothing changed: same object back, so React skips the update.
    expect(clearChangedErrors(prev, prev, errors)).toBe(errors);
  });

  it('treats either file field as the m3u.file value', () => {
    const prev = emptyDraft('m3u');
    const next = { ...prev, m3u: { ...prev.m3u, fileText: '#EXTM3U', fileName: 'a.m3u' } };
    expect(clearChangedErrors(prev, next, { 'm3u.file': 'errorFileRequired' })).toEqual({});
  });

  it('flags malformed URLs and MACs on blur but stays quiet for empty fields', () => {
    const d = emptyDraft('stalker');
    expect(blurError(d, 'stalker.portalUrl')).toBeNull();
    expect(blurError({ ...d, stalker: { ...d.stalker, portalUrl: 'ftp://x' } }, 'stalker.portalUrl')).toBe('errorUrlScheme');
    expect(blurError({ ...d, stalker: { ...d.stalker, portalUrl: '  portal.example.com/c/ ' } }, 'stalker.portalUrl')).toBeNull();
    expect(blurError({ ...d, stalker: { ...d.stalker, macAddress: '00:1A:79' } }, 'stalker.macAddress')).toBe('errorMac');
    expect(blurError({ ...d, stalker: { ...d.stalker, macAddress: '00:1A:79:00:00:01' } }, 'stalker.macAddress')).toBeNull();
    // A MAC stored before validation existed stays accepted in the edit dialog.
    expect(blurError({ ...d, stalker: { ...d.stalker, macAddress: 'legacy' } }, 'stalker.macAddress', 'legacy')).toBeNull();
    const x = emptyDraft('xtream');
    expect(blurError({ ...x, xtream: { ...x.xtream, serverUrl: 'http://' } }, 'xtream.serverUrl')).toBe('errorUrlInvalid');
  });

  it('withFieldError sets, clears, and keeps identity when unchanged', () => {
    const e = { a: 'x' };
    expect(withFieldError(e, 'a', 'x')).toBe(e);
    expect(withFieldError(e, 'b', null)).toBe(e);
    expect(withFieldError(e, 'a', null)).toEqual({});
    expect(withFieldError(e, 'b', 'y')).toEqual({ a: 'x', b: 'y' });
  });
});

describe('inline validation in the add dialog', () => {
  it('removes a field error as soon as the user edits that field', async () => {
    await openAdd();
    type(/^Playlist URL/, 'ftp://nope');
    fireEvent.click(screen.getByTestId('add-source-submit'));
    expect(await within(dialog()).findByText('Only http and https addresses work here.')).toBeTruthy();
    expect(input(/^Playlist URL/).getAttribute('aria-invalid')).toBe('true');
    type(/^Playlist URL/, 'http://lists.example.com/tv.m3u');
    expect(within(dialog()).queryByText('Only http and https addresses work here.')).toBeNull();
    expect(input(/^Playlist URL/).getAttribute('aria-invalid')).toBeNull();
  });

  it('checks the playlist URL when the field is left, not before', async () => {
    await openAdd();
    fireEvent.blur(input(/^Playlist URL/));
    expect(within(dialog()).queryByRole('alert')).toBeNull();
    type(/^Playlist URL/, 'ftp://nope');
    expect(within(dialog()).queryByText('Only http and https addresses work here.')).toBeNull();
    fireEvent.blur(input(/^Playlist URL/));
    expect(within(dialog()).getByText('Only http and https addresses work here.')).toBeTruthy();
  });

  it('checks the Xtream server URL on blur', async () => {
    await openAdd('Xtream Codes');
    type(/^Server URL/, 'http://');
    fireEvent.blur(input(/^Server URL/));
    expect(input(/^Server URL/).getAttribute('aria-invalid')).toBe('true');
  });

  it('flags an incomplete MAC on blur and clears it once completed', async () => {
    await openAdd('Stalker portal');
    type(/^MAC address/, '001a79');
    fireEvent.blur(input(/^MAC address/));
    expect(within(dialog()).getByText('Enter 12 hex digits, like 00:1A:79:12:34:56.')).toBeTruthy();
    type(/^MAC address/, '001a79aabbcc');
    expect(within(dialog()).queryByText('Enter 12 hex digits, like 00:1A:79:12:34:56.')).toBeNull();
    fireEvent.blur(input(/^MAC address/));
    expect(input(/^MAC address/).getAttribute('aria-invalid')).toBeNull();
  });
});

describe('connection test', () => {
  async function fillXtream() {
    await openAdd('Xtream Codes');
    type(/^Server URL/, 'http://xt.example.com:8080');
    type(/^Username/, 'alice');
    type(/^Password/, 'pw-secret');
  }

  it('says what failed and what to do, with the raw text as detail', async () => {
    rpcMock.handlers['xtream.test'] = () => {
      throw new RpcError('auth', 'HTTP 401 from http://xt.example.com:8080/player_api.php?username=alice&password=pw-secret');
    };
    await fillXtream();
    fireEvent.click(within(dialog()).getByRole('button', { name: /Test connection/ }));
    const result = await within(dialog()).findByTestId('connection-test-result');
    expect(result.textContent).toBe("The server didn't accept the login.");
    expect(within(dialog()).getByTestId('connection-test-hint').textContent).toBe(
      'The provider turned down the sign-in. Check the username and password.',
    );
    const detail = within(dialog()).getByTestId('connection-test').querySelector('details')!;
    expect(detail.textContent).toContain('HTTP 401');
    expect(detail.textContent).not.toContain('pw-secret');
  });

  it('adds a next step to a negative verdict it can classify', async () => {
    rpcMock.handlers['xtream.test'] = () => ({ ok: false, message: 'HTTP 403 Forbidden' });
    await fillXtream();
    fireEvent.click(within(dialog()).getByRole('button', { name: /Test connection/ }));
    expect((await within(dialog()).findByTestId('connection-test-result')).textContent).toBe('HTTP 403 Forbidden');
    expect(within(dialog()).getByTestId('connection-test-hint').textContent).toContain('Check the username and password.');
  });

  it('hints at a pasted space around the password without blocking it', async () => {
    await fillXtream();
    const hint = 'The password starts or ends with a space. Remove it unless it is part of the password.';
    expect(within(dialog()).queryByText(hint)).toBeNull();
    type(/^Password/, 'pw-secret ');
    expect(within(dialog()).getByText(hint)).toBeTruthy();
    expect(input(/^Password/).getAttribute('aria-describedby')).toBeTruthy();
    type(/^Password/, 'pw-secret');
    expect(within(dialog()).queryByText(hint)).toBeNull();
  });

  it('clears the verdict when the tested details change', async () => {
    rpcMock.handlers['xtream.test'] = () => ({ ok: true, name: 'Provider' });
    await fillXtream();
    fireEvent.click(within(dialog()).getByRole('button', { name: /Test connection/ }));
    expect((await within(dialog()).findByTestId('connection-test-result')).textContent).toContain('Provider');
    type(/^Password/, 'other');
    expect(within(dialog()).queryByTestId('connection-test-result')).toBeNull();
  });

  it('drops a slow answer for details that were edited meanwhile', async () => {
    let resolve!: (v: unknown) => void;
    rpcMock.handlers['xtream.test'] = () => new Promise((r) => (resolve = r));
    await fillXtream();
    fireEvent.click(within(dialog()).getByRole('button', { name: /Test connection/ }));
    await waitFor(() => expect(rpcMock.callsOf('xtream.test')).toHaveLength(1));
    type(/^Username/, 'bob');
    await act(async () => resolve({ ok: true, name: 'Stale' }));
    expect(within(dialog()).queryByTestId('connection-test-result')).toBeNull();
  });
});

describe('add failure offers a retry', () => {
  it('retries from the error panel after a failure that created nothing', async () => {
    let n = 0;
    rpcMock.handlers['sources.add'] = (a) => {
      n += 1;
      if (n === 1) throw new RpcError('timeout', 'operation timed out');
      return makeSource('ok', { name: (a as { name: string }).name });
    };
    await openAdd();
    type(/^Name/, 'Home');
    type(/^Playlist URL/, 'http://lists.example.com/tv.m3u');
    fireEvent.click(screen.getByTestId('add-source-submit'));
    const alert = await screen.findByTestId('add-source-error');
    expect(alert.textContent).toContain("The server didn't answer in time.");
    fireEvent.click(within(alert).getByTestId('add-source-retry'));
    await waitFor(() => expect(rpcMock.callsOf('sources.add')).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('marks and focuses the password when the server rejects the login', async () => {
    rpcMock.handlers['sources.add'] = () => {
      throw new RpcError('auth', 'xt.example.com answered HTTP 401');
    };
    await openAdd('Xtream Codes');
    type(/^Name/, 'XC');
    type(/^Server URL/, 'http://xt.example.com:8080');
    type(/^Username/, 'alice');
    type(/^Password/, 'wrong');
    fireEvent.click(screen.getByTestId('add-source-submit'));
    await screen.findByTestId('add-source-error');
    const pw = input(/^Password/);
    expect(pw.getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(pw));
    // Fixing the password clears the mark.
    type(/^Password/, 'right');
    expect(input(/^Password/).getAttribute('aria-invalid')).toBeNull();
  });

  it('marks the playlist URL when nothing is found there', async () => {
    rpcMock.handlers['sources.add'] = () => {
      throw new RpcError('not_found', 'lists.example.com answered the playlist download: HTTP 404');
    };
    await openAdd();
    type(/^Name/, 'Home');
    type(/^Playlist URL/, 'http://lists.example.com/gone.m3u');
    fireEvent.click(screen.getByTestId('add-source-submit'));
    await screen.findByTestId('add-source-error');
    expect(input(/^Playlist URL/).getAttribute('aria-invalid')).toBe('true');
  });
});

describe('wrong URL (stream, web page, oversized download)', () => {
  // The core's texts, from crates/iptv-core/src/m3u/body.rs and xtream/client.rs.
  const STREAM =
    'tv.example.com sent an MPEG-TS video stream, not a channel list. This URL looks like a single channel; add the playlist URL from your provider instead.';
  const PAGE =
    'tv.example.com answered with a web page instead of a playlist (often a login or error page). Check the playlist URL and that your subscription is active.';
  const BIG =
    'tv.example.com sent more than 1024 MB for the playlist, which is too large to be a channel list. Check that the URL points at an M3U playlist, not a video stream or file.';
  const XT_HTML = 'Xtream login: the server answered with a web page instead of JSON. Check the server URL.';

  it('classifies the card error as wrongUrl, ahead of the "login" in the web-page text', async () => {
    const { classifySourceError } = await import('../lib/sourceError');
    expect(classifySourceError(STREAM)).toEqual({ kind: 'wrongUrl', host: 'tv.example.com' });
    expect(classifySourceError(PAGE)).toEqual({ kind: 'wrongUrl', host: 'tv.example.com' });
    expect(classifySourceError(BIG)).toEqual({ kind: 'wrongUrl', host: 'tv.example.com' });
    expect(classifySourceError(XT_HTML)).toEqual({ kind: 'wrongUrl' });
    expect(classifySourceError(JSON.stringify({ code: 'invalid', message: PAGE })).kind).toBe('wrongUrl');
  });

  it('maps to the address field and the wrong-URL summary and next step', async () => {
    const { fieldForError, importErrorCode, importSummaryKey, nextStepKey, summaryKey } = await import('../lib/errors');
    for (const message of [STREAM, PAGE, BIG]) {
      const err = { code: 'invalid' as const, message };
      expect(summaryKey(err)).toBe('errorSummaryWrongUrl');
      expect(nextStepKey(err)).toBe('hintWrongUrl');
      expect(fieldForError(err, 'm3u', 'url')).toBe('m3u.url');
      expect(importErrorCode(message)).toBe('invalid');
      expect(importSummaryKey(message)).toBe('errorSummaryWrongUrl');
    }
    expect(fieldForError({ code: 'invalid', message: XT_HTML }, 'xtream')).toBe('xtream.serverUrl');
    expect(fieldForError({ code: 'invalid', message: PAGE }, 'm3u', 'text')).toBeNull();
    // Other invalid playlists keep the generic texts and mark nothing.
    expect(summaryKey({ code: 'invalid', message: 'line 3: bad EXTINF' })).toBe('errorSummaryInvalid');
    expect(fieldForError({ code: 'invalid', message: 'line 3: bad EXTINF' }, 'm3u')).toBeNull();
  });

  it('marks the playlist URL in the add dialog and says to use the provider playlist URL', async () => {
    rpcMock.handlers['sources.add'] = () => {
      throw new RpcError('invalid', STREAM);
    };
    await openAdd();
    type(/^Name/, 'Home');
    type(/^Playlist URL/, 'http://tv.example.com/live/1.ts');
    fireEvent.click(screen.getByTestId('add-source-submit'));
    const alert = await screen.findByTestId('add-source-error');
    expect(alert.textContent).toContain("That address doesn't lead to a channel list.");
    expect(alert.textContent).toContain('Use the playlist URL from your provider');
    const url = input(/^Playlist URL/);
    expect(url.getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(url));
  });

  it('shows the translated wrong-URL line on the source card', async () => {
    rpcMock.handlers['sources.list'] = () => [makeSource('m', { lastError: PAGE })];
    renderAt(routes(), '/sources');
    const msg = await screen.findByTestId('source-error-message');
    expect(msg.getAttribute('data-kind')).toBe('wrongUrl');
    expect(msg.textContent).toBe(
      "tv.example.com didn't send a channel list. Use the playlist URL from your provider, not a link to a single channel or a web page.",
    );
  });
});

describe('drip-fed playlist download', () => {
  // crates/iptv-core/src/m3u/body.rs, the minimum-rate check.
  const SLOW =
    'tv.example.com is sending the playlist too slowly (under 4 KB/s for 30 s). Check your connection and that the server is online, then try again later.';

  it('is a timeout on the card, with the host named', async () => {
    const { classifySourceError } = await import('../lib/sourceError');
    expect(classifySourceError(SLOW)).toEqual({ kind: 'timeout', host: 'tv.example.com' });
  });

  it('is a timeout in import progress errors', async () => {
    const { importErrorCode, importSummaryKey } = await import('../lib/errors');
    expect(importErrorCode(SLOW)).toBe('timeout');
    expect(importSummaryKey(SLOW)).toBe('errorSummaryTimeout');
  });

  it('shows the translated timeout line instead of the raw text', async () => {
    rpcMock.handlers['sources.list'] = () => [makeSource('m', { lastError: SLOW })];
    renderAt(routes(), '/sources');
    const msg = await screen.findByTestId('source-error-message');
    expect(msg.getAttribute('data-kind')).toBe('timeout');
    expect(msg.textContent).toContain('tv.example.com');
  });
});

describe('fieldForError', () => {
  it('maps failures to the field to fix', async () => {
    const { fieldForError } = await import('../lib/errors');
    expect(fieldForError({ code: 'auth' }, 'xtream')).toBe('xtream.password');
    expect(fieldForError({ code: 'auth' }, 'stalker')).toBe('stalker.macAddress');
    expect(fieldForError({ code: 'auth' }, 'm3u')).toBeNull();
    expect(fieldForError({ code: 'not_found' }, 'm3u', 'url')).toBe('m3u.url');
    expect(fieldForError({ code: 'not_found' }, 'm3u', 'text')).toBeNull();
    expect(fieldForError({ code: 'network' }, 'stalker')).toBe('stalker.portalUrl');
    expect(fieldForError({ code: 'timeout' }, 'xtream')).toBeNull();
    // The app's own backend being down says nothing about the form.
    expect(fieldForError({ code: 'network', details: { transport: 'unreachable' } }, 'xtream')).toBeNull();
  });
});

describe('import progress view', () => {
  it('announces the phase but not every count tick', async () => {
    const { render } = await import('@testing-library/react');
    const { ImportProgressView } = await import('../components/ImportProgressView');
    render(<ImportProgressView entry={{ phase: 'parsing', done: 1200, total: 10000 } as never} />);
    const phase = screen.getByTestId('import-progress-phase');
    expect(phase.getAttribute('aria-live')).toBe('polite');
    expect(screen.getByTestId('import-progress').querySelectorAll('[aria-live]')).toHaveLength(1);
  });
});

describe('edit save failure', () => {
  it('shows a summary, the next step, and a working Try again', async () => {
    rpcMock.handlers['sources.list'] = () => [xtream('x')];
    let n = 0;
    rpcMock.handlers['sources.update'] = (a) => {
      n += 1;
      if (n === 1) throw new RpcError('network', 'Cannot reach the server: connection refused', true);
      return xtream('x', { name: (a as { patch: { name: string } }).patch.name });
    };
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('source-edit'));
    type(/^Name/, 'Renamed');
    fireEvent.click(screen.getByTestId('edit-source-save'));
    const alert = await screen.findByTestId('edit-source-error');
    expect(alert.textContent).toContain("Couldn't reach the server.");
    expect(alert.textContent).toContain('Check the address and your connection, then try again.');
    expect(alert.querySelector('details')!.textContent).toContain('connection refused');
    fireEvent.click(within(alert).getByTestId('edit-source-retry'));
    await waitFor(() => expect(rpcMock.callsOf('sources.update')).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('refresh failures', () => {
  it('bad credentials point to the settings instead of a blind retry', async () => {
    rpcMock.handlers['sources.list'] = () => [xtream('x')];
    rpcMock.handlers['sources.refresh'] = () => {
      throw new RpcError('auth', 'xt.example.com answered HTTP 401');
    };
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('source-refresh'));
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    const toast = useToastStore.getState().toasts[0]!;
    expect(toast.description).toBe("The server didn't accept the login. The provider turned down the sign-in. Check the username and password.");
    expect(toast.action?.label).toBe('Check settings');
    act(() => toast.action!.onClick());
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(input(/^Username/).value).toBe('alice');
  });

  it('a timeout offers Try again, which refreshes once more', async () => {
    rpcMock.handlers['sources.list'] = () => [xtream('x')];
    rpcMock.handlers['sources.refresh'] = () => {
      throw new RpcError('timeout', 'xt.example.com did not respond in time.');
    };
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('source-refresh'));
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    const toast = useToastStore.getState().toasts[0]!;
    expect(toast.description).toContain("The server didn't answer in time.");
    expect(toast.action?.label).toBe('Try again');
    act(() => toast.action!.onClick());
    await waitFor(() => expect(rpcMock.callsOf('sources.refresh')).toHaveLength(2));
  });

  it('Refresh all says which source it is on, and skips pasted playlists', async () => {
    rpcMock.handlers['sources.list'] = () => [xtream('a'), makeSource('p', { m3u: { origin: 'text', headers: {} } }), xtream('b')];
    const waiters: ((v: unknown) => void)[] = [];
    rpcMock.handlers['sources.refresh'] = (a) => new Promise((r) => waiters.push(() => r(xtream((a as { id: string }).id))));
    renderAt(routes(), '/sources');
    const btn = await screen.findByTestId('sources-refresh-all');
    fireEvent.click(btn);
    await waitFor(() => expect(btn.textContent).toBe('Refreshing 1 of 2'));
    await act(async () => waiters.shift()!(undefined));
    await waitFor(() => expect(btn.textContent).toBe('Refreshing 2 of 2'));
    await act(async () => waiters.shift()!(undefined));
    await waitFor(() => expect(btn.textContent).toBe('Refresh all'));
    expect(rpcMock.callsOf('sources.refresh')).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('disables Refresh all when every source is a pasted playlist', async () => {
    rpcMock.handlers['sources.list'] = () => [makeSource('p', { m3u: { origin: 'text', headers: {} } })];
    renderAt(routes(), '/sources');
    const btn = await screen.findByTestId('sources-refresh-all');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('source card error strip', () => {
  it('ties each Try again to its source, so several failed cards stay distinguishable', async () => {
    rpcMock.handlers['sources.list'] = () => [
      xtream('a', { name: 'Alpha', lastError: 'Could not reach a.example.com. connection refused' }),
      xtream('b', { name: 'Beta', lastError: 'Could not reach b.example.com. connection refused' }),
    ];
    rpcMock.handlers['sources.refresh'] = (a) => xtream((a as { id: string }).id);
    renderAt(routes(), '/sources');
    const retries = await screen.findAllByTestId('source-error-retry');
    expect(retries).toHaveLength(2);
    const names = retries.map((b) => document.getElementById(b.getAttribute('aria-describedby')!)?.textContent);
    expect(names).toEqual(['Alpha', 'Beta']);
    fireEvent.click(retries[1]!);
    await waitFor(() => expect(rpcMock.callsOf('sources.refresh')).toEqual([{ id: 'b' }]));
  });
});
