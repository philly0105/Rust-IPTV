/** Settings > Remote: phones on the local network (LAN mode, pairing QR, paired devices). Desktop build. */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { invalidate } from '@/api/query';
import type { RemoteDevice, RemotePairing, RemoteServerStatus } from '@/api/rpc';
import { RpcError } from '@/api/transport';
import type { Settings } from '@/api/types';

import { eagerRoutes, installDomStubs, renderAt, rpcMock, settings } from '../../sources/test/harness';
import { addressLabel, deviceLabel, lanView, nextReveal, pairCode, pickAddress, qrViewBox } from '../lib/remoteLan';

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: true,
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
  onConnectionState: () => () => undefined,
}));

const settingsRoutes = await eagerRoutes((await import('../routes')).settingsRoutes);
const { useToastStore } = await import('@/ui');

const wifi = { ip: '192.168.1.5', interface: 'Wi-Fi', url: 'http://192.168.1.5:7208/' };
const eth = { ip: '10.0.0.7', interface: 'Ethernet', url: 'http://10.0.0.7:7208/' };
const running = (over: Partial<RemoteServerStatus> = {}): RemoteServerStatus => ({
  running: true,
  url: 'http://127.0.0.1:7208/',
  port: 7208,
  lanAddresses: [wifi],
  ...over,
});
const pairing = (ip = wifi.ip): RemotePairing => ({
  url: `http://${ip}:7208/?pair=abcDEF123`,
  address: ip,
  expiresAt: '2026-10-12T10:05:00Z',
  expiresInSecs: 300,
  qr: { size: 29, path: 'M0 0h7v1h-7z' },
});
const device = (id: string, browser: string, os?: string): RemoteDevice => ({
  id,
  name: os ? { browser, os } : { browser },
  pairedAt: '2026-10-12T09:00:00Z',
  lastSeen: '2026-10-12T09:30:00Z',
});

let current: Settings;
let status: RemoteServerStatus;
let devices: RemoteDevice[];
const toasts = () => useToastStore.getState().toasts.map((t) => t.title);

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  useToastStore.setState({ toasts: [] });
  current = settings({ remoteControl: { ...settings().remoteControl, enabled: true }, remoteLanEnabled: true });
  status = running();
  devices = [];
  rpcMock.handlers['settings.get'] = () => current;
  rpcMock.handlers['settings.update'] = (a) => {
    current = { ...current, ...(a as { patch: Partial<Settings> }).patch };
    return current;
  };
  rpcMock.handlers['remote.status'] = () => status;
  rpcMock.handlers['remote.start'] = () => ({ url: status.url });
  rpcMock.handlers['remote.pairingCode'] = (a) => pairing((a as { address?: string }).address);
  rpcMock.handlers['remote.devices'] = () => devices;
});
afterEach(cleanup);

describe('remoteLan helpers', () => {
  it('lanView picks the state to show', () => {
    expect(lanView(false, true, running())).toEqual({ kind: 'server' });
    expect(lanView(true, false, running())).toEqual({ kind: 'off' });
    expect(lanView(true, true, undefined)).toEqual({ kind: 'stopped' });
    expect(lanView(true, true, { running: false, port: 7208 })).toEqual({ kind: 'stopped' });
    expect(lanView(true, true, running({ lanAddresses: [], lanError: 'no private network address found' }))).toEqual({
      kind: 'error',
      message: 'no private network address found',
    });
    expect(lanView(true, true, running())).toEqual({ kind: 'ready', addresses: [wifi] });
    expect(lanView(true, true, running({ lanError: '10.0.0.7: in use' }))).toEqual({
      kind: 'ready',
      addresses: [wifi],
      warning: '10.0.0.7: in use',
    });
  });

  it('pickAddress keeps a still-offered choice, else the first', () => {
    expect(pickAddress([wifi, eth], undefined)).toBe(wifi.ip);
    expect(pickAddress([wifi, eth], eth.ip)).toBe(eth.ip);
    expect(pickAddress([wifi], eth.ip)).toBe(wifi.ip);
    expect(pickAddress([], eth.ip)).toBeUndefined();
  });

  it('addressLabel and qrViewBox', () => {
    expect(addressLabel(wifi)).toBe('192.168.1.5 (Wi-Fi)');
    expect(addressLabel({ ...wifi, interface: '' })).toBe('192.168.1.5');
    expect(qrViewBox(29)).toBe('-4 -4 37 37');
  });

  it('pairCode reads the code from the pairing URL', () => {
    expect(pairCode('http://192.168.1.5:7208/?pair=abcDEF123')).toBe('abcDEF123');
    expect(pairCode('http://192.168.1.5:7208/')).toBe('');
    expect(pairCode('not a url')).toBe('');
  });

  it('nextReveal pins the first fresh code and hides once it is used or expired', () => {
    const p = pairing();
    const start = { since: 1_000 };
    // A response from before the user asked is ignored.
    expect(nextReveal(start, p, 999, 1_000)).toBe(start);
    const pinned = nextReveal(start, p, 1_000, 1_000);
    expect(pinned).toEqual({ since: 1_000, code: 'abcDEF123', until: 301_000 });
    if (!pinned) throw new Error('expected a pinned reveal');
    expect(nextReveal(pinned, p, 6_000, 6_000)).toBe(pinned);
    expect(nextReveal(pinned, { ...p, url: 'http://192.168.1.5:7208/?pair=next' }, 6_000, 6_000)).toBeNull();
    expect(nextReveal(pinned, p, 301_000, 301_000)).toBeNull();
  });

  it('deviceLabel names browser and OS, or falls back', () => {
    const t = (key: string, o?: Record<string, unknown>) => (key === 'remoteDeviceName' ? `${o?.browser} on ${o?.os}` : 'Unknown browser');
    expect(deviceLabel({ browser: 'Safari', os: 'iPhone' }, t)).toBe('Safari on iPhone');
    expect(deviceLabel({ browser: 'Chrome' }, t)).toBe('Chrome');
    expect(deviceLabel({ browser: ' ', os: 'Android' }, t)).toBe('Unknown browser on Android');
    expect(deviceLabel({ browser: '' }, t)).toBe('Unknown browser');
  });
});

describe('Settings > Remote: phones on this network', () => {
  it('says the loopback address is for this computer only', async () => {
    renderAt(settingsRoutes, '/settings/remote');
    await screen.findByTestId('settings-remote');
    expect(await screen.findByText(/works only in a browser on this computer/)).toBeTruthy();
  });

  it('turning LAN mode on asks first, then saves and restarts the server', async () => {
    current = { ...current, remoteLanEnabled: false };
    renderAt(settingsRoutes, '/settings/remote');
    const toggle = await screen.findByTestId('toggle-remote-lan');
    expect(screen.queryByTestId('remote-pairing')).toBeNull();
    fireEvent.click(toggle);
    const dialog = await screen.findByTestId('remote-lan-confirm');
    expect(dialog.textContent).toContain('Windows may ask to allow access on private networks');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('remote-lan-confirm')).toBeNull());
    expect(rpcMock.callsOf('settings.update')).toEqual([]);

    fireEvent.click(screen.getByTestId('toggle-remote-lan'));
    fireEvent.click(await screen.findByTestId('remote-lan-confirm-on'));
    await waitFor(() => expect(rpcMock.callsOf('remote.start').length).toBe(1));
    expect(rpcMock.callsOf('settings.update')).toEqual([{ patch: { remoteLanEnabled: true } }]);
    fireEvent.click(await screen.findByTestId('remote-show-code'));
    expect(await screen.findByTestId('remote-qr')).toBeTruthy();
  });

  it('turning LAN mode off saves without asking', async () => {
    renderAt(settingsRoutes, '/settings/remote');
    fireEvent.click(await screen.findByTestId('toggle-remote-lan'));
    await waitFor(() => expect(rpcMock.callsOf('settings.update')).toEqual([{ patch: { remoteLanEnabled: false } }]));
    expect(screen.queryByTestId('remote-lan-confirm')).toBeNull();
  });

  it('shows the QR code, the link and copies it', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderAt(settingsRoutes, '/settings/remote');
    fireEvent.click(await screen.findByTestId('remote-show-code'));
    const qr = await screen.findByTestId('remote-qr');
    expect(qr.getAttribute('viewBox')).toBe('-4 -4 37 37');
    expect(qr.querySelector('path')?.getAttribute('d')).toBe('M0 0h7v1h-7z');
    expect(screen.getByTestId('remote-pair-url').textContent).toBe('http://192.168.1.5:7208/?pair=abcDEF123');
    expect(screen.queryByTestId('remote-lan-address')).toBeNull();
    fireEvent.click(within(screen.getByTestId('remote-pairing')).getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('http://192.168.1.5:7208/?pair=abcDEF123'));
    expect(toasts()).toContain('Link copied');
  });

  it('keeps the pairing code hidden until asked (R-remote-F6)', async () => {
    renderAt(settingsRoutes, '/settings/remote');
    const card = await screen.findByTestId('remote-pairing');
    expect(within(card).getByTestId('remote-show-code').textContent).toBe('Show pairing code');
    expect(screen.queryByTestId('remote-qr')).toBeNull();
    expect(screen.queryByTestId('remote-pair-url')).toBeNull();
    // Give any query a chance to run: none may fetch the code.
    await screen.findByTestId('remote-devices-empty');
    expect(rpcMock.callsOf('remote.pairingCode')).toEqual([]);

    fireEvent.click(screen.getByTestId('remote-show-code'));
    await screen.findByTestId('remote-qr');
    fireEvent.click(screen.getByTestId('remote-hide-code'));
    await waitFor(() => expect(screen.queryByTestId('remote-qr')).toBeNull());
    expect(screen.getByTestId('remote-show-code')).toBeTruthy();
  });

  it('hides the code again once a phone used it', async () => {
    let code = 'first';
    rpcMock.handlers['remote.pairingCode'] = () => ({ ...pairing(), url: `http://192.168.1.5:7208/?pair=${code}` });
    renderAt(settingsRoutes, '/settings/remote');
    fireEvent.click(await screen.findByTestId('remote-show-code'));
    await screen.findByTestId('remote-qr');
    // A phone paired: the core now hands out a new code, which is not shown.
    code = 'second';
    void invalidate('remote.pairingCode');
    await waitFor(() => expect(screen.queryByTestId('remote-qr')).toBeNull());
    expect(screen.getByTestId('remote-show-code')).toBeTruthy();
  });

  it('asks for the code on the first address when there are several', async () => {
    status = running({ lanAddresses: [wifi, eth] });
    renderAt(settingsRoutes, '/settings/remote');
    fireEvent.click(await screen.findByTestId('remote-show-code'));
    await screen.findByTestId('remote-qr');
    expect(screen.getByTestId('remote-lan-address')).toBeTruthy();
    expect(rpcMock.callsOf('remote.pairingCode')[0]).toEqual({ address: wifi.ip });
  });

  it('explains when the remote control itself is off', async () => {
    status = { running: false, port: 7208 };
    current = { ...current, remoteControl: { ...current.remoteControl, enabled: false } };
    renderAt(settingsRoutes, '/settings/remote');
    expect((await screen.findByTestId('remote-lan-stopped')).textContent).toContain('Allow remote control');
    expect(rpcMock.callsOf('remote.pairingCode')).toEqual([]);
  });

  it('shows why phones cannot connect, with a retry', async () => {
    status = running({ lanAddresses: [], lanError: 'no private network address found' });
    renderAt(settingsRoutes, '/settings/remote');
    const err = await screen.findByTestId('remote-lan-error');
    expect(err.textContent).toContain('no private network address found');
    fireEvent.click(within(err).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(rpcMock.callsOf('remote.start').length).toBe(1));
  });

  it('shows a pairing code failure', async () => {
    rpcMock.handlers['remote.pairingCode'] = () => {
      throw new RpcError('conflict', 'remote control is not listening on the network');
    };
    renderAt(settingsRoutes, '/settings/remote');
    fireEvent.click(await screen.findByTestId('remote-show-code'));
    const pairingCard = await screen.findByTestId('remote-pairing');
    expect((await within(pairingCard).findByRole('alert')).textContent).toContain('not listening on the network');
  });

  it('lists paired phones and revokes one', async () => {
    devices = [device('a1', 'Safari', 'iPhone'), device('b2', 'Chrome', 'Android')];
    rpcMock.handlers['remote.revokeDevice'] = (a) => {
      devices = devices.filter((d) => d.id !== (a as { id: string }).id);
    };
    renderAt(settingsRoutes, '/settings/remote');
    const list = await screen.findByTestId('remote-devices');
    expect(list.textContent).toContain('Safari on iPhone');
    expect(list.textContent).toContain('Chrome on Android');
    // A Latin name in an RTL UI truncates at its own end (L2-visual-7).
    expect(within(list).getByText('Safari on iPhone').getAttribute('dir')).toBe('auto');
    fireEvent.click(within(list).getByRole('button', { name: 'Revoke Safari on iPhone' }));
    await waitFor(() => expect(rpcMock.callsOf('remote.revokeDevice')).toEqual([{ id: 'a1' }]));
    await waitFor(() => expect(screen.getByTestId('remote-devices').textContent).not.toContain('Safari'));
    expect(toasts()).toContain('Phone revoked');
  });

  it('shows the empty and error states of the device list', async () => {
    renderAt(settingsRoutes, '/settings/remote');
    expect((await screen.findByTestId('remote-devices-empty')).textContent).toBe('No phones paired yet.');
    cleanup();

    rpcMock.handlers['remote.devices'] = () => {
      throw new RpcError('internal', 'database locked');
    };
    renderAt(settingsRoutes, '/settings/remote');
    expect((await screen.findByTestId('remote-devices-error')).textContent).toContain('database locked');
  });

  it('reset pairing asks first, then resets', async () => {
    rpcMock.handlers['remote.resetPairing'] = () => undefined;
    renderAt(settingsRoutes, '/settings/remote');
    fireEvent.click(await screen.findByTestId('remote-reset-pairing'));
    fireEvent.click(await screen.findByTestId('remote-reset-confirm'));
    await waitFor(() => expect(rpcMock.callsOf('remote.resetPairing').length).toBe(1));
    expect(toasts()).toContain('Pairing reset');
  });

  it('hides pairing and devices while LAN mode is off', async () => {
    current = { ...current, remoteLanEnabled: false };
    renderAt(settingsRoutes, '/settings/remote');
    await screen.findByTestId('toggle-remote-lan');
    expect(screen.queryByTestId('remote-pairing')).toBeNull();
    expect(screen.queryByTestId('remote-reset-pairing')).toBeNull();
    expect(rpcMock.callsOf('remote.devices')).toEqual([]);
  });
});
