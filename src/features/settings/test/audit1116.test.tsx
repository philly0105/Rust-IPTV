/**
 * Settings fixes from the 2026-11-16 UI audit: Playback in groups by what they act on
 * (settings-01), Double-click to play on touch-only devices (settings-14), and the rows' touch
 * and dimming behaviour.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Settings } from '@/api/types';

import { eagerRoutes, installDomStubs, renderAt, rpcMock, settings } from '../../sources/test/harness';

const flags = vi.hoisted(() => ({ desktop: false }));
vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  get isDesktop() {
    return flags.desktop;
  },
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
  onConnectionState: () => () => undefined,
}));

const settingsRoutes = await eagerRoutes((await import('../routes')).settingsRoutes);
const { TOUCH_ONLY_QUERY } = await import('../components');

let current: Settings;
const realMatchMedia = window.matchMedia;

function matchQueries(queries: string[]) {
  window.matchMedia = ((query: string) => ({
    matches: queries.includes(query),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeAll(installDomStubs);
afterAll(() => {
  window.matchMedia = realMatchMedia;
});
beforeEach(() => {
  rpcMock.reset();
  flags.desktop = false;
  matchQueries([]);
  current = settings();
  rpcMock.handlers['settings.get'] = () => current;
  rpcMock.handlers['settings.update'] = (a) => {
    current = { ...current, ...(a as { patch: Partial<Settings> }).patch };
    return current;
  };
  rpcMock.handlers['player.capabilities'] = () => ({ embeddedMpv: false });
  rpcMock.handlers['downloads.dir'] = () => ({ path: '/data/downloads' });
});
afterEach(cleanup);

/** The group a control sits in, by its id. */
const groupOf = (el: HTMLElement) => el.closest('[data-settings-group]')?.id;

describe('Playback groups (settings-01)', () => {
  it('puts each switch in the group it acts on, with Show captions leading Subtitles', async () => {
    renderAt(settingsRoutes, '/settings/playback');
    await screen.findByTestId('settings-playback');
    for (const key of ['streamReconnect', 'liveFailover', 'zapBanner', 'fullscreenChannelPanel', 'openStreamOnDoubleClick']) {
      expect(groupOf(screen.getByTestId(`toggle-${key}`))).toBe('live');
    }
    for (const key of ['playerAutoplayNextEpisode', 'playerUpNextRail', 'vodAutoFailover']) {
      expect(groupOf(screen.getByTestId(`toggle-${key}`))).toBe('episodes');
    }
    expect(groupOf(screen.getByTestId('toggle-playerAmbientMode'))).toBe('picture');
    const captions = screen.getByTestId('toggle-showCaptions');
    expect(groupOf(captions)).toBe('subtitles');
    // The on switch comes before the preview and the look.
    const preview = screen.getByTestId('settings-subtitles');
    expect(captions.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Player', 'Live TV', 'Movies and series', 'Picture', 'Subtitles']);
  });

  it('leaves Double-click to play out on a touch-only device, unless it is on', async () => {
    matchQueries([TOUCH_ONLY_QUERY]);
    renderAt(settingsRoutes, '/settings/playback');
    await screen.findByTestId('settings-playback');
    expect(screen.queryByTestId('toggle-openStreamOnDoubleClick')).toBeNull();
    cleanup();
    current = { ...current, openStreamOnDoubleClick: true };
    renderAt(settingsRoutes, '/settings/playback');
    await screen.findByTestId('settings-playback');
    // Set on a computer: still here, so it can be turned off.
    expect(screen.getByTestId('toggle-openStreamOnDoubleClick')).toBeTruthy();
  });
});

describe('switch rows on touch (settings-03)', () => {
  it('toggles from a tap on the help text with a coarse pointer, and not with a mouse', async () => {
    renderAt(settingsRoutes, '/settings/playback');
    await screen.findByTestId('settings-playback');
    const help = screen.getByText('Tints the space around the video with its colors.');
    fireEvent.click(help);
    expect(rpcMock.callsOf('settings.update')).toEqual([]);
    cleanup();
    matchQueries(['(pointer: coarse)']);
    renderAt(settingsRoutes, '/settings/playback');
    await screen.findByTestId('settings-playback');
    fireEvent.click(screen.getByText('Tints the space around the video with its colors.'));
    await waitFor(() => expect(rpcMock.callsOf('settings.update')).toEqual([{ patch: { playerAmbientMode: !settings().playerAmbientMode } }]));
  });

  it('leaves the label and the switch to the browser, so a tap there toggles once', async () => {
    matchQueries(['(pointer: coarse)']);
    renderAt(settingsRoutes, '/settings/playback');
    await screen.findByTestId('settings-playback');
    fireEvent.click(screen.getByTestId('toggle-playerAmbientMode'));
    await waitFor(() => expect(rpcMock.callsOf('settings.update')).toHaveLength(1));
  });
});

describe('Recording (settings-13, downloads-recording-23)', () => {
  it('with reminders off, says why and turns off the rows they govern', async () => {
    current = { ...current, remindersEnabled: false };
    renderAt(settingsRoutes, '/settings/recording');
    await screen.findByTestId('settings-recording');
    expect(screen.getByTestId('reminders-off-note').textContent).toBe('Turn on Programme reminders to choose when and how.');
    expect((screen.getByTestId('reminder-lead') as HTMLSelectElement).disabled).toBe(true);
    const action = screen.getByRole('radiogroup', { name: 'When a reminder is due' });
    for (const r of within(action).getAllByRole('radio')) expect((r as HTMLButtonElement).disabled).toBe(true);
  });

  it('on a server that cannot record, says so and turns off the padding', async () => {
    rpcMock.handlers['recordings.capabilities'] = () => ({ supported: false, mpv: false });
    renderAt(settingsRoutes, '/settings/recording');
    expect(await screen.findByTestId('recording-unsupported-note')).toBeTruthy();
    expect((screen.getByTestId('recording-padding-before') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByTestId('recording-padding-after') as HTMLSelectElement).disabled).toBe(true);
  });
});

describe('Remote control in a browser (settings-10)', () => {
  it('leads with where the control page works, before the switch', async () => {
    rpcMock.handlers['remote.status'] = () => ({ running: false, port: 7310 });
    renderAt(settingsRoutes, '/settings/remote');
    const callout = await screen.findByTestId('remote-lan-server');
    const sw = screen.getByTestId('toggle-remote');
    expect(callout.compareDocumentPosition(sw) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/To use a phone, use the desktop app/)).toBeTruthy();
  });
});

describe('General (settings-08)', () => {
  it('says the app opens on the first source while Home is off', async () => {
    current = { ...current, showDashboard: false };
    renderAt(settingsRoutes, '/settings/general');
    await screen.findByTestId('settings-general');
    expect(screen.getByText('Where the app opens. Home is off, so it opens on your first source.')).toBeTruthy();
  });
});
