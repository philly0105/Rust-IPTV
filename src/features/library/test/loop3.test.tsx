/** Loop 3 fixes on the library pages (L3-visual-6, L3-visual-11). */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Recording } from '@/api/types';

import { DownloadsPage } from '../pages/DownloadsPage';
import { MyVideosPage } from '../pages/MyVideosPage';
import { RecentPage } from '../pages/RecentPage';
import { ScheduledPage } from '../pages/ScheduledPage';
import { makeDownload, makeRecent } from './fixtures';
import { fakePlayer, installDomStubs, renderAt } from './harness';

const rpcMock = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import('./harness')['createRpcMock']> }));

vi.mock('@/api/transport', () => {
  class RpcError extends Error {
    code = 'internal';
    static from(err: unknown) {
      return err instanceof RpcError ? err : Object.assign(new RpcError(err instanceof Error ? err.message : String(err)), {});
    }
  }
  return {
    rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
    rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
    isDesktop: false,
    RpcError,
    proxiedUrl: (s: { url: string }) => s.url,
  };
});
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/shell', async () => (await import('./harness')).shellModule);
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);

const harness = await import('./harness');
rpcMock.current = harness.createRpcMock();
const rpc = rpcMock.current;

const ref = { sourceId: 's1', contentType: 'live' as const, itemId: '7' };
const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const rec = (over: Partial<Recording>): Recording => ({
  id: 'r1',
  ref,
  channelName: 'Alpha',
  title: 'Film',
  kind: 'programme',
  start: at(60),
  end: at(120),
  paddingBeforeMinutes: 1,
  paddingAfterMinutes: 5,
  status: 'scheduled',
  fileNames: [],
  bytes: 0,
  ...over,
});

/** A viewport the given media query matches (or not), for the phone layouts. */
function setPhone(phone: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: phone && query.includes('width < 40rem'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const originalMatchMedia = window.matchMedia;
beforeAll(installDomStubs);
beforeEach(() => {
  rpc.reset();
  rpc.handlers['sources.list'] = () => [];
  rpc.handlers['downloads.dir'] = () => ({ path: 'D:/Videos' });
  rpc.handlers['recordings.capabilities'] = () => ({ supported: true, mpv: true });
  rpc.handlers['recordings.library'] = () => [];
  fakePlayer.usePlayerStore.setState({ source: undefined, positionSeconds: 0 });
});
afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
});

describe('empty Scheduled page has one empty state (L3-visual-11)', () => {
  beforeEach(() => {
    rpc.handlers['reminders.list'] = () => [];
    rpc.handlers['recordings.list'] = () => [];
  });

  it('leaves out the empty series panel and its second guide button, and names Record series instead', async () => {
    rpc.handlers['recordings.rules'] = () => [];
    renderAt('/scheduled', [{ path: '/scheduled', element: <ScheduledPage /> }]);
    expect(await screen.findByText('Nothing scheduled')).toBeTruthy();
    expect(screen.getByText(/Record series on a programme/)).toBeTruthy();
    await waitFor(() => expect(rpc.callsOf('recordings.rules')).toHaveLength(1));
    expect(screen.queryByTestId('recording-rules')).toBeNull();
    expect(screen.getAllByRole('link').filter((a) => a.getAttribute('href') === '/epg')).toHaveLength(1);
  });

  it('still shows the panel when there is a rule, or when the rules failed to load', async () => {
    rpc.handlers['recordings.rules'] = () => [
      { id: 'rule1', ref, channelName: 'Alpha', title: 'Film', enabled: true, createdAt: at(-1000), upcoming: 0 },
    ];
    const view = renderAt('/scheduled', [{ path: '/scheduled', element: <ScheduledPage /> }]);
    expect(await within(await screen.findByTestId('recording-rules')).findByText('Film')).toBeTruthy();
    view.unmount();

    rpc.handlers['recordings.rules'] = () => {
      throw new Error('down');
    };
    renderAt('/scheduled', [{ path: '/scheduled', element: <ScheduledPage /> }]);
    expect(await screen.findByText('Nothing scheduled')).toBeTruthy();
    expect(await within(screen.getByTestId('recording-rules')).findByRole('alert')).toBeTruthy();
  });

  it('keeps the panel on a page with items, even with no rules', async () => {
    rpc.handlers['recordings.list'] = () => [rec({ id: 'next' })];
    rpc.handlers['recordings.rules'] = () => [];
    renderAt('/scheduled', [{ path: '/scheduled', element: <ScheduledPage /> }]);
    expect(await screen.findByTestId('scheduled-upcoming')).toBeTruthy();
    expect(screen.getByTestId('recording-rules')).toBeTruthy();
  });
});

describe('My Videos header subtitle (L3-visual-11)', () => {
  it('says nothing for an empty library instead of "0 titles, 0 B"', async () => {
    rpc.handlers['myvideos.list'] = () => [];
    renderAt('/my-videos', [{ path: '/my-videos', element: <MyVideosPage /> }]);
    await waitFor(() => expect(rpc.callsOf('myvideos.list')).toHaveLength(1));
    await screen.findByTestId('page-title');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('page-subtitle')).toBeNull();
  });

  it('counts a library that has titles', async () => {
    rpc.handlers['myvideos.list'] = () => [makeDownload({ id: 1, status: 'completed', title: 'Heat', fileAvailable: true, completedAt: '2026-10-14T00:00:00Z' })];
    renderAt('/my-videos', [{ path: '/my-videos', element: <MyVideosPage /> }]);
    expect((await screen.findByTestId('page-subtitle')).textContent).toMatch(/1 title/);
  });
});

describe('phone headers (L3-visual-6)', () => {
  it('Downloads: the My Videos link is an icon on a phone, with its label for screen readers and as a tooltip', async () => {
    rpc.handlers['downloads.list'] = () => [];
    rpc.handlers['myvideos.list'] = () => [];
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);
    const link = await screen.findByRole('link', { name: 'Open My Videos' });
    expect(link.getAttribute('title')).toBe('Open My Videos');
    expect(within(link).getByText('Open My Videos').className).toContain('max-sm:sr-only');
  });

  it('Recent: on a phone Clear history moves out of the header into a bar above the list', async () => {
    setPhone(true);
    rpc.handlers['recent.list'] = () => [makeRecent('a', new Date().toISOString()), makeRecent('b', '2025-01-01T00:00:00Z')];
    rpc.handlers['positions.continueWatching'] = () => [];
    rpc.handlers['recent.clear'] = () => undefined;
    renderAt('/recent', [{ path: '/recent', element: <RecentPage /> }]);
    const bar = await screen.findByTestId('recent-phone-bar');
    expect(bar.textContent).toContain('2 items');
    expect(within(screen.getByTestId('fake-header')).queryByRole('button', { name: 'Clear history' })).toBeNull();
    fireEvent.click(within(bar).getByRole('button', { name: 'Clear history' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear history' }));
    await waitFor(() => expect(rpc.callsOf('recent.clear')).toEqual([{}]));
  });

  it('Recent: wider screens keep Clear history in the header', async () => {
    setPhone(false);
    rpc.handlers['recent.list'] = () => [makeRecent('a', new Date().toISOString())];
    rpc.handlers['positions.continueWatching'] = () => [];
    renderAt('/recent', [{ path: '/recent', element: <RecentPage /> }]);
    await screen.findAllByTestId('entry-row');
    expect(within(screen.getByTestId('fake-header')).getByRole('button', { name: 'Clear history' })).toBeTruthy();
    expect(screen.queryByTestId('recent-phone-bar')).toBeNull();
  });
});
