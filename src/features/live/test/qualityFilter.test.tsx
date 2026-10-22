/**
 * The Live TV quality filter: the list toolbar's picker writes liveMinQuality and
 * liveHideUntagged (TV only, never on Radio), and a live list or the guide the filter leaves
 * empty says so and offers every quality again, before the group, view and source empty states.
 */
import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, Page, PageQuery, Settings } from '@/api/types';

import { resetChannelListMemory } from '../components/ChannelList';
import { EpgGridPage } from '../components/EpgGridPage';
import { LivePage } from '../components/LivePage';
import { installDomStubs, makeChannel, renderAt, settings } from './harness';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const calls: { cmd: string; args: unknown }[] = [];
  const call = async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { handlers, calls, call };
});

vi.mock('@/api/transport', () => ({
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
  RpcError: class RpcError extends Error {},
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/ui', async (orig) => ({ ...(await orig<object>()), ...(await import('./fakes')) }));
vi.mock('@/shell', async () => await import('./fakes'));
vi.mock('@/features/player', async () => await import('./fakes'));
vi.mock('@/features/player/remote', async () => await import('./fakes'));

const fakes = await import('./fakes');

const LIVE = [{ path: '/s/:sourceId/live/:categoryId?', element: <LivePage /> }];
const GUIDE = [{ path: '/epg', element: <EpgGridPage /> }];

function serve(all: Channel[]) {
  return (a: unknown) => {
    const q = (a as { query: PageQuery }).query;
    return { items: all.slice(q.offset, q.offset + q.limit), total: all.length, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
}

/** The core's settings: `settings.update` merges the patch (null clears) and answers the result. */
let stored: Settings;
const patches = () => rpcMock.calls.filter((c) => c.cmd === 'settings.update').map((c) => (c.args as { patch: unknown }).patch);
const trigger = () => screen.getByTestId('live-quality-filter');
const panel = () => screen.getByRole('dialog', { name: 'Channel quality' });

vi.setConfig({ testTimeout: 15_000 });
beforeAll(() => {
  configure({ asyncUtilTimeout: 4000 });
  installDomStubs();
});
beforeEach(() => {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  stored = settings();
  h['sources.get'] = () => ({ id: 'src1', kind: 'xtream', name: 'Demo portal', channelCount: 20, movieCount: 0, seriesCount: 0, epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } });
  h['sources.list'] = () => [h['sources.get']!({})];
  // Answers with the settings as they are once it answers, as the core does: this client refetches
  // on every mount (settings.get is never stale in the app), and an answer taken before a write
  // but landing after it would put the old settings back.
  h['settings.get'] = () => new Promise((r) => setTimeout(() => r(stored), 0));
  h['settings.update'] = (a) => (stored = { ...stored, ...(a as { patch: Partial<Settings> }).patch });
  h['catalog.categories'] = () => [{ id: 'g1', sourceId: 'src1', contentType: 'live', name: 'News', hidden: false, itemCount: 20, position: 0 }];
  h['catalog.channels'] = serve(Array.from({ length: 20 }, (_, i) => makeChannel(i)));
  h['epg.nowNext'] = () => ({});
  h['epg.programs'] = () => [];
  h['epg.grid'] = () => ({});
  h['favorites.contains'] = () => [];
  h['favorites.list'] = () => [];
  h['recent.list'] = () => [];
  h['remote.status'] = () => ({ running: false, port: 7310 });
  h['catalog.item'] = (a) => makeChannel(Number((a as { ref: { itemId: string } }).ref.itemId.slice(1)));
  resetChannelListMemory();
  fakes.usePlayerStore.setState({ source: undefined } as never);
});
afterEach(() => {
  cleanup();
});

describe('Live TV quality picker', () => {
  it('writes the minimum and the untagged toggle, which needs a minimum', async () => {
    renderAt('/s/src1/live', LIVE);
    await screen.findByText('Channel 0');
    const button = await screen.findByRole('button', { name: 'Channel quality, Any quality' });
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.className).not.toMatch(/\bbg-fg\b/);

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const any = within(panel()).getByRole('radio', { name: 'Any quality' }) as HTMLInputElement;
    expect(any.checked).toBe(true);
    // Straight to the chosen quality.
    expect(document.activeElement).toBe(any);
    expect(within(panel()).getAllByRole('radio').map((r) => r.getAttribute('data-testid'))).toEqual([
      'live-quality-any',
      'live-quality-hd',
      'live-quality-fhd',
      'live-quality-uhd',
    ]);
    const untagged = within(panel()).getByRole('switch', { name: 'Hide channels with no quality tag' }) as HTMLButtonElement;
    expect(untagged.disabled).toBe(true);

    fireEvent.click(within(panel()).getByRole('radio', { name: 'Full HD (1080p) and up' }));
    await waitFor(() => expect(patches()).toEqual([{ liveMinQuality: 'fhd' }]));
    await waitFor(() => expect(untagged.disabled).toBe(false));
    // Inverted while a minimum is set, and named after it.
    expect(screen.getByRole('button', { name: 'Channel quality, Full HD (1080p) and up' }).className).toMatch(/\bbg-fg\b/);

    fireEvent.click(untagged);
    await waitFor(() => expect(patches()).toEqual([{ liveMinQuality: 'fhd' }, { liveHideUntagged: true }]));
    await waitFor(() => expect(untagged.getAttribute('aria-checked')).toBe('true'));

    fireEvent.click(within(panel()).getByRole('radio', { name: 'Any quality' }));
    await waitFor(() => expect(patches().at(-1)).toEqual({ liveMinQuality: null }));
    await waitFor(() => expect(untagged.disabled).toBe(true));
    expect(trigger().className).not.toMatch(/\bbg-fg\b/);
  });

  it('closes on Escape, on Tab past its end and on a press outside, focus back on the button where the keyboard left', async () => {
    renderAt('/s/src1/live', LIVE);
    await screen.findByText('Channel 0');

    fireEvent.click(trigger());
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Channel quality' })).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('false');

    // With "Any" the switch is disabled: the chosen radio is the panel's only stop.
    fireEvent.click(trigger());
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(screen.queryByRole('dialog', { name: 'Channel quality' })).toBeNull();
    expect(document.activeElement).toBe(trigger());

    fireEvent.click(trigger());
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog', { name: 'Channel quality' })).toBeNull();
    expect(patches()).toEqual([]);
  });

  it('is not on Radio, which is never filtered', async () => {
    stored = settings({ liveMinQuality: 'fhd' });
    rpcMock.handlers['catalog.categories'] = () => [];
    rpcMock.handlers['catalog.channels'] = serve([]);
    renderAt('/s/src1/radio', [{ path: '/s/:sourceId/radio', element: <LivePage mode="radio" /> }]);
    expect(await screen.findByText('No radio stations in this source')).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Search stations' })).toBeTruthy();
    expect(screen.queryByTestId('live-quality-filter')).toBeNull();
    expect(screen.queryByText('No channels match the quality filter')).toBeNull();
  });
});

describe('Lists the quality filter empties', () => {
  it('a group says so and offers the untagged channels, then every quality, again', async () => {
    stored = settings({ liveMinQuality: 'fhd', liveHideUntagged: true });
    rpcMock.handlers['catalog.channels'] = serve([]);
    renderAt('/s/src1/live/g1', LIVE);
    expect(await screen.findByText('No channels match the quality filter')).toBeTruthy();
    expect(screen.getByText('Channels whose name marks a lower quality, or no quality, are hidden.')).toBeTruthy();
    expect(screen.queryByText('This group has no channels')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show untagged channels' }));
    await waitFor(() => expect(patches()).toEqual([{ liveHideUntagged: false }]));
    expect(await screen.findByText('Channels whose name marks a lower quality are hidden.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show untagged channels' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show all qualities' }));
    await waitFor(() => expect(patches().at(-1)).toEqual({ liveMinQuality: null }));
    // Off again: the group's own empty state.
    expect(await screen.findByText('This group has no channels')).toBeTruthy();
  });

  it('Favorites, Recently watched and All channels show it before their own empty states', async () => {
    stored = settings({ liveMinQuality: 'uhd' });
    rpcMock.handlers['catalog.channels'] = serve([]);
    for (const [path, own] of [
      ['/s/src1/live/@favorites', 'No favorite channels yet'],
      ['/s/src1/live/@recent', 'Nothing watched yet'],
      ['/s/src1/live', 'No channels in this source'],
    ] as const) {
      renderAt(path, LIVE);
      expect(await screen.findByText('No channels match the quality filter')).toBeTruthy();
      expect(screen.queryByText(own)).toBeNull();
      cleanup();
    }
  });

  it('a source with no channels at all keeps its own empty state', async () => {
    stored = settings({ liveMinQuality: 'hd' });
    rpcMock.handlers['sources.get'] = () => ({ id: 'src1', kind: 'xtream', name: 'Demo portal', channelCount: 0, movieCount: 5, seriesCount: 0, epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } });
    rpcMock.handlers['catalog.categories'] = () => [];
    rpcMock.handlers['catalog.channels'] = serve([]);
    renderAt('/s/src1/live', LIVE);
    expect(await screen.findByText('No channels in this source')).toBeTruthy();
    expect(screen.queryByText('No channels match the quality filter')).toBeNull();
  });

  it('the guide says so too, and Show all qualities turns the filter off', async () => {
    stored = settings({ liveMinQuality: 'fhd' });
    rpcMock.handlers['catalog.channels'] = serve([]);
    renderAt('/epg?source=src1', GUIDE);
    expect(await screen.findByText('No channels match the quality filter')).toBeTruthy();
    expect(screen.getByText('Channels whose name marks a lower quality are hidden.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show untagged channels' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show all qualities' }));
    await waitFor(() => expect(patches()).toEqual([{ liveMinQuality: null }]));
    expect(await screen.findByText('No channels in this source')).toBeTruthy();
  });
});
