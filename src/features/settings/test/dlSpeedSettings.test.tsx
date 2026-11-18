/**
 * Faster downloads (SC8, settings): Settings > General > Downloads has the connection cap, the two
 * mirror switches (with the equivalent copies warning), and a connection test switch for each
 * Xtream or Stalker source that shows what the last test learned and can test again.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Settings, SourceConnectionLimit } from '@/api/types';

import { eagerRoutes, installDomStubs, makeSource, renderAt, rpcMock, settings } from '../../sources/test/harness';

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

const settingsRoutes = await eagerRoutes((await import('../routes')).settingsRoutes);

let current: Settings;
let limits: SourceConnectionLimit[];

const lastPatch = () => rpcMock.callsOf('settings.update').at(-1);

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  current = settings();
  limits = [];
  rpcMock.handlers['settings.get'] = () => current;
  rpcMock.handlers['settings.update'] = (a) => {
    current = { ...current, ...(a as { patch: Partial<Settings> }).patch };
    return current;
  };
  rpcMock.handlers['player.capabilities'] = () => ({ embeddedMpv: false, reason: 'not built' });
  rpcMock.handlers['downloads.dir'] = () => ({ path: 'D:/Videos' });
  rpcMock.handlers['sources.list'] = () => [
    makeSource('x1', { kind: 'xtream', name: 'Northwind' }),
    makeSource('s1', { kind: 'stalker', name: 'Harbor' }),
    makeSource('m1', { name: 'Plain list' }),
  ];
  rpcMock.handlers['downloads.connectionLimits'] = () => limits;
  rpcMock.handlers['downloads.resetConnectionLimit'] = () => undefined;
});
afterEach(cleanup);

describe('Settings > General > Downloads: faster downloads', () => {
  it('caps connections per file at Auto or 1 to 8', async () => {
    renderAt(settingsRoutes, '/settings/general');
    const select = (await screen.findByTestId('select-downloadMaxConnections')) as HTMLSelectElement;
    expect(select.value).toBe('0');
    expect([...select.options].map((o) => o.textContent)).toEqual(['Auto', '1', '2', '3', '4', '5', '6', '7', '8']);
    expect(screen.getByText('Max connections per file')).toBeTruthy();
    fireEvent.change(select, { target: { value: '4' } });
    await waitFor(() => expect(lastPatch()).toEqual({ patch: { downloadMaxConnections: 4 } }));
    fireEvent.change(select, { target: { value: '0' } });
    await waitFor(() => expect(lastPatch()).toEqual({ patch: { downloadMaxConnections: 0 } }));
  });

  it('turns equivalent copies on and mirrors off, each with its own patch', async () => {
    renderAt(settingsRoutes, '/settings/general');
    const mirrors = await screen.findByTestId('toggle-downloadUseMirrors');
    const equivalent = screen.getByTestId('toggle-downloadAllowEquivalent');
    // Defaults: mirrors on, equivalent copies off.
    expect(mirrors.getAttribute('aria-checked')).toBe('true');
    expect(equivalent.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(equivalent);
    await waitFor(() => expect(lastPatch()).toEqual({ patch: { downloadAllowEquivalent: true } }));
    fireEvent.click(mirrors);
    await waitFor(() => expect(lastPatch()).toEqual({ patch: { downloadUseMirrors: false } }));
  });

  it('shows equivalent copies off, and why, while other sources are not used', async () => {
    current = settings({ downloadUseMirrors: false, downloadAllowEquivalent: true });
    renderAt(settingsRoutes, '/settings/general');
    const equivalent = (await screen.findByTestId('toggle-downloadAllowEquivalent')) as HTMLButtonElement;
    expect(equivalent.disabled).toBe(true);
    // Unchecked while it does nothing, though the stored choice stays on.
    expect(equivalent.getAttribute('aria-checked')).toBe('false');
    expect(current.downloadAllowEquivalent).toBe(true);
    expect(screen.getByTestId('equivalent-needs-mirrors').textContent).toBe('Needs “Use other sources to speed up downloads” on');
    expect(screen.getByTestId('equivalent-warning').querySelector('svg')!.getAttribute('class')).not.toContain('text-warning');
    expect(screen.getByText(/lets a season or queue spread across your accounts/)).toBeTruthy();

    fireEvent.click(screen.getByTestId('toggle-downloadUseMirrors'));
    await waitFor(() => expect(lastPatch()).toEqual({ patch: { downloadUseMirrors: true } }));
    // No patch touched it: the stored choice comes back with mirrors.
    expect(rpcMock.callsOf('settings.update').some((c) => 'downloadAllowEquivalent' in (c as { patch: object }).patch)).toBe(false);
    await waitFor(() => expect((screen.getByTestId('toggle-downloadAllowEquivalent') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId('toggle-downloadAllowEquivalent').getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByTestId('equivalent-needs-mirrors')).toBeNull();
    expect(screen.getByTestId('equivalent-warning').querySelector('svg')!.getAttribute('class')).toContain('text-warning');
  });

  it('warns that an equivalent copy may be a different file', async () => {
    renderAt(settingsRoutes, '/settings/general');
    const warning = await screen.findByTestId('equivalent-warning');
    expect(warning.textContent).toBe('The file may differ from the one you picked.');
    // Tied to the switch it explains.
    const equivalent = screen.getByTestId('toggle-downloadAllowEquivalent');
    const describedBy = equivalent.getAttribute('aria-describedby') ?? '';
    const description = describedBy.split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(description).toContain('The file may differ from the one you picked.');
  });

  it('lists a connection test switch for each Xtream or Stalker source with what it learned', async () => {
    limits = [
      // The usual result: the panel took 3 and refused the 4th, so the mode is refuse with 3 learned.
      { sourceId: 'x1', reported: 1, learned: 3, mode: 'refuse', probedAt: '2026-11-10T12:00:00Z', probing: false, disabled: false },
      { sourceId: 's1', reported: 2, mode: 'refuse', probedAt: '2026-11-11T12:00:00Z', probing: false, disabled: false },
    ];
    renderAt(settingsRoutes, '/settings/general');
    const northwind = await screen.findByTestId('probe-row-x1');
    expect(screen.queryByTestId('probe-row-m1')).toBeNull();
    await waitFor(() => expect(within(northwind.closest('[data-settings-row]') ?? document.body).queryByText(/Test found 3 allowed/)).toBeTruthy());
    expect(document.body.textContent).toContain('Account reports 1');
    expect(document.body.textContent).toContain('Test found extra connections refused');

    const toggle = within(northwind).getByTestId('toggle-probe-x1');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(() => expect(lastPatch()).toEqual({ patch: { downloadProbeDisabled: ['x1'] } }));

    fireEvent.click(within(screen.getByTestId('probe-row-s1')).getByRole('button', { name: 'Forget result for Harbor' }));
    await waitFor(() => expect(rpcMock.callsOf('downloads.resetConnectionLimit')).toEqual([{ sourceId: 's1' }]));
  });

  it('turns a source test back on and keeps Test again off until something was learned', async () => {
    current = settings({ downloadProbeDisabled: ['x1'] });
    limits = [{ sourceId: 'x1', reported: 1, probing: false, disabled: true }];
    renderAt(settingsRoutes, '/settings/general');
    const row = await screen.findByTestId('probe-row-x1');
    const toggle = within(row).getByTestId('toggle-probe-x1');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect((within(row).getByTestId('probe-reset-x1') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('probe-reset-s1') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(lastPatch()).toEqual({ patch: { downloadProbeDisabled: [] } }));
  });

  it('has no connection test rows without an Xtream or Stalker source', async () => {
    rpcMock.handlers['sources.list'] = () => [makeSource('m1', { name: 'Plain list' })];
    renderAt(settingsRoutes, '/settings/general');
    await screen.findByTestId('toggle-downloadUseMirrors');
    expect(screen.queryByTestId(/^probe-row-/)).toBeNull();
    expect(rpcMock.callsOf('downloads.connectionLimits')).toEqual([]);
  });
});
