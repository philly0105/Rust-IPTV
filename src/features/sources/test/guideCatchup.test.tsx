import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CatchupOverride } from '@/api/types';

import { buildUpdatePatch, draftFromSource, patchNeedsRefresh } from '../lib/draft';
import { eagerRoutes, installDomStubs, makeSource, renderAt, rpcMock } from './harness';

// Guide slice: the M3U catch-up override in the source edit dialog.

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
const routes = () => [...sourcesRoutes, { path: 's/:id/live', element: <div>live page</div> }];
const dialog = () => screen.getByRole('dialog');

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  localStorage.clear();
});
afterEach(cleanup);

const playlist = (catchup?: CatchupOverride) => makeSource('p', { name: 'Playlist', m3u: { origin: 'url', url: 'http://pl.example.com/list.m3u', headers: {}, ...(catchup ? { catchup } : {}) } });

describe('catch-up override in the edit dialog', () => {
  it('saves a type, template and days without asking for a refresh', async () => {
    const before = playlist();
    rpcMock.handlers['sources.list'] = () => [before];
    rpcMock.handlers['sources.update'] = (a) => ({ ...before, m3u: (a as { patch: { m3u: object } }).patch.m3u });
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('source-edit'));
    const box = within(dialog()).getByTestId('catchup-override');
    // Closed until an override is set; template and days appear for a real type only.
    expect(box.hasAttribute('open')).toBe(false);
    fireEvent.change(within(box).getByTestId('catchup-type'), { target: { value: 'flussonic' } });
    fireEvent.change(within(box).getByTestId('catchup-template'), { target: { value: ' http://arc/{utc}.ts ' } });
    fireEvent.change(within(box).getByTestId('catchup-days'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('edit-source-save'));
    await waitFor(() =>
      expect(rpcMock.callsOf('sources.update')).toEqual([
        { id: 'p', patch: { m3u: { origin: 'url', url: 'http://pl.example.com/list.m3u', headers: {}, catchup: { type: 'flussonic', template: 'http://arc/{utc}.ts', days: 3 } } } },
      ]),
    );
    expect(rpcMock.callsOf('sources.refresh')).toEqual([]);
  });

  it('shows the days error inline and does not save', async () => {
    rpcMock.handlers['sources.list'] = () => [playlist({ type: 'shift' })];
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('source-edit'));
    const box = within(dialog()).getByTestId('catchup-override');
    expect(box.hasAttribute('open')).toBe(true);
    fireEvent.change(within(box).getByTestId('catchup-days'), { target: { value: '400' } });
    fireEvent.click(screen.getByTestId('edit-source-save'));
    expect(await within(box).findByText('Enter a whole number of days from one to 366.')).toBeTruthy();
    expect(rpcMock.callsOf('sources.update')).toEqual([]);
  });
});

describe('catch-up override patch', () => {
  const ctx = { isDesktop: false };

  it('clears the override when the playlist default is chosen again', () => {
    const src = playlist({ type: 'xc', days: 2 });
    const draft = draftFromSource(src);
    expect(draft.m3u.catchup).toEqual({ type: 'xc', template: '', days: '2' });
    draft.m3u.catchup = { type: '', template: '', days: '' };
    const r = buildUpdatePatch(src, draft, ctx);
    expect(r.ok && r.value.m3u).toEqual({ origin: 'url', url: 'http://pl.example.com/list.m3u', headers: {} });
  });

  it('leaves the patch empty when nothing changed', () => {
    const src = playlist({ type: 'none' });
    const r = buildUpdatePatch(src, draftFromSource(src), ctx);
    expect(r.ok && r.value).toEqual({});
  });

  it('never needs a refresh for an override-only change', () => {
    const src = playlist();
    expect(patchNeedsRefresh({ m3u: { ...src.m3u!, catchup: { type: 'shift' } } }, src)).toBe(false);
    expect(patchNeedsRefresh({ m3u: { ...src.m3u!, url: 'http://other/list.m3u', catchup: { type: 'shift' } } }, src)).toBe(true);
  });
});
