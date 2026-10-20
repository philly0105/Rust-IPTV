/**
 * SaaS polish of the Sources page and its dialogs (audit 2026-10-20, findings SS-1 to SS-16):
 * typed details survive a stray close, the address comes first, connection fixes reload, an
 * invalid guide shift blocks the save, short lists drop the view controls, and renames-only
 * sources reach Reset all edits.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { chooseCardAction, confirmDiscard, eagerRoutes, installDomStubs, makeSource, renderAt, rpcMock, settings } from './harness';

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
const { useToastStore } = await import('@/ui');

const routes = () => [...sourcesRoutes, { path: 's/:id/live', element: <div>live page</div> }];
const dialog = () => screen.getByTestId('add-source-dialog');
const scrim = () => document.querySelector<HTMLElement>('[data-scrim]')!;
const xtream = (id: string, over = {}) =>
  makeSource(id, {
    kind: 'xtream',
    name: `XT ${id}`,
    m3u: undefined,
    xtream: { serverUrl: 'http://xt.example.com:8080', username: 'alice', password: 'old-pw' },
    ...over,
  });

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  localStorage.clear();
  useToastStore.setState({ toasts: [] });
  rpcMock.handlers['settings.get'] = () => settings();
});
afterEach(cleanup);

describe('typed details survive a stray close (SS-1)', () => {
  it('an untouched Add dialog closes on the backdrop at once', async () => {
    rpcMock.handlers['sources.list'] = () => [];
    renderAt(routes(), '/sources?add=1&kind=m3u');
    await screen.findByTestId('add-source-dialog');
    fireEvent.mouseDown(scrim());
    await waitFor(() => expect(screen.queryByTestId('add-source-dialog')).toBeNull());
  });

  it('with an address typed, the backdrop does nothing and Escape asks first', async () => {
    rpcMock.handlers['sources.list'] = () => [];
    renderAt(routes(), '/sources?add=1&kind=m3u');
    await screen.findByTestId('add-source-dialog');
    fireEvent.change(within(dialog()).getByLabelText(/^Playlist URL/), { target: { value: 'http://lists.example.com/tv.m3u' } });
    fireEvent.mouseDown(scrim());
    expect(screen.getByTestId('add-source-dialog')).toBeTruthy();
    expect(screen.queryByTestId('discard-prompt')).toBeNull();

    fireEvent.keyDown(within(dialog()).getByLabelText(/^Playlist URL/), { key: 'Escape' });
    const prompt = await screen.findByTestId('discard-prompt');
    // Keep editing is the safe default and takes focus.
    expect(document.activeElement).toBe(within(prompt).getByTestId('discard-keep'));
    fireEvent.click(within(prompt).getByTestId('discard-keep'));
    await waitFor(() => expect(screen.queryByTestId('discard-prompt')).toBeNull());
    expect((within(dialog()).getByLabelText(/^Playlist URL/) as HTMLInputElement).value).toBe('http://lists.example.com/tv.m3u');

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    confirmDiscard();
    await waitFor(() => expect(screen.queryByTestId('add-source-dialog')).toBeNull());
  });

  it('the Edit dialog asks before dropping a changed password', async () => {
    rpcMock.handlers['sources.list'] = () => [xtream('a')];
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('source-edit'));
    const edit = await screen.findByTestId('edit-source-dialog');
    fireEvent.change(within(edit).getByLabelText(/^Password/), { target: { value: 'new-pw' } });
    fireEvent.mouseDown(scrim());
    expect(screen.getByTestId('edit-source-dialog')).toBeTruthy();
    fireEvent.click(within(edit).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByTestId('discard-prompt')).toBeTruthy();
    confirmDiscard();
    await waitFor(() => expect(screen.queryByTestId('edit-source-dialog')).toBeNull());
    expect(rpcMock.callsOf('sources.update')).toEqual([]);
  });

  it('the Edit dialog asks before dropping a guide URL typed but not added', async () => {
    rpcMock.handlers['sources.list'] = () => [xtream('a')];
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('source-edit'));
    const edit = await screen.findByTestId('edit-source-dialog');
    const guideUrl = () => within(screen.getByTestId('edit-source-dialog')).getByLabelText(/^Add guide URL/, { selector: 'input' }) as HTMLInputElement;
    fireEvent.click(within(edit).getByRole('tab', { name: 'Guide' }));
    fireEvent.change(guideUrl(), { target: { value: 'http://epg.example.com/extra.xml' } });
    // The typed text outlives a switch to another tab.
    fireEvent.click(within(edit).getByRole('tab', { name: 'Details' }));
    fireEvent.click(within(edit).getByRole('tab', { name: 'Guide' }));
    expect(guideUrl().value).toBe('http://epg.example.com/extra.xml');
    fireEvent.mouseDown(scrim());
    expect(screen.getByTestId('edit-source-dialog')).toBeTruthy();
    fireEvent.keyDown(edit, { key: 'Escape' });
    expect(await screen.findByTestId('discard-prompt')).toBeTruthy();
    confirmDiscard();
    await waitFor(() => expect(screen.queryByTestId('edit-source-dialog')).toBeNull());

    // Opened again, the field starts empty and there is nothing to lose.
    fireEvent.click(screen.getByTestId('source-edit'));
    fireEvent.click(within(await screen.findByTestId('edit-source-dialog')).getByRole('tab', { name: 'Guide' }));
    expect(guideUrl().value).toBe('');
    fireEvent.keyDown(screen.getByTestId('edit-source-dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('edit-source-dialog')).toBeNull());
    expect(screen.queryByTestId('discard-prompt')).toBeNull();
    expect(rpcMock.callsOf('sources.update')).toEqual([]);
  });

  it('a guide URL once added is no longer typed text: removing the link again leaves nothing to discard', async () => {
    rpcMock.handlers['sources.list'] = () => [xtream('a')];
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('source-edit'));
    const edit = await screen.findByTestId('edit-source-dialog');
    fireEvent.click(within(edit).getByRole('tab', { name: 'Guide' }));
    const guideUrl = within(edit).getByLabelText(/^Add guide URL/, { selector: 'input' }) as HTMLInputElement;
    fireEvent.change(guideUrl, { target: { value: 'http://epg.example.com/extra.xml' } });
    fireEvent.click(within(edit).getByRole('button', { name: 'Add' }));
    expect(guideUrl.value).toBe('');
    fireEvent.click(within(edit).getByRole('button', { name: 'Remove http://epg.example.com/extra.xml' }));
    fireEvent.keyDown(edit, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('edit-source-dialog')).toBeNull());
    expect(screen.queryByTestId('discard-prompt')).toBeNull();
  });

  // An untouched Edit dialog has nothing to lose, so every way out closes it at once. A bad
  // "unchanged" check once left it dirty from the first render: Escape, Cancel and the close
  // button asked "Discard changes?" and the backdrop did nothing.
  describe('an untouched Edit dialog closes without asking', () => {
    const stalker = (id: string) =>
      makeSource(id, {
        kind: 'stalker',
        name: `ST ${id}`,
        m3u: undefined,
        stalker: { portalUrl: 'http://portal.example.com/c/', macAddress: '00:1A:79:12:34:56', isFullPortal: false, headers: {} },
      });
    const shapes = [
      ['an M3U address', () => makeSource('a')],
      ['an M3U address with a guide and a shift', () => makeSource('a', { epg: { detectedUrls: [], manualUrls: ['http://guide.example.com/a.xml'], disabledUrls: [], shiftMinutes: 60 } })],
      ['an Xtream account', () => xtream('a')],
      ['a Stalker portal', () => stalker('a')],
    ] as const;
    const ways = [
      ['Escape', (edit: HTMLElement) => fireEvent.keyDown(edit, { key: 'Escape' })],
      ['Cancel', (edit: HTMLElement) => fireEvent.click(within(edit).getByRole('button', { name: 'Cancel' }))],
      ['the backdrop', () => fireEvent.mouseDown(scrim())],
    ] as const;
    for (const [shape, make] of shapes) {
      for (const [way, close] of ways) {
        it(`${shape}, closed with ${way}`, async () => {
          rpcMock.handlers['sources.list'] = () => [make()];
          renderAt(routes(), '/sources');
          fireEvent.click(await screen.findByTestId('source-edit'));
          close(await screen.findByTestId('edit-source-dialog'));
          await waitFor(() => expect(screen.queryByTestId('edit-source-dialog')).toBeNull());
          expect(screen.queryByTestId('discard-prompt')).toBeNull();
          expect(rpcMock.callsOf('sources.update')).toEqual([]);
        });
      }
    }

    it('opened on the Account tab from Subscription details, closed with Escape and the backdrop', async () => {
      rpcMock.handlers['sources.list'] = () => [xtream('a')];
      rpcMock.handlers['xtream.accountInfo'] = () => ({ status: 'Active', activeCons: 0, maxConnections: 1, isTrial: false });
      renderAt(routes(), '/sources');
      await screen.findByTestId('source-card');
      chooseCardAction('Subscription details');
      const edit = await screen.findByTestId('edit-source-dialog');
      await within(edit).findByTestId('account-panel');
      fireEvent.keyDown(edit, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByTestId('edit-source-dialog')).toBeNull());
      expect(screen.queryByTestId('discard-prompt')).toBeNull();

      chooseCardAction('Subscription details');
      await screen.findByTestId('edit-source-dialog');
      fireEvent.mouseDown(scrim());
      await waitFor(() => expect(screen.queryByTestId('edit-source-dialog')).toBeNull());
      expect(screen.queryByTestId('discard-prompt')).toBeNull();
    });
  });
});

describe('the Add dialog starts at the address (SS-2, SS-14)', () => {
  it('focuses the playlist URL, names both tab lists, and puts the optional name after the address', async () => {
    rpcMock.handlers['sources.list'] = () => [];
    renderAt(routes(), '/sources?add=1&kind=m3u');
    await screen.findByTestId('add-source-dialog');
    const url = within(dialog()).getByLabelText(/^Playlist URL/);
    await waitFor(() => expect(document.activeElement).toBe(url));
    expect(within(dialog()).getByRole('tablist', { name: 'Source type' })).toBeTruthy();
    expect(within(dialog()).getByRole('tablist', { name: 'Playlist from' })).toBeTruthy();
    const name = within(dialog()).getByLabelText(/^Name/, { selector: 'input' });
    expect(url.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector(`label[for="${name.id}"]`)?.textContent).toBe('Nameoptional');
  });

  it('a kind picked with the pointer moves focus to its address field', async () => {
    rpcMock.handlers['sources.list'] = () => [];
    renderAt(routes(), '/sources?add=1&kind=m3u');
    await screen.findByTestId('add-source-dialog');
    const tab = within(dialog()).getByRole('tab', { name: 'Xtream Codes' });
    fireEvent.pointerDown(tab);
    fireEvent.click(tab);
    await waitFor(() => expect(document.activeElement).toBe(within(dialog()).getByLabelText(/^Server URL/)));
  });

  it('says how often auto refresh runs, from the setting', async () => {
    rpcMock.handlers['sources.list'] = () => [];
    rpcMock.handlers['settings.get'] = () => settings({ sourceRefreshIntervalHours: 6 });
    renderAt(routes(), '/sources?add=1&kind=m3u');
    await screen.findByTestId('add-source-dialog');
    expect(await within(dialog()).findByText(/every 6 hours/)).toBeTruthy();
  });
});

describe('an Add left unnamed still adds (the name is optional)', () => {
  const playlist = '#EXTM3U\n#EXTINF:-1,One\nhttp://a.example.com/1';
  const field = (label: RegExp) => within(dialog()).getByLabelText(label, { selector: 'input,textarea' }) as HTMLInputElement;

  async function openM3u() {
    rpcMock.handlers['sources.list'] = () => [];
    rpcMock.handlers['sources.add'] = (a) => makeSource('new', { name: (a as { name: string }).name });
    rpcMock.handlers['m3u.parsePreview'] = () => ({ channelCount: 1, groups: [], epgUrls: [] });
    renderAt(routes(), '/sources?add=1&kind=m3u');
    await screen.findByTestId('add-source-dialog');
  }
  async function addedArgs() {
    fireEvent.click(screen.getByTestId('add-source-submit'));
    await waitFor(() => expect(rpcMock.callsOf('sources.add')).toHaveLength(1));
    return rpcMock.callsOf('sources.add')[0];
  }

  it('a pasted playlist is added as "Pasted playlist", not under an address typed before', async () => {
    await openM3u();
    fireEvent.change(field(/^Playlist URL/), { target: { value: 'http://lists.example.com/sports.m3u' } });
    fireEvent.blur(field(/^Playlist URL/));
    fireEvent.click(within(dialog()).getByRole('tab', { name: 'Paste' }));
    fireEvent.change(field(/^Playlist text/), { target: { value: playlist } });
    expect(field(/^Name/).placeholder).toBe('Pasted playlist');
    expect(await addedArgs()).toEqual({ kind: 'm3u', name: 'Pasted playlist', autoRefresh: false, m3u: { origin: 'text', text: playlist } });
  });

  it('an address submitted before it lost focus names the source', async () => {
    await openM3u();
    fireEvent.change(field(/^Playlist URL/), { target: { value: 'http://lists.example.com/sports.m3u' } });
    expect(await addedArgs()).toMatchObject({ name: 'sports', m3u: { origin: 'url', url: 'http://lists.example.com/sports.m3u' } });
  });
});

describe('saving connection fixes (SS-5, SS-16)', () => {
  it('a new password reloads the source at once', async () => {
    const source = xtream('a', { lastError: 'rejected the username or password', lastErrorCode: 'auth' });
    rpcMock.handlers['sources.list'] = () => [source];
    rpcMock.handlers['xtream.test'] = () => ({ ok: true });
    rpcMock.handlers['sources.update'] = () => ({ ...source, xtream: { ...source.xtream!, password: 'new-pw' } });
    rpcMock.handlers['sources.refresh'] = () => ({ ...source, lastError: undefined });
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('source-edit'));
    const edit = await screen.findByTestId('edit-source-dialog');
    fireEvent.change(within(edit).getByLabelText(/^Password/), { target: { value: 'new-pw' } });
    fireEvent.click(screen.getByTestId('edit-source-save'));
    await waitFor(() => expect(rpcMock.callsOf('sources.refresh')).toEqual([{ id: 'a' }]));
    expect(useToastStore.getState().toasts.some((t) => t.title === 'Saved XT a' && t.description === 'Refreshing with the new details.')).toBe(true);
  });

  it('an invalid guide shift blocks Save and goes back to the field', async () => {
    const source = xtream('a', { epg: { detectedUrls: [], manualUrls: [], disabledUrls: [], shiftMinutes: 60 } });
    rpcMock.handlers['sources.list'] = () => [source];
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('source-edit'));
    const edit = await screen.findByTestId('edit-source-dialog');
    fireEvent.click(within(edit).getByRole('tab', { name: 'Guide' }));
    fireEvent.change(within(edit).getByTestId('epg-shift-minutes'), { target: { value: '90m' } });
    // Off to another tab and back: the typed text stays.
    fireEvent.click(within(edit).getByRole('tab', { name: 'Details' }));
    fireEvent.click(screen.getByTestId('edit-source-save'));
    const field = await within(edit).findByTestId('epg-shift-minutes');
    expect((field as HTMLInputElement).value).toBe('90m');
    expect(document.activeElement).toBe(field);
    expect(rpcMock.callsOf('sources.update')).toEqual([]);
    expect(screen.getByTestId('edit-source-dialog')).toBeTruthy();
  });
});

describe('a short list (SS-10)', () => {
  it('shows no sort, filters or reorder hint with two sources, and ignores a saved filter', async () => {
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({ sort: 'name', kind: 'stalker', status: 'all' }));
    rpcMock.handlers['sources.list'] = () => [xtream('a'), makeSource('m', { position: 1 })];
    renderAt(routes(), '/sources');
    await waitFor(() => expect(screen.getAllByTestId('source-card')).toHaveLength(2));
    expect(screen.queryByTestId('sources-view')).toBeNull();
    expect(screen.queryByTestId('sources-view-hint')).toBeNull();
    expect(screen.getByTestId('sources-add')).toBeTruthy();
  });

  it('shows the controls from three sources, and no grip on a lone card', async () => {
    rpcMock.handlers['sources.list'] = () => [xtream('a'), xtream('b', { position: 1 }), xtream('c', { position: 2 })];
    renderAt(routes(), '/sources');
    expect(await screen.findByTestId('sources-view')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Move XT/ })).toHaveLength(3);
    cleanup();
    rpcMock.handlers['sources.list'] = () => [xtream('a')];
    renderAt(routes(), '/sources');
    await screen.findByTestId('source-card');
    expect(screen.queryByRole('button', { name: /^Move XT/ })).toBeNull();
  });

  it('badges a source that refreshes only by hand, and not one on the default', async () => {
    rpcMock.handlers['sources.list'] = () => [xtream('a', { autoRefresh: true }), xtream('b', { position: 1, autoRefresh: false })];
    renderAt(routes(), '/sources');
    const [a, b] = await screen.findAllByTestId('source-card');
    expect(within(a!).queryByTestId('source-manual-refresh')).toBeNull();
    expect(within(b!).getByTestId('source-manual-refresh').textContent).toBe('Manual refresh');
  });
});

describe('renames-only sources reach Reset all edits (SS-3)', () => {
  it('opens the hidden and renamed channels from the card menu', async () => {
    rpcMock.handlers['sources.list'] = () => [xtream('a')];
    rpcMock.handlers['channels.edits'] = (args) =>
      (args as { hiddenOnly?: boolean }).hiddenOnly
        ? []
        : [{ ref: { sourceId: 'a', contentType: 'live', itemId: '1' }, name: 'My News', originalName: 'News One', hidden: false }];
    renderAt(routes(), '/sources');
    await screen.findByTestId('source-card');
    chooseCardAction('Hidden and renamed channels');
    // The dialog is a lazy chunk: allow for a busy machine.
    const reset = await screen.findByRole('button', { name: 'Reset all edits' }, { timeout: 5000 });
    expect(reset).toBeTruthy();
  });
});
